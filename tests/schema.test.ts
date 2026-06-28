import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AgentVerdictSchema,
  EvidenceReferenceSchema,
  RunArtifactsSchema,
  TesterProfileSchema,
  UserJourneySchema,
} from "../src/core/schemas.js";
import {
  validateAllowedOrigins,
  validateJourneyProfileMatch,
} from "../src/core/validation.js";

describe("JourneyTest example schemas", () => {
  it("validates the bundled admin profile and invite journey", async () => {
    const profile = TesterProfileSchema.parse(
      JSON.parse(await readFile("examples/profiles/admin.json", "utf8")),
    );
    const journey = UserJourneySchema.parse(
      JSON.parse(
        await readFile("examples/journeys/admin-invite-user.json", "utf8"),
      ),
    );

    expect(validateJourneyProfileMatch(journey, profile)).toEqual([]);
    expect(validateAllowedOrigins(journey)).toEqual([]);
  });

  it("accepts console and network evidence references and artifact paths", () => {
    expect(
      EvidenceReferenceSchema.parse({
        console: "console/001-console.txt",
        network: "network/001-network.txt",
        uiChangeTimeline: "ui-changes/001-click.json",
      }),
    ).toEqual({
      console: "console/001-console.txt",
      network: "network/001-network.txt",
      uiChangeTimeline: "ui-changes/001-click.json",
    });

    expect(
      RunArtifactsSchema.parse({
        runDir: "/tmp/run",
        events: "/tmp/run/events.ndjson",
        dashboard: "/tmp/run/dashboard.html",
        report: "/tmp/run/report.md",
        result: "/tmp/run/run.json",
        console: ["/tmp/run/console/001-console.txt"],
        network: ["/tmp/run/network/001-network.txt"],
        uiChanges: ["/tmp/run/ui-changes/001-click.json"],
      }),
    ).toMatchObject({
      console: ["/tmp/run/console/001-console.txt"],
      network: ["/tmp/run/network/001-network.txt"],
      uiChanges: ["/tmp/run/ui-changes/001-click.json"],
      screenshots: [],
      snapshots: [],
    });

    expect(
      AgentVerdictSchema.parse({
        status: "passed",
        confidence: "high",
        summary: "Done.",
        criteria: [
          {
            id: "api-ok",
            result: "met",
            explanation: "Console and network evidence were captured.",
            evidence: {
              console: "console/001-console.txt",
              network: "network/001-network.txt",
              uiChangeTimeline: "ui-changes/001-click.json",
            },
          },
        ],
      }).criteria[0]?.evidence,
    ).toEqual({
      console: "console/001-console.txt",
      network: "network/001-network.txt",
      uiChangeTimeline: "ui-changes/001-click.json",
    });
  });
});
