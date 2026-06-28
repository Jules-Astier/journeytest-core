import { describe, expect, it } from "vitest";
import type {
  AgentVerdict,
  DataLifecycleExecution,
  RunResult,
} from "../src/core/schemas.js";
import {
  renderGitHubAnnotations,
  renderJUnitXml,
  renderSummaryJson,
} from "../src/reporters/ci.js";

const passedVerdict: AgentVerdict = {
  status: "passed",
  confidence: "high",
  summary: "Journey passed.",
  criteria: [
    {
      id: "expected-result",
      result: "met",
      explanation: "The expected result was visible.",
    },
  ],
  blockers: [],
  uxFindings: [],
  suggestedImprovements: [],
};

const failedLifecycle: DataLifecycleExecution = {
  schemaVersion: "0.1",
  scope: "journey",
  environment: "local-convex",
  namespace: "journeytest-test",
  status: "failed",
  startedAt: "2026-06-18T10:00:00.000Z",
  endedAt: "2026-06-18T10:00:02.000Z",
  durationMs: 2000,
  artifacts: {},
  setup: [],
  preflight: [],
  postconditions: [
    {
      id: "submitted",
      phase: "postconditions",
      environment: "local-convex",
      provider: "convex",
      kind: "query",
      function: "testLifecycle:assertSubmitted",
      status: "failed",
      startedAt: "2026-06-18T10:00:01.000Z",
      endedAt: "2026-06-18T10:00:02.000Z",
      durationMs: 1000,
      error: {
        message: "Submission was not stored.",
      },
    },
  ],
  cleanup: [],
};

describe("CI reporters", () => {
  it("renders JUnit XML with distinct failed, blocked, inconclusive, and error cases", () => {
    const xml = renderJUnitXml({
      suiteName: "journey-suite",
      generatedAt: "2026-06-18T10:00:00.000Z",
      runs: [
        { journeyFile: "/repo/journeys/passed.json", result: makeRun("passed-journey") },
        {
          journeyFile: "/repo/journeys/failed.json",
          result: makeRun("failed-journey", {
            verdict: {
              ...passedVerdict,
              status: "failed",
              summary: "Checkout failed & needs review",
              criteria: [
                {
                  id: "checkout-complete",
                  result: "not-met",
                  explanation: "The confirmation did not appear.",
                },
              ],
            },
          }),
        },
        {
          journeyFile: "/repo/journeys/blocked.json",
          result: makeRun("blocked-journey", {
            runStatus: "blocked",
            verdict: undefined,
            error: { message: "Auth blocked & MFA required" },
          }),
        },
        {
          journeyFile: "/repo/journeys/inconclusive.json",
          result: makeRun("inconclusive-journey", {
            verdict: {
              ...passedVerdict,
              status: "inconclusive",
              summary: "Could not prove the outcome.",
            },
          }),
        },
        {
          journeyFile: "/repo/journeys/error.json",
          result: makeRun("error-journey", {
            runStatus: "error",
            verdict: undefined,
            error: { message: "Browser crashed & burned" },
          }),
        },
      ],
    });

    expect(xml).toContain('<testsuite name="journey-suite" tests="5" failures="1" errors="1" skipped="2"');
    expect(xml).toContain('name="failed-journey"');
    expect(xml).toContain('status="failed"');
    expect(xml).toContain('<failure type="failed" message="Checkout failed &amp; needs review">');
    expect(xml).toContain('status="blocked"');
    expect(xml).toContain('<skipped message="blocked: Auth blocked &amp; MFA required">');
    expect(xml).toContain('status="inconclusive"');
    expect(xml).toContain('<skipped message="inconclusive: Could not prove the outcome.">');
    expect(xml).toContain('status="error"');
    expect(xml).toContain('<error type="error" message="Browser crashed &amp; burned">');
  });

  it("renders compact summary JSON with status counts and artifact pointers", () => {
    const summary = JSON.parse(
      renderSummaryJson({
        generatedAt: "2026-06-18T10:00:00.000Z",
        runs: [
          { journeyFile: "/repo/journeys/passed.json", result: makeRun("passed-journey") },
          {
            journeyFile: "/repo/journeys/lifecycle.json",
            result: makeRun("lifecycle-journey", {
              dataLifecycle: failedLifecycle,
            }),
          },
          {
            journeyFile: "/repo/journeys/blocked.json",
            result: makeRun("blocked-journey", {
              runStatus: "blocked",
              verdict: undefined,
              error: { message: "Fixture preflight failed." },
            }),
          },
          {
            journeyFile: "/repo/journeys/inconclusive.json",
            result: makeRun("inconclusive-journey", {
              verdict: {
                ...passedVerdict,
                status: "inconclusive",
                summary: "Could not prove the outcome.",
              },
            }),
          },
          {
            journeyFile: "/repo/journeys/error.json",
            result: makeRun("error-journey", {
              runStatus: "error",
              verdict: undefined,
              error: { message: "Driver exited." },
            }),
          },
        ],
      }),
    );

    expect(summary).toMatchObject({
      schemaVersion: "0.1",
      generatedAt: "2026-06-18T10:00:00.000Z",
      total: 5,
      counts: {
        passed: 1,
        failed: 1,
        blocked: 1,
        inconclusive: 1,
        error: 1,
        cancelled: 0,
      },
    });
    expect(summary.runs[1]).toMatchObject({
      journeyId: "lifecycle-journey",
      status: "failed",
      dataLifecycleStatus: "failed",
      message: "Data lifecycle failed: postconditions/submitted testLifecycle:assertSubmitted failed: Submission was not stored.",
      artifacts: {
        dashboard: "/tmp/journeytest/lifecycle-journey/dashboard.html",
        report: "/tmp/journeytest/lifecycle-journey/report.md",
      },
    });
    expect(summary.runs[1].details).toBeUndefined();
  });

  it("formats GitHub workflow-command annotations with escaped properties and messages", () => {
    const annotations = renderGitHubAnnotations([
      {
        journeyFile: "/repo/journeys/admin:invite,user.json",
        result: makeRun("failed-journey", {
          verdict: {
            ...passedVerdict,
            status: "failed",
            summary: "Line one\nLine two 100% failed",
          },
        }),
      },
      {
        journeyFile: "/repo/journeys/inconclusive.json",
        result: makeRun("inconclusive-journey", {
          verdict: {
            ...passedVerdict,
            status: "inconclusive",
            summary: "Outcome needs review.",
          },
        }),
      },
      {
        journeyFile: "/repo/journeys/passed.json",
        result: makeRun("passed-journey"),
      },
    ]);

    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toContain("::error ");
    expect(annotations[0]).toContain("file=/repo/journeys/admin%3Ainvite%2Cuser.json");
    expect(annotations[0]).toContain("title=JourneyTest failed%3A failed-journey");
    expect(annotations[0]).toContain("FAILED: Line one%0ALine two 100%25 failed");
    expect(annotations[0]).toContain("Dashboard: /tmp/journeytest/failed-journey/dashboard.html");
    expect(annotations[1]).toContain("::warning ");
    expect(annotations[1]).toContain("title=JourneyTest inconclusive%3A inconclusive-journey");
  });
});

function makeRun(journeyId: string, overrides: Partial<RunResult> = {}): RunResult {
  const runDir = `/tmp/journeytest/${journeyId}`;
  const result: RunResult = {
    schemaVersion: "0.1",
    runId: `2026-06-18T10-00-00-000Z-${journeyId}`,
    journeyId,
    testerProfileId: "admin",
    runStatus: "completed",
    startedAt: "2026-06-18T10:00:00.000Z",
    endedAt: "2026-06-18T10:00:05.000Z",
    durationMs: 5000,
    model: { provider: "test", name: "scripted" },
    verdict: passedVerdict,
    artifacts: {
      runDir,
      events: `${runDir}/events.ndjson`,
      dashboard: `${runDir}/dashboard.html`,
      report: `${runDir}/report.md`,
      result: `${runDir}/run.json`,
      screenshots: [],
      snapshots: [],
    },
    timeline: [],
  };

  return {
    ...result,
    ...overrides,
    artifacts: {
      ...result.artifacts,
      ...overrides.artifacts,
    },
  };
}
