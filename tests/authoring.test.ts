import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  createJsonSchemaDocument,
  createTesterProfileTemplate,
  createUserJourneyTemplate,
  stringifyJsonDocument,
} from "../src/core/authoring.js";
import {
  TesterProfileSchema,
  UserJourneySchema,
  type UserJourney,
} from "../src/core/schemas.js";
import {
  validateAllowedOrigins,
  validateJourneyProfileMatch,
} from "../src/core/validation.js";

describe("JourneyTest authoring helpers", () => {
  it("generates schema-valid default profile and journey JSON", () => {
    const profile = createTesterProfileTemplate();
    const journey = createUserJourneyTemplate();

    expect(TesterProfileSchema.safeParse(profile).success).toBe(true);
    expect(UserJourneySchema.safeParse(journey).success).toBe(true);
    expect(validateJourneyProfileMatch(journey, profile)).toEqual([]);
    expect(validateAllowedOrigins(journey)).toEqual([]);
  });

  it("init writes schema-valid starter JSON files", async () => {
    const root = await mkdtemp(join(tmpdir(), "journeytest-authoring-"));
    const authoringDir = join(root, "journeytest");

    await captureConsole(() =>
      runCli(["node", "journeytest", "init", "--dir", authoringDir]),
    );

    const profile = TesterProfileSchema.parse(
      JSON.parse(await readFile(join(authoringDir, "profiles", "admin.json"), "utf8")),
    );
    const journey = UserJourneySchema.parse(
      JSON.parse(
        await readFile(join(authoringDir, "journeys", "admin-invite-user.json"), "utf8"),
      ),
    );

    expect(validateJourneyProfileMatch(journey, profile)).toEqual([]);
    expect(validateAllowedOrigins(journey)).toEqual([]);
  });

  it("prints JSON schema for a user journey", () => {
    const schema = createJsonSchemaDocument("journey") as {
      properties?: Record<string, unknown>;
    };

    expect(schema.properties).toHaveProperty("passCriteria");
    expect(schema.properties).toHaveProperty("blockerCriteria");
  });

  it("lint prints authoring quality issues beyond schema validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "journeytest-lint-"));
    const journeyPath = join(root, "weak-journey.json");
    const journey: UserJourney = createUserJourneyTemplate();
    journey.passCriteria = [
      {
        id: "critical-pass",
        statement: "The final confirmation is visible to the tester.",
        severity: "critical",
      },
    ];
    journey.failCriteria = [
      {
        id: "generic-fail",
        statement: "The journey fails.",
        severity: "major",
      },
    ];
    journey.preconditions = ["The tester is authenticated as an admin."];
    journey.riskLevel = "destructive";
    delete journey.blockerCriteria;

    await writeFile(journeyPath, stringifyJsonDocument(journey), "utf8");

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    let output = { stdout: "", stderr: "" };
    try {
      output = await captureConsole(() =>
        runCli(["node", "journeytest", "lint", "--journeys", journeyPath]),
      );

      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
    expect(output.stderr).toContain("missing-blocker-criteria");
    expect(output.stderr).toContain("weak-fail-criterion");
    expect(output.stderr).toContain("critical-pass-evidence");
    expect(output.stderr).toContain("destructive-risk-blocker");
    expect(output.stderr).toContain("destructive-risk-cleanup");
    expect(output.stdout).toContain("Linted 0 profile(s), 1 journey file(s).");
  });
});

async function captureConsole(action: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
}> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };

  try {
    await action();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return {
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}
