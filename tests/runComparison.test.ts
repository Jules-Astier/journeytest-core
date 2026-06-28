import { describe, expect, it } from "vitest";
import {
  buildFailureClusters,
  buildSuiteRunHistory,
  compareRunSnapshots,
  type RunSnapshot,
} from "../src/reporters/runComparison.js";
import type { RunResult } from "../src/core/schemas.js";

const baseSnapshot: RunSnapshot = {
  journeyId: "admin-invite-user",
  runId: "current",
  runStatus: "completed",
  verdictStatus: "passed",
  dataLifecycleStatus: "none",
  startedAt: "2026-06-16T18:00:00.000Z",
  endedAt: "2026-06-16T18:00:05.000Z",
  durationMs: 5000,
};

const baseRun: RunResult = {
  schemaVersion: "0.1",
  runId: "2026-06-16T18-00-00-000Z-admin-invite-user",
  journeyId: "admin-invite-user",
  testerProfileId: "admin",
  runStatus: "completed",
  startedAt: "2026-06-16T18:00:00.000Z",
  endedAt: "2026-06-16T18:00:05.000Z",
  durationMs: 5000,
  model: { provider: "test", name: "scripted" },
  verdict: {
    status: "passed",
    confidence: "high",
    summary: "Invite flow passed.",
    criteria: [
      {
        id: "invite-confirmed",
        result: "met",
        explanation: "Confirmation was visible.",
      },
    ],
    blockers: [],
    uxFindings: [],
    suggestedImprovements: [],
  },
  artifacts: {
    runDir: "/tmp/runs/2026-06-16T18-00-00-000Z-admin-invite-user",
    events: "/tmp/runs/2026-06-16T18-00-00-000Z-admin-invite-user/events.ndjson",
    dashboard: "/tmp/runs/2026-06-16T18-00-00-000Z-admin-invite-user/dashboard.html",
    report: "/tmp/runs/2026-06-16T18-00-00-000Z-admin-invite-user/report.md",
    result: "/tmp/runs/2026-06-16T18-00-00-000Z-admin-invite-user/run.json",
    screenshots: [],
    snapshots: [],
  },
  timeline: [],
};

function snapshot(overrides: Partial<RunSnapshot>): RunSnapshot {
  return { ...baseSnapshot, ...overrides };
}

function run(overrides: Partial<RunResult>): RunResult {
  return {
    ...baseRun,
    ...overrides,
    verdict: overrides.verdict === undefined ? baseRun.verdict : overrides.verdict,
    artifacts: {
      ...baseRun.artifacts,
      ...(overrides.artifacts ?? {}),
    },
    timeline: overrides.timeline ?? baseRun.timeline,
  };
}

describe("run comparison classification", () => {
  it("classifies newly failed journeys", () => {
    const comparison = compareRunSnapshots(
      snapshot({ verdictStatus: "failed" }),
      snapshot({ runId: "previous", verdictStatus: "passed" }),
    );

    expect(comparison.classification).toBe("newly-failed");
  });

  it("classifies newly passed journeys", () => {
    const comparison = compareRunSnapshots(
      snapshot({ verdictStatus: "passed" }),
      snapshot({ runId: "previous", verdictStatus: "failed" }),
    );

    expect(comparison.classification).toBe("newly-passed");
  });

  it("classifies unchanged failures as still failing", () => {
    const comparison = compareRunSnapshots(
      snapshot({ verdictStatus: "failed" }),
      snapshot({ runId: "previous", verdictStatus: "failed" }),
    );

    expect(comparison.classification).toBe("still-failing");
  });

  it("classifies failing status changes as flaky or changed", () => {
    const comparison = compareRunSnapshots(
      snapshot({ verdictStatus: "blocked" }),
      snapshot({ runId: "previous", verdictStatus: "failed" }),
    );

    expect(comparison.classification).toBe("flaky-changed");
  });

  it("marks journeys with no baseline as new", () => {
    const comparison = compareRunSnapshots(snapshot({ verdictStatus: "passed" }));

    expect(comparison.classification).toBe("new");
  });

  it("summarizes history and clusters current failures", () => {
    const currentFailed = run({
      verdict: {
        ...baseRun.verdict!,
        status: "failed",
        summary: "Invite flow failed.",
      },
    });
    const history = buildSuiteRunHistory({
      suiteId: "suite",
      generatedAt: "2026-06-16T18:01:00.000Z",
      runs: [{ journeyFile: "/repo/admin.json", result: currentFailed }],
      compareTo: {
        path: "/tmp/previous",
        kind: "suite",
        runs: [baseRun],
      },
    });

    expect(history.summary.comparison?.newlyFailed).toBe(1);
    expect(buildFailureClusters([currentFailed])).toEqual([
      {
        key: "verdict:failed",
        label: "Verdict failed",
        count: 1,
        journeyIds: ["admin-invite-user"],
      },
    ]);
  });
});
