import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/core/schemas.js";
import { buildSuiteRunHistory } from "../src/reporters/runComparison.js";
import { renderSuiteDashboard } from "../src/reporters/suiteDashboard.js";

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

describe("renderSuiteDashboard", () => {
  it("renders a run dashboard linking to per-journey dashboards", () => {
    const html = renderSuiteDashboard({
      suiteId: "2026-06-16T18-00-10-000Z-run",
      generatedAt: "2026-06-16T18:00:10.000Z",
      baseDir: "/tmp/runs",
      runs: [{ journeyFile: "/repo/examples/journeys/admin-invite-user.json", result: baseRun }],
    });

    expect(html).toContain("JourneyTest Run");
    expect(html).toContain("admin-invite-user");
    expect(html).toContain("Open dashboard");
    expect(html).toContain("2026-06-16T18-00-00-000Z-admin-invite-user/dashboard.html");
  });

  it("renders previous status, verdict, and comparison classification", () => {
    const previousRun: RunResult = {
      ...baseRun,
      runId: "2026-06-16T17-00-00-000Z-admin-invite-user",
      startedAt: "2026-06-16T17:00:00.000Z",
      endedAt: "2026-06-16T17:00:05.000Z",
      verdict: {
        ...baseRun.verdict!,
        status: "failed",
        summary: "Previous invite failed.",
      },
    };
    const history = buildSuiteRunHistory({
      suiteId: "2026-06-16T18-00-10-000Z-run",
      generatedAt: "2026-06-16T18:00:10.000Z",
      runs: [{ journeyFile: "/repo/examples/journeys/admin-invite-user.json", result: baseRun }],
      compareTo: {
        path: "/tmp/runs/previous-run",
        kind: "suite",
        runs: [previousRun],
      },
    });

    const html = renderSuiteDashboard({
      suiteId: "2026-06-16T18-00-10-000Z-run",
      generatedAt: "2026-06-16T18:00:10.000Z",
      baseDir: "/tmp/runs",
      runs: [{ journeyFile: "/repo/examples/journeys/admin-invite-user.json", result: baseRun }],
      history,
    });

    expect(html).toContain("<th>Current</th><th>Previous</th><th>Change</th>");
    expect(html).toContain("Verdict: <strong>failed</strong>");
    expect(html).toContain("Previous invite failed.");
    expect(html).toContain("Newly passed");
    expect(html).toContain("Failure Clusters");
  });
});
