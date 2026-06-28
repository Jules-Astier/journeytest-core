import { relative, sep } from "node:path";
import type { RunResult } from "../core/schemas.js";
import type {
  RunComparisonClassification,
  RunSnapshot,
  SuiteSelectionSummary,
  SuiteHistoryRun,
  SuiteRunHistory,
  VerdictStatus,
} from "./runComparison.js";

export interface SuiteDashboardRun {
  journeyFile: string;
  result: RunResult;
}

export interface RenderSuiteDashboardOptions {
  suiteId: string;
  generatedAt: string;
  baseDir: string;
  runs: SuiteDashboardRun[];
  history?: SuiteRunHistory;
  selection?: SuiteSelectionSummary;
}

export function renderSuiteDashboard(options: RenderSuiteDashboardOptions): string {
  const passed = options.runs.filter((run) => run.result.verdict?.status === "passed").length;
  const failed = options.runs.filter((run) => run.result.verdict?.status === "failed").length;
  const blocked = options.runs.filter((run) => run.result.verdict?.status === "blocked").length;
  const inconclusive = options.runs.filter((run) => run.result.verdict?.status === "inconclusive").length;
  const errored = options.runs.filter((run) => run.result.runStatus !== "completed").length;
  const historyByJourneyId = new Map(
    options.history?.runs.map((run) => [run.journeyId, run]) ?? [],
  );
  const showComparison = Boolean(options.history?.compareTo);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JourneyTest Run ${escapeHtml(options.suiteId)}</title>
  <style>
    :root {
      --darkroom: #111412;
      --darkroom-2: #161a18;
      --darkroom-3: #1d221f;
      --line: rgba(210, 224, 213, 0.14);
      --line-soft: rgba(210, 224, 213, 0.08);
      --paper: #eef3ea;
      --paper-dim: #a9b5ac;
      --paper-mute: #6f7b73;
      --green: #7ee2a8;
      --red: #ff807a;
      --amber: #f2c66f;
      --blue: #91b7ff;
      color-scheme: dark;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--darkroom);
      color: var(--paper);
      font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }

    main {
      width: min(1180px, calc(100vw - 48px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }

    header {
      border-bottom: 1px solid var(--line-soft);
      padding-bottom: 24px;
      margin-bottom: 24px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: end;
    }

    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 48px);
      line-height: 1.02;
      letter-spacing: 0;
    }

    .subtitle {
      margin-top: 8px;
      color: var(--paper-dim);
    }

    .scoreboard {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      color: var(--paper-dim);
      font-size: 12px;
      white-space: nowrap;
      background: rgba(255, 255, 255, 0.02);
    }

    .pill strong { color: var(--paper); }
    .pass { color: var(--green); border-color: rgba(126, 226, 168, 0.34); }
    .fail { color: var(--red); border-color: rgba(255, 128, 122, 0.34); }
    .block { color: var(--amber); border-color: rgba(242, 198, 111, 0.34); }
    .note { color: var(--blue); border-color: rgba(145, 183, 255, 0.34); }

    .history-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.02);
      margin-bottom: 16px;
      padding: 14px 16px;
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.8fr);
      gap: 16px;
    }

    .selection-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.02);
      margin-bottom: 16px;
      padding: 14px 16px;
    }

    .history-panel h2 {
      margin: 0 0 8px;
      font-size: 13px;
      text-transform: uppercase;
      color: var(--paper-mute);
      letter-spacing: 0;
    }

    .history-pills,
    .cluster-list,
    .status-stack {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: flex-start;
    }

    .cluster-list {
      margin: 0;
      padding: 0;
      list-style: none;
      color: var(--paper-dim);
    }

    .cluster-list li {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .cluster-list strong { color: var(--paper); }

    .muted {
      color: var(--paper-mute);
      font-size: 12px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: linear-gradient(180deg, var(--darkroom-2), var(--darkroom-3));
    }

    th,
    td {
      padding: 12px;
      border-bottom: 1px solid var(--line-soft);
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--paper-mute);
      font-size: 12px;
      text-transform: uppercase;
    }

    tr:last-child td { border-bottom: none; }

    tbody tr.change-newly-failed td:first-child,
    tbody tr.change-still-failing td:first-child {
      box-shadow: inset 4px 0 0 var(--red);
    }

    tbody tr.change-newly-passed td:first-child {
      box-shadow: inset 4px 0 0 var(--green);
    }

    tbody tr.change-flaky-changed td:first-child {
      box-shadow: inset 4px 0 0 var(--blue);
    }

    a {
      color: var(--blue);
      text-decoration: none;
      font-weight: 700;
    }

    a:hover { text-decoration: underline; }

    .mono {
      font-family: "SF Mono", "Menlo", monospace;
      font-size: 12px;
      color: var(--paper-mute);
      overflow-wrap: anywhere;
    }

    .summary {
      max-width: 440px;
      color: var(--paper-dim);
    }

    .previous-summary {
      flex-basis: 100%;
      color: var(--paper-mute);
      font-size: 12px;
      max-width: 280px;
    }

    @media (max-width: 760px) {
      main { width: min(100vw - 24px, 1180px); }
      header { grid-template-columns: 1fr; }
      .scoreboard { justify-content: flex-start; }
      .history-panel { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
      th, td { min-width: 140px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>JourneyTest Run</h1>
        <div class="subtitle">${escapeHtml(options.suiteId)} · generated ${escapeHtml(options.generatedAt)}</div>
      </div>
      <div class="scoreboard">
        ${renderPill("Total", String(options.runs.length), "")}
        ${renderPill("Passed", String(passed), "pass")}
        ${renderPill("Failed", String(failed), "fail")}
        ${renderPill("Blocked", String(blocked), "block")}
        ${renderPill("Inconclusive", String(inconclusive), "block")}
        ${renderPill("Errors", String(errored), errored > 0 ? "fail" : "")}
      </div>
    </header>

    ${renderHistoryPanel(options.history)}
    ${renderSelectionPanel(options.selection ?? options.history?.selection)}

    <table>
      <thead>
        <tr>
          <th>Journey</th>
          ${
            showComparison
              ? "<th>Current</th><th>Previous</th><th>Change</th>"
              : "<th>Status</th><th>Verdict</th>"
          }
          <th>Summary</th>
          <th>Dashboard</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        ${options.runs
          .map((run) =>
            renderRunRow(run, options.baseDir, historyByJourneyId.get(run.result.journeyId), showComparison),
          )
          .join("")}
      </tbody>
    </table>
  </main>
</body>
</html>`;
}

function renderRunRow(
  run: SuiteDashboardRun,
  baseDir: string,
  historyRun: SuiteHistoryRun | undefined,
  showComparison: boolean,
): string {
  const verdict = run.result.verdict?.status ?? "none";
  const tone = verdict === "passed" ? "pass" : verdict === "failed" ? "fail" : verdict === "none" ? "" : "block";
  const dashboard = toRelativePath(baseDir, run.result.artifacts.dashboard);
  const comparisonClass = historyRun?.comparison
    ? ` class="change-${historyRun.comparison.classification}"`
    : "";

  return `<tr${comparisonClass}>
    <td>
      <a href="${toHref(dashboard)}">${escapeHtml(run.result.journeyId)}</a>
      <div class="mono">${escapeHtml(run.result.runId)}</div>
    </td>
    ${
      showComparison
        ? `${renderCurrentCell(run.result)}${renderPreviousCell(historyRun?.previous)}${renderComparisonCell(historyRun)}`
        : `<td>${renderPill("Run", run.result.runStatus, run.result.runStatus === "completed" ? "pass" : "fail")}</td>
    <td>${renderPill("Verdict", verdict, tone)}</td>`
    }
    <td class="summary">${escapeHtml(run.result.verdict?.summary ?? run.result.error?.message ?? "")}</td>
    <td><a href="${toHref(dashboard)}">Open dashboard</a></td>
    <td class="mono">${escapeHtml(run.journeyFile)}</td>
  </tr>`;
}

function renderHistoryPanel(history: SuiteRunHistory | undefined): string {
  if (!history?.compareTo || !history.summary.comparison) {
    return "";
  }

  const comparison = history.summary.comparison;
  return `<section class="history-panel" aria-label="Run history comparison">
      <div>
        <h2>Comparison</h2>
        <div class="history-pills">
          ${renderPill("Baseline", history.compareTo.kind, "note")}
          ${renderPill("Compared", String(comparison.compared), "")}
          ${renderPill("New", String(comparison.new), comparison.new > 0 ? "block" : "")}
          ${renderPill("Newly failed", String(comparison.newlyFailed), comparison.newlyFailed > 0 ? "fail" : "")}
          ${renderPill("Newly passed", String(comparison.newlyPassed), comparison.newlyPassed > 0 ? "pass" : "")}
          ${renderPill("Still failing", String(comparison.stillFailing), comparison.stillFailing > 0 ? "fail" : "")}
          ${renderPill("Flaky / changed", String(comparison.flakyChanged), comparison.flakyChanged > 0 ? "note" : "")}
        </div>
      </div>
      <div>
        <h2>Failure Clusters</h2>
        ${renderFailureClusters(history.failureClusters)}
      </div>
    </section>`;
}

function renderSelectionPanel(selection: SuiteSelectionSummary | undefined): string {
  if (!selection || !hasActiveSelection(selection)) {
    return "";
  }

  return `<section class="selection-panel" aria-label="Suite selection">
      <h2>Selection</h2>
      <div class="history-pills">
        ${renderPill("Collected", String(selection.collected), "")}
        ${renderPill("Selected", String(selection.selected), "note")}
        ${selection.tags?.length ? renderPill("Tags", selection.tags.join(", "), "") : ""}
        ${selection.excludeTags?.length ? renderPill("Exclude tags", selection.excludeTags.join(", "), "block") : ""}
        ${selection.journeyIds?.length ? renderPill("Journey ids", selection.journeyIds.join(", "), "") : ""}
        ${selection.excludeJourneyIds?.length ? renderPill("Exclude ids", selection.excludeJourneyIds.join(", "), "block") : ""}
        ${selection.rerunFailed ? renderPill("Rerun failed", selection.rerunFailed.unhealthyJourneyIds.join(", "), "fail") : ""}
        ${selection.shard ? renderPill("Shard", `${selection.shard.index}/${selection.shard.total}`, "note") : ""}
      </div>
      ${selection.rerunFailed ? `<div class="muted">Rerun source: ${escapeHtml(selection.rerunFailed.path)}</div>` : ""}
    </section>`;
}

function hasActiveSelection(selection: SuiteSelectionSummary): boolean {
  return (
    selection.collected !== selection.selected ||
    Boolean(selection.tags?.length) ||
    Boolean(selection.excludeTags?.length) ||
    Boolean(selection.journeyIds?.length) ||
    Boolean(selection.excludeJourneyIds?.length) ||
    Boolean(selection.rerunFailed) ||
    Boolean(selection.shard)
  );
}

function renderFailureClusters(clusters: SuiteRunHistory["failureClusters"]): string {
  if (clusters.length === 0) {
    return `<span class="muted">No current failure clusters</span>`;
  }

  return `<ul class="cluster-list">
    ${clusters
      .map(
        (cluster) =>
          `<li><strong>${escapeHtml(cluster.label)}</strong>: ${escapeHtml(String(cluster.count))} · ${escapeHtml(cluster.journeyIds.join(", "))}</li>`,
      )
      .join("")}
  </ul>`;
}

function renderCurrentCell(result: RunResult): string {
  const verdict = result.verdict?.status ?? "none";
  return `<td class="status-stack">
    ${renderPill("Run", result.runStatus, result.runStatus === "completed" ? "pass" : "fail")}
    ${renderPill("Verdict", verdict, verdictTone(verdict))}
    ${result.dataLifecycle ? renderPill("Data", result.dataLifecycle.status, dataLifecycleTone(result.dataLifecycle.status)) : ""}
  </td>`;
}

function renderPreviousCell(previous: RunSnapshot | undefined): string {
  if (!previous) {
    return `<td><span class="muted">No baseline</span></td>`;
  }

  return `<td class="status-stack">
    ${renderPill("Run", previous.runStatus, previous.runStatus === "completed" ? "pass" : "fail")}
    ${renderPill("Verdict", previous.verdictStatus, verdictTone(previous.verdictStatus))}
    ${previous.dataLifecycleStatus !== "none" ? renderPill("Data", previous.dataLifecycleStatus, dataLifecycleTone(previous.dataLifecycleStatus)) : ""}
    ${previous.summary ? `<div class="previous-summary">${escapeHtml(previous.summary)}</div>` : ""}
  </td>`;
}

function renderComparisonCell(historyRun: SuiteHistoryRun | undefined): string {
  if (!historyRun?.comparison) {
    return `<td><span class="muted">Not compared</span></td>`;
  }

  return `<td>${renderPill("Change", historyRun.comparison.label, classificationTone(historyRun.comparison.classification))}</td>`;
}

function renderPill(label: string, value: string, tone: string): string {
  return `<span class="pill ${tone}">${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></span>`;
}

function verdictTone(verdict: VerdictStatus): string {
  if (verdict === "passed") {
    return "pass";
  }
  if (verdict === "failed") {
    return "fail";
  }
  if (verdict === "blocked" || verdict === "inconclusive") {
    return "block";
  }
  return "";
}

function dataLifecycleTone(status: string): string {
  if (status === "passed" || status === "skipped") {
    return "pass";
  }
  if (status === "failed" || status === "blocked") {
    return "fail";
  }
  return "";
}

function classificationTone(classification: RunComparisonClassification): string {
  if (classification === "newly-passed" || classification === "unchanged-passed") {
    return "pass";
  }
  if (classification === "newly-failed" || classification === "still-failing") {
    return "fail";
  }
  if (classification === "flaky-changed") {
    return "note";
  }
  return "block";
}

function toRelativePath(baseDir: string, target: string): string {
  const rel = relative(baseDir, target) || ".";
  return rel.split(sep).join("/");
}

function toHref(path: string): string {
  return path
    .split("/")
    .map((part) => (part === "." || part === ".." ? part : encodeURIComponent(part)))
    .join("/");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
