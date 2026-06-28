import type { AgentVerdict, DataLifecycleExecution, RunResult } from "../core/schemas.js";

export type VerdictStatus = AgentVerdict["status"] | "none";
export type DataLifecycleStatus = DataLifecycleExecution["status"] | "none";
export type RunHealth = "passed" | "failing";

export type RunComparisonClassification =
  | "new"
  | "newly-failed"
  | "newly-passed"
  | "still-failing"
  | "flaky-changed"
  | "unchanged-passed";

export interface SuiteHistoryRunInput {
  journeyFile: string;
  result: RunResult;
}

export interface RunSnapshot {
  journeyId: string;
  runId: string;
  runStatus: RunResult["runStatus"];
  verdictStatus: VerdictStatus;
  dataLifecycleStatus: DataLifecycleStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  summary?: string;
  dashboard?: string;
  result?: string;
}

export interface RunComparison {
  classification: RunComparisonClassification;
  label: string;
  currentHealth: RunHealth;
  previousHealth?: RunHealth;
  statusChanged: boolean;
  verdictChanged: boolean;
  dataLifecycleChanged: boolean;
}

export interface SuiteHistoryRun extends RunSnapshot {
  journeyFile: string;
  previous?: RunSnapshot;
  comparison?: RunComparison;
}

export interface SuiteFailureCluster {
  key: string;
  label: string;
  count: number;
  journeyIds: string[];
}

export interface SuiteSelectionSummary {
  collected: number;
  selected: number;
  tags?: string[];
  excludeTags?: string[];
  journeyIds?: string[];
  excludeJourneyIds?: string[];
  rerunFailed?: {
    path: string;
    unhealthyJourneyIds: string[];
  };
  shard?: {
    index: number;
    total: number;
  };
}

export interface SuiteHistorySummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  inconclusive: number;
  errors: number;
  comparison?: {
    baselineRuns: number;
    compared: number;
    new: number;
    newlyFailed: number;
    newlyPassed: number;
    stillFailing: number;
    flakyChanged: number;
    unchangedPassed: number;
  };
}

export interface SuiteRunHistory {
  schemaVersion: "0.1";
  suiteId: string;
  generatedAt: string;
  compareTo?: {
    path: string;
    kind: "run" | "suite";
    runCount: number;
  };
  summary: SuiteHistorySummary;
  selection?: SuiteSelectionSummary;
  runs: SuiteHistoryRun[];
  failureClusters: SuiteFailureCluster[];
}

export interface BuildSuiteRunHistoryOptions {
  suiteId: string;
  generatedAt: string;
  runs: SuiteHistoryRunInput[];
  compareTo?: {
    path: string;
    kind: "run" | "suite";
    runs: RunResult[];
  };
  selection?: SuiteSelectionSummary;
}

export function buildSuiteRunHistory(options: BuildSuiteRunHistoryOptions): SuiteRunHistory {
  const previousByJourneyId = options.compareTo
    ? mapLatestRunsByJourneyId(options.compareTo.runs)
    : undefined;

  const runs = options.runs.map((run) => {
    const snapshot = snapshotRun(run.result);
    const previous = previousByJourneyId?.get(run.result.journeyId);
    return {
      ...snapshot,
      journeyFile: run.journeyFile,
      ...(previous ? { previous } : {}),
      ...(previousByJourneyId
        ? { comparison: compareRunSnapshots(snapshot, previous) }
        : {}),
    };
  });

  const comparisonCounts = countComparisons(runs);
  return {
    schemaVersion: "0.1",
    suiteId: options.suiteId,
    generatedAt: options.generatedAt,
    ...(options.compareTo
      ? {
          compareTo: {
            path: options.compareTo.path,
            kind: options.compareTo.kind,
            runCount: options.compareTo.runs.length,
          },
        }
      : {}),
    summary: {
      total: options.runs.length,
      passed: options.runs.filter((run) => run.result.verdict?.status === "passed").length,
      failed: options.runs.filter((run) => run.result.verdict?.status === "failed").length,
      blocked: options.runs.filter((run) => run.result.verdict?.status === "blocked").length,
      inconclusive: options.runs.filter((run) => run.result.verdict?.status === "inconclusive").length,
      errors: options.runs.filter((run) => run.result.runStatus !== "completed").length,
      ...(comparisonCounts ? { comparison: comparisonCounts } : {}),
    },
    ...(options.selection ? { selection: options.selection } : {}),
    runs,
    failureClusters: buildFailureClusters(options.runs.map((run) => run.result)),
  };
}

export function snapshotRun(result: RunResult): RunSnapshot {
  return {
    journeyId: result.journeyId,
    runId: result.runId,
    runStatus: result.runStatus,
    verdictStatus: result.verdict?.status ?? "none",
    dataLifecycleStatus: result.dataLifecycle?.status ?? "none",
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    ...(result.verdict?.summary || result.error?.message
      ? { summary: result.verdict?.summary ?? result.error?.message }
      : {}),
    dashboard: result.artifacts.dashboard,
    result: result.artifacts.result,
  };
}

export function compareRunSnapshots(
  current: RunSnapshot,
  previous?: RunSnapshot,
): RunComparison {
  const currentHealth = runHealth(current);
  if (!previous) {
    return {
      classification: "new",
      label: "New",
      currentHealth,
      statusChanged: false,
      verdictChanged: false,
      dataLifecycleChanged: false,
    };
  }

  const previousHealth = runHealth(previous);
  const statusChanged = current.runStatus !== previous.runStatus;
  const verdictChanged = current.verdictStatus !== previous.verdictStatus;
  const dataLifecycleChanged = current.dataLifecycleStatus !== previous.dataLifecycleStatus;
  const changed = statusChanged || verdictChanged || dataLifecycleChanged;

  if (previousHealth === "passed" && currentHealth === "failing") {
    return {
      classification: "newly-failed",
      label: "Newly failed",
      currentHealth,
      previousHealth,
      statusChanged,
      verdictChanged,
      dataLifecycleChanged,
    };
  }

  if (previousHealth === "failing" && currentHealth === "passed") {
    return {
      classification: "newly-passed",
      label: "Newly passed",
      currentHealth,
      previousHealth,
      statusChanged,
      verdictChanged,
      dataLifecycleChanged,
    };
  }

  if (currentHealth === "failing" && previousHealth === "failing") {
    return {
      classification: changed ? "flaky-changed" : "still-failing",
      label: changed ? "Flaky / changed" : "Still failing",
      currentHealth,
      previousHealth,
      statusChanged,
      verdictChanged,
      dataLifecycleChanged,
    };
  }

  return {
    classification: changed ? "flaky-changed" : "unchanged-passed",
    label: changed ? "Flaky / changed" : "Unchanged passed",
    currentHealth,
    previousHealth,
    statusChanged,
    verdictChanged,
    dataLifecycleChanged,
  };
}

export function runHealth(snapshot: RunSnapshot): RunHealth {
  if (snapshot.runStatus !== "completed") {
    return "failing";
  }

  if (snapshot.dataLifecycleStatus === "failed" || snapshot.dataLifecycleStatus === "blocked") {
    return "failing";
  }

  return snapshot.verdictStatus === "passed" ? "passed" : "failing";
}

export function buildFailureClusters(results: RunResult[]): SuiteFailureCluster[] {
  const clusters = new Map<string, SuiteFailureCluster>();
  for (const result of results) {
    const snapshot = snapshotRun(result);
    if (runHealth(snapshot) === "passed") {
      continue;
    }

    const key = failureClusterKey(snapshot);
    const existing = clusters.get(key);
    if (existing) {
      existing.count++;
      existing.journeyIds.push(result.journeyId);
    } else {
      clusters.set(key, {
        key,
        label: failureClusterLabel(snapshot),
        count: 1,
        journeyIds: [result.journeyId],
      });
    }
  }

  return [...clusters.values()].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }
    return left.label.localeCompare(right.label);
  });
}

function mapLatestRunsByJourneyId(results: RunResult[]): Map<string, RunSnapshot> {
  const byJourneyId = new Map<string, RunSnapshot>();
  for (const result of results) {
    const snapshot = snapshotRun(result);
    const existing = byJourneyId.get(result.journeyId);
    if (!existing || timestampForOrdering(snapshot) > timestampForOrdering(existing)) {
      byJourneyId.set(result.journeyId, snapshot);
    }
  }
  return byJourneyId;
}

function timestampForOrdering(snapshot: RunSnapshot): number {
  const endedAt = Date.parse(snapshot.endedAt);
  if (Number.isFinite(endedAt)) {
    return endedAt;
  }
  const startedAt = Date.parse(snapshot.startedAt);
  return Number.isFinite(startedAt) ? startedAt : 0;
}

function countComparisons(runs: SuiteHistoryRun[]): SuiteHistorySummary["comparison"] | undefined {
  const comparedRuns = runs.filter((run) => run.comparison);
  if (comparedRuns.length === 0) {
    return undefined;
  }

  return {
    baselineRuns: runs.filter((run) => run.previous).length,
    compared: comparedRuns.length,
    new: comparedRuns.filter((run) => run.comparison?.classification === "new").length,
    newlyFailed: comparedRuns.filter((run) => run.comparison?.classification === "newly-failed").length,
    newlyPassed: comparedRuns.filter((run) => run.comparison?.classification === "newly-passed").length,
    stillFailing: comparedRuns.filter((run) => run.comparison?.classification === "still-failing").length,
    flakyChanged: comparedRuns.filter((run) => run.comparison?.classification === "flaky-changed").length,
    unchangedPassed: comparedRuns.filter((run) => run.comparison?.classification === "unchanged-passed").length,
  };
}

function failureClusterKey(snapshot: RunSnapshot): string {
  if (snapshot.runStatus !== "completed") {
    return `run:${snapshot.runStatus}`;
  }
  if (snapshot.dataLifecycleStatus === "failed" || snapshot.dataLifecycleStatus === "blocked") {
    return `data-lifecycle:${snapshot.dataLifecycleStatus}`;
  }
  return `verdict:${snapshot.verdictStatus}`;
}

function failureClusterLabel(snapshot: RunSnapshot): string {
  if (snapshot.runStatus !== "completed") {
    return `Run ${snapshot.runStatus}`;
  }
  if (snapshot.dataLifecycleStatus === "failed" || snapshot.dataLifecycleStatus === "blocked") {
    return `Data lifecycle ${snapshot.dataLifecycleStatus}`;
  }
  return `Verdict ${snapshot.verdictStatus}`;
}
