import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/core/schemas.js";
import { renderHtmlDashboard } from "../src/reporters/dashboard.js";

describe("renderHtmlDashboard", () => {
  it("renders UI change timelines as step evidence cards", () => {
    const runDir = "/tmp/journeytest/run";
    const result: RunResult = {
      schemaVersion: "0.1",
      runId: "2026-06-19T12-00-00-000Z-ui-change",
      journeyId: "ui-change",
      testerProfileId: "admin",
      runStatus: "completed",
      startedAt: "2026-06-19T12:00:00.000Z",
      endedAt: "2026-06-19T12:00:01.000Z",
      durationMs: 1000,
      verdict: {
        status: "passed",
        confidence: "high",
        summary: "Saved.",
        criteria: [
          {
            id: "saved",
            result: "met",
            explanation: "Save confirmation appeared.",
            evidence: {
              uiChangeTimeline: "ui-changes/001-click-save.json",
            },
          },
        ],
        blockers: [],
        uxFindings: [],
        suggestedImprovements: [],
      },
      artifacts: {
        runDir,
        events: `${runDir}/events.ndjson`,
        dashboard: `${runDir}/dashboard.html`,
        report: `${runDir}/report.md`,
        result: `${runDir}/run.json`,
        screenshots: [`${runDir}/screenshots/001-click-save-change-001.png`],
        snapshots: [],
        console: [],
        network: [],
        uiChanges: [`${runDir}/ui-changes/001-click-save.json`],
      },
      timeline: [],
    };

    const html = renderHtmlDashboard(result, {
      baseDir: runDir,
      uiChanges: [
        {
          path: `${runDir}/ui-changes/001-click-save.json`,
          content: JSON.stringify({
            action: { kind: "click", target: "#save" },
            changeCount: 1,
            significantChangeCount: 1,
            screenshots: {
              changes: [`${runDir}/screenshots/001-click-save-change-001.png`],
            },
            snapshots: {
              before: `${runDir}/snapshots/001-click-save-before.txt`,
              after: `${runDir}/snapshots/001-click-save-after.txt`,
            },
            domSnapshots: {
              before: `${runDir}/snapshots/001-click-save-before-dom.json`,
              after: `${runDir}/snapshots/001-click-save-after-dom.json`,
            },
            significantChanges: [
              {
                elapsedMs: 200,
                kind: "text",
                role: "button",
                significance: "medium",
                group: "content",
                summary: 'button changed from "Save" to "Saved"',
                selector: "#save",
              },
            ],
          }),
        },
      ],
    });

    expect(html).toContain("UI Change Timelines");
    expect(html).toContain("click #save");
    expect(html).toContain(
      "button changed from &quot;Save&quot; to &quot;Saved&quot;",
    );
    expect(html).toContain("uiChangeTimeline ui-changes/001-click-save.json");
    expect(html).toContain("before snapshot");
    expect(html).toContain("before DOM");
  });
});
