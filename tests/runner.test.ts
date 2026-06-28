import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BookmarkCurator, BookmarkCurationContext } from "../src/curation/types.js";
import type { AgentDirector, DirectorRunContext } from "../src/directors/types.js";
import type {
  DataLifecycleProvider,
  DataLifecycleProviderContext,
  DataLifecycleProviderResult,
} from "../src/lifecycle/index.js";
import type {
  BrowserCommandResult,
  BrowserDriver,
  BrowserStartOptions,
  ConsoleCaptureOptions,
  ElementBox,
  NetworkCaptureOptions,
  NetworkRecordingOptions,
  ScreenshotOptions,
  SnapshotOptions,
  ViewportSize,
  WaitOptions,
} from "../src/drivers/types.js";
import {
  TesterProfileSchema,
  UserJourneySchema,
  type AgentVerdict,
} from "../src/core/schemas.js";
import { runJourney } from "../src/runner/runJourney.js";

const lifecycleOpaqueSecret = "opaque-lifecycle-value";
const lifecycleStdoutToken = "stdout-token-123456";
const lifecycleStderrPassword = "stderr-password";
const lifecycleApiKey = "sk-ant-redaction123456";
const consoleBearerToken = "console-token-123456";
const consolePassword = "console-password";
const networkAccessToken = "network-token-123456";

class FakeBrowserDriver implements BrowserDriver {
  starts: BrowserStartOptions[] = [];
  recordingPath?: string;
  consoleCaptures: ConsoleCaptureOptions[] = [];
  networkCaptures: NetworkCaptureOptions[] = [];
  networkRecordingStarted = false;

  async start(options: BrowserStartOptions): Promise<void> {
    this.starts.push(options);
  }

  async startRecording(path: string): Promise<BrowserCommandResult> {
    this.recordingPath = path;
    await writeFile(path, "fake video", "utf8");
    return { summary: "Started fake recording" };
  }

  async stopRecording(): Promise<BrowserCommandResult> {
    return { summary: "Stopped fake recording" };
  }

  async open(url: string): Promise<BrowserCommandResult> {
    return { summary: `Opened ${url}` };
  }

  async snapshot(options: SnapshotOptions = {}): Promise<BrowserCommandResult<{ path?: string }>> {
    if (options.savePath) {
      await writeFile(options.savePath, '@e1 [button] "Invite"\n', "utf8");
    }
    return {
      summary: "Captured fake snapshot",
      stdout: '@e1 [button] "Invite"\n',
      details: { path: options.savePath },
    };
  }

  async click(target: string): Promise<BrowserCommandResult> {
    return { summary: `Clicked ${target}` };
  }

  async fill(target: string): Promise<BrowserCommandResult> {
    return { summary: `Filled ${target}` };
  }

  async type(target: string): Promise<BrowserCommandResult> {
    return { summary: `Typed ${target}` };
  }

  async press(key: string): Promise<BrowserCommandResult> {
    return { summary: `Pressed ${key}` };
  }

  async wait(options: WaitOptions): Promise<BrowserCommandResult> {
    return { summary: `Waited ${options.kind}` };
  }

  async screenshot(
    options: ScreenshotOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    await writeFile(options.path, "fake png", "utf8");
    return { summary: `Screenshot ${options.path}`, details: { path: options.path } };
  }

  async captureConsole(
    options: ConsoleCaptureOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    this.consoleCaptures.push(options);
    const output = [
      "# Console Logs",
      "console.warn: invite flow warning",
      `Authorization: Bearer ${consoleBearerToken}`,
      `password=${consolePassword}`,
      "",
      "# Page Errors",
      "No page errors.",
      "",
    ].join("\n");
    await writeFile(options.path, output, "utf8");
    return {
      summary: `Console evidence ${options.path}`,
      stdout: output,
      details: { path: options.path },
    };
  }

  async captureNetwork(
    options: NetworkCaptureOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    this.networkCaptures.push(options);
    const output = [
      `GET http://127.0.0.1:3000/api/invitations?access_token=${networkAccessToken} 200 fetch`,
      `Authorization: Bearer ${networkAccessToken}`,
      "",
    ].join("\n");
    await writeFile(options.path, output, "utf8");
    return {
      summary: `Network evidence ${options.path}`,
      stdout: output,
      details: { path: options.path },
    };
  }

  async startNetworkRecording(): Promise<BrowserCommandResult> {
    this.networkRecordingStarted = true;
    return { summary: "Started fake HAR recording" };
  }

  async stopNetworkRecording(
    options: NetworkRecordingOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    await writeFile(options.path, '{"log":{"entries":[]}}\n', "utf8");
    return { summary: `Stopped fake HAR recording ${options.path}`, details: { path: options.path } };
  }

  async getElementBox(): Promise<BrowserCommandResult<ElementBox>> {
    return {
      summary: "Read fake element box",
      details: { x: 120, y: 80, width: 160, height: 40 },
    };
  }

  async getViewport(): Promise<BrowserCommandResult<ViewportSize>> {
    return {
      summary: "Read fake viewport",
      details: { width: 800, height: 600, deviceScaleFactor: 1 },
    };
  }

  async getUrl(): Promise<string> {
    return "http://127.0.0.1:3000/admin/users";
  }

  async getTitle(): Promise<string> {
    return "Users";
  }

  async close(): Promise<void> {}
}

class ScriptedDirector implements AgentDirector {
  readonly name = "scripted";
  readonly model = { provider: "test", name: "scripted" };

  async run(context: DirectorRunContext): Promise<AgentVerdict> {
    await context.browser.open(context.journey.app.baseUrl);
    await context.browser.snapshot({
      savePath: join(context.artifacts.snapshotsDir, "001-scripted.txt"),
    });
    await context.browser.click("@e1");
    const box = (await context.browser.getElementBox("@e1")).details;
    const viewport = (await context.browser.getViewport()).details;
    await context.recorder.record("browser.click", "Clicked @e1", {
      target: "@e1",
      elementBox: box,
      click:
        box && viewport
          ? {
              x: Math.round(box.x + box.width / 2),
              y: Math.round(box.y + box.height / 2),
              viewportWidth: viewport.width,
              viewportHeight: viewport.height,
            }
          : undefined,
    });
    const screenshot = await context.browser.screenshot({
      path: join(context.artifacts.screenshotsDir, "confirmation.png"),
    });

    return {
      status: "passed",
      confidence: "high",
      summary: "The invitation flow reached a visible confirmation.",
      criteria: [
        {
          id: "invite-confirmed",
          result: "met",
          explanation: "A confirmation was visible after submitting the invite.",
          evidence: {
            videoTimeMs: 0,
            screenshot: screenshot.details?.path,
            observation: "The app showed an invitation confirmation.",
          },
        },
        {
          id: "cannot-find-user-management",
          result: "not-met",
          explanation: "User management was reachable.",
        },
        {
          id: "invite-not-confirmed",
          result: "not-met",
          explanation: "A clear confirmation was observed.",
        },
        {
          id: "auth-blocked",
          result: "not-met",
          explanation: "Authentication did not block the flow.",
        },
      ],
      blockers: [],
      uxFindings: [],
      suggestedImprovements: [
        {
          id: "confirmation-copy",
          severity: "minor",
          category: "copy",
          title: "Make confirmation persistent",
          description: "The confirmation should remain visible long enough to review.",
          recommendation: "Keep the invitation status in the users table.",
        },
      ],
    };
  }
}

class ScriptedBookmarkCurator implements BookmarkCurator {
  readonly name = "scripted-bookmark-curator";

  async curate(context: BookmarkCurationContext) {
    const click = context.result.timeline.find((event) => event.type === "browser.click");
    if (!click) {
      return [];
    }

    return [
      {
        id: "submit-invite-form",
        timeMs: click.videoTimeMs ?? 0,
        label: "Submit invite form",
        detail: "Clicked the invite action from the admin user journey.",
        sourceEventIds: [click.id],
        kind: "action" as const,
      },
    ];
  }
}

class ScriptedConsoleNetworkDirector implements AgentDirector {
  readonly name = "scripted-console-network";
  readonly model = { provider: "test", name: "scripted" };

  async run(context: DirectorRunContext): Promise<AgentVerdict> {
    if (!context.browser.captureConsole || !context.browser.captureNetwork) {
      throw new Error("Fake driver must support console and network capture.");
    }

    const consoleResult = await context.browser.captureConsole({
      path: join(context.artifacts.consoleDir, "invite-console.txt"),
    });
    const networkResult = await context.browser.captureNetwork({
      path: join(context.artifacts.networkDir, "invite-network.txt"),
      filter: "api/invitations",
      resourceTypes: ["fetch", "xhr"],
      status: "2xx",
    });

    const consolePath = consoleResult.details?.path;
    const networkPath = networkResult.details?.path;
    if (!consolePath || !networkPath) {
      throw new Error("Evidence capture did not return artifact paths.");
    }

    await context.recorder.record("browser.console_evidence", "Captured console evidence", {
      path: consolePath,
    });
    await context.recorder.record("browser.network_evidence", "Captured network evidence", {
      path: networkPath,
    });

    return {
      status: "passed",
      confidence: "high",
      summary: "Console and network evidence were captured for the invitation flow.",
      criteria: [
        {
          id: "invite-confirmed",
          result: "met",
          explanation: "The API request completed and no page error blocked the flow.",
          evidence: {
            console: consolePath,
            network: networkPath,
          },
        },
        {
          id: "cannot-find-user-management",
          result: "not-met",
          explanation: "User management was reachable.",
        },
        {
          id: "invite-not-confirmed",
          result: "not-met",
          explanation: "The invite request completed.",
        },
        {
          id: "auth-blocked",
          result: "not-met",
          explanation: "Authentication did not block the flow.",
        },
      ],
      blockers: [],
      uxFindings: [],
      suggestedImprovements: [],
    };
  }
}

class ScriptedDataLifecycleProvider implements DataLifecycleProvider {
  readonly name = "scripted-data";
  readonly calls: DataLifecycleProviderContext[] = [];

  constructor(private readonly failPreflight = false) {}

  async runOperation(
    context: DataLifecycleProviderContext,
  ): Promise<DataLifecycleProviderResult> {
    this.calls.push(context);

    if (context.operation.function === "testLifecycle:setupS2") {
      return {
        result: {
          journeys: {
            s2: {
              startUrl: "http://127.0.0.1:3000/intake/start",
              secretToken: "do-not-report",
              opaqueState: lifecycleOpaqueSecret,
            },
          },
          checks: [
            {
              id: "seeded",
              status: "pass",
              message: "Fixture exists.",
              data: { apiKey: lifecycleApiKey, opaque: lifecycleOpaqueSecret },
            },
          ],
        },
        stdout: `Authorization: Bearer ${lifecycleStdoutToken}\nopaque=${lifecycleOpaqueSecret}`,
        stderr: `{"password":"${lifecycleStderrPassword}"}`,
        redactValues: [lifecycleOpaqueSecret],
      };
    }

    if (context.operation.function === "testLifecycle:assertS2Ready") {
      return {
        result: {
          checks: [
            {
              id: "ready",
              status: this.failPreflight ? "fail" : "pass",
              message: this.failPreflight ? "Fixture drifted." : "Fixture is ready.",
            },
          ],
        },
      };
    }

    if (context.operation.function === "testLifecycle:assertS2Submitted") {
      return {
        result: {
          checks: [{ id: "submitted", status: "pass", message: "Submission stored." }],
        },
      };
    }

    if (context.operation.function === "testLifecycle:cleanupJourney") {
      return {
        result: {
          cleaned: true,
          namespace: context.namespace,
        },
      };
    }

    throw new Error(`Unexpected lifecycle function ${context.operation.function}`);
  }
}

describe("runJourney", () => {
  it("captures console and network evidence with the fake driver", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "journeytest-"));
    const consolePath = join(outputDir, "console.txt");
    const networkPath = join(outputDir, "network.txt");
    const driver = new FakeBrowserDriver();

    await driver.captureConsole({ path: consolePath, source: "all" });
    await driver.captureNetwork({ path: networkPath, filter: "api" });

    expect(driver.consoleCaptures[0]).toMatchObject({ path: consolePath, source: "all" });
    expect(driver.networkCaptures[0]).toMatchObject({ path: networkPath, filter: "api" });
    expect(await readFile(consolePath, "utf8")).toContain("console.warn");
    expect(await readFile(networkPath, "utf8")).toContain("/api/invitations");
  });

  it("writes run artifacts for a passed scripted journey", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "journeytest-"));
    const journey = UserJourneySchema.parse(
      JSON.parse(await readFile("examples/journeys/admin-invite-user.json", "utf8")),
    );
    const profile = TesterProfileSchema.parse(
      JSON.parse(await readFile("examples/profiles/admin.json", "utf8")),
    );

    const result = await runJourney({
      journey,
      profile,
      outputDir,
      driver: new FakeBrowserDriver(),
      director: new ScriptedDirector(),
      video: true,
      sessionName: "test-session",
      bookmarkCurator: new ScriptedBookmarkCurator(),
      trimSolidColorVideoStart: false,
    });

    expect(result.runStatus).toBe("completed");
    expect(result.verdict?.status).toBe("passed");
    expect(result.artifacts.screenshots).toHaveLength(1);
    expect(result.artifacts.snapshots).toHaveLength(1);

    const resultJson = JSON.parse(await readFile(result.artifacts.result, "utf8"));
    expect(resultJson.verdict.status).toBe("passed");
    expect(resultJson.bookmarks[0].label).toBe("Submit invite form");

    const report = await readFile(result.artifacts.report, "utf8");
    expect(report).toContain("JourneyTest Report");
    expect(report).toContain("invite-confirmed");

    const dashboard = await readFile(result.artifacts.dashboard, "utf8");
    expect(dashboard).toContain("JourneyTest");
    expect(dashboard).toContain("<video");
    expect(dashboard).toContain("data-seek-ms=\"0\"");
    expect(dashboard).toContain("<strong>1</strong> marks");
    expect(dashboard).toContain("Submit invite form");
    expect(dashboard).toContain("Moment Context");
    expect(dashboard).toContain("clickMarkers");
    expect(dashboard).toContain("data-click-marker");
    expect(dashboard).toContain("@e1 [button]");

    const events = await readFile(result.artifacts.events, "utf8");
    expect(events).toContain("journey.started");
    expect(events).toContain("journey.completed");
  });

  it("writes console and network evidence into runner artifacts and reports", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "journeytest-"));
    const rawJourney = JSON.parse(await readFile("examples/journeys/admin-invite-user.json", "utf8"));
    const journey = UserJourneySchema.parse({
      ...rawJourney,
      passCriteria: rawJourney.passCriteria.map((criterion: Record<string, unknown>) => ({
        ...criterion,
        requiredEvidence: ["console", "network"],
      })),
    });
    const profile = TesterProfileSchema.parse(
      JSON.parse(await readFile("examples/profiles/admin.json", "utf8")),
    );
    const driver = new FakeBrowserDriver();

    const result = await runJourney({
      journey,
      profile,
      outputDir,
      driver,
      director: new ScriptedConsoleNetworkDirector(),
      video: false,
      trimSolidColorVideoStart: false,
      condenseStaticVideo: false,
    });

    expect(result.runStatus).toBe("completed");
    expect(result.artifacts.console).toHaveLength(1);
    expect(result.artifacts.network).toHaveLength(1);
    expect(driver.networkCaptures[0]?.resourceTypes).toEqual(["fetch", "xhr"]);

    const resultJson = JSON.parse(await readFile(result.artifacts.result, "utf8"));
    expect(resultJson.artifacts.console).toEqual(result.artifacts.console);
    expect(resultJson.artifacts.network).toEqual(result.artifacts.network);
    expect(resultJson.verdict.criteria[0].evidence.console).toBe(result.artifacts.console[0]);
    expect(resultJson.verdict.criteria[0].evidence.network).toBe(result.artifacts.network[0]);

    const report = await readFile(result.artifacts.report, "utf8");
    expect(report).toContain("console ");
    expect(report).toContain("network ");
    expect(report).toContain("- Console:");
    expect(report).toContain("- Network:");

    const dashboard = await readFile(result.artifacts.dashboard, "utf8");
    expect(dashboard).toContain("Console Evidence");
    expect(dashboard).toContain("Network Evidence");
    expect(dashboard).toContain("console.warn");
    expect(dashboard).toContain("/api/invitations");
    expect(dashboard).not.toContain(consoleBearerToken);
    expect(dashboard).not.toContain(consolePassword);
    expect(dashboard).not.toContain(networkAccessToken);

    const consoleArtifact = await readFile(result.artifacts.console[0] ?? "", "utf8");
    const networkArtifact = await readFile(result.artifacts.network[0] ?? "", "utf8");
    expect(consoleArtifact).not.toContain(consoleBearerToken);
    expect(consoleArtifact).not.toContain(consolePassword);
    expect(networkArtifact).not.toContain(networkAccessToken);
  });

  it("uses the generated run id as the browser session when no session is provided", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "journeytest-"));
    const journey = UserJourneySchema.parse(
      JSON.parse(await readFile("examples/journeys/admin-invite-user.json", "utf8")),
    );
    const profile = TesterProfileSchema.parse(
      JSON.parse(await readFile("examples/profiles/admin.json", "utf8")),
    );
    const driver = new FakeBrowserDriver();

    const result = await runJourney({
      journey,
      profile,
      outputDir,
      driver,
      director: new ScriptedDirector(),
      video: false,
      trimSolidColorVideoStart: false,
      condenseStaticVideo: false,
    });

    expect(driver.starts[0]?.sessionName).toBe(result.runId);
  });

  it("runs journey data lifecycle operations and writes lifecycle artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "journeytest-"));
    const rawJourney = JSON.parse(await readFile("examples/journeys/admin-invite-user.json", "utf8"));
    const journey = UserJourneySchema.parse({
      ...rawJourney,
      dataLifecycle: {
        environment: "local-convex",
        setup: {
          id: "setup-s2",
          kind: "mutation",
          function: "testLifecycle:setupS2",
          args: { runId: "$context.runId" },
          manifestPath: "$.journeys.s2",
        },
        preflight: [
          {
            id: "s2-ready",
            kind: "query",
            function: "testLifecycle:assertS2Ready",
            args: { startUrl: "$manifest.startUrl" },
          },
        ],
        postconditions: [
          {
            id: "s2-submitted",
            kind: "query",
            function: "testLifecycle:assertS2Submitted",
            args: { namespace: "$context.namespace" },
          },
        ],
        cleanup: {
          id: "cleanup-s2",
          kind: "mutation",
          function: "testLifecycle:cleanupJourney",
          args: { manifest: "$manifest", namespace: "$context.namespace" },
        },
      },
    });
    const profile = TesterProfileSchema.parse(
      JSON.parse(await readFile("examples/profiles/admin.json", "utf8")),
    );
    const provider = new ScriptedDataLifecycleProvider();

    const result = await runJourney({
      journey,
      profile,
      outputDir,
      driver: new FakeBrowserDriver(),
      director: new ScriptedDirector(),
      video: false,
      trimSolidColorVideoStart: false,
      condenseStaticVideo: false,
      dataLifecycle: {
        environments: {
          "local-convex": {
            provider: "convex",
            transport: "http",
            url: "http://127.0.0.1:3220",
          },
        },
        provider,
      },
    });

    expect(result.runStatus).toBe("completed");
    expect(result.verdict?.status).toBe("passed");
    expect(result.dataLifecycle?.status).toBe("passed");
    expect(provider.calls.map((call) => call.operation.function)).toEqual([
      "testLifecycle:setupS2",
      "testLifecycle:assertS2Ready",
      "testLifecycle:assertS2Submitted",
      "testLifecycle:cleanupJourney",
    ]);

    const setupArtifact = JSON.parse(
      await readFile(result.artifacts.dataLifecycle?.setup ?? "", "utf8"),
    );
    expect(setupArtifact.operations[0].status).toBe("passed");
    expect(setupArtifact.manifest.secretToken).toBe("[redacted]");
    expect(setupArtifact.manifest.opaqueState).toBe("[redacted]");
    const setupArtifactJson = JSON.stringify(setupArtifact);
    expect(setupArtifactJson).not.toContain(lifecycleOpaqueSecret);
    expect(setupArtifactJson).not.toContain(lifecycleStdoutToken);
    expect(setupArtifactJson).not.toContain(lifecycleStderrPassword);
    expect(setupArtifactJson).not.toContain(lifecycleApiKey);

    const cleanupCall = provider.calls.at(-1);
    expect(cleanupCall?.args).toMatchObject({
      manifest: {
        startUrl: "http://127.0.0.1:3000/intake/start",
        secretToken: "do-not-report",
        opaqueState: lifecycleOpaqueSecret,
      },
      namespace: result.dataLifecycle?.namespace,
    });

    const report = await readFile(result.artifacts.report, "utf8");
    expect(report).toContain("## Data Lifecycle");
    expect(report).toContain("testLifecycle:assertS2Submitted");

    const dashboard = await readFile(result.artifacts.dashboard, "utf8");
    expect(dashboard).toContain("Data Lifecycle");
    expect(dashboard).toContain("testLifecycle:cleanupJourney");
    expect(dashboard).not.toContain(lifecycleOpaqueSecret);
    expect(dashboard).not.toContain(lifecycleStdoutToken);
    expect(dashboard).not.toContain(lifecycleStderrPassword);
    expect(dashboard).not.toContain(lifecycleApiKey);
  });

  it("blocks browser startup when data lifecycle preflight fails and still cleans up", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "journeytest-"));
    const rawJourney = JSON.parse(await readFile("examples/journeys/admin-invite-user.json", "utf8"));
    const journey = UserJourneySchema.parse({
      ...rawJourney,
      dataLifecycle: {
        environment: "local-convex",
        setup: {
          id: "setup-s2",
          kind: "mutation",
          function: "testLifecycle:setupS2",
          manifestPath: "$.journeys.s2",
        },
        preflight: [
          {
            id: "s2-ready",
            kind: "query",
            function: "testLifecycle:assertS2Ready",
          },
        ],
        cleanup: {
          id: "cleanup-s2",
          kind: "mutation",
          function: "testLifecycle:cleanupJourney",
          args: { namespace: "$context.namespace" },
        },
      },
    });
    const profile = TesterProfileSchema.parse(
      JSON.parse(await readFile("examples/profiles/admin.json", "utf8")),
    );
    const driver = new FakeBrowserDriver();
    const provider = new ScriptedDataLifecycleProvider(true);

    const result = await runJourney({
      journey,
      profile,
      outputDir,
      driver,
      director: new ScriptedDirector(),
      video: false,
      trimSolidColorVideoStart: false,
      condenseStaticVideo: false,
      dataLifecycle: {
        environments: {
          "local-convex": {
            provider: "convex",
            transport: "http",
            url: "http://127.0.0.1:3220",
          },
        },
        provider,
      },
    });

    expect(result.runStatus).toBe("blocked");
    expect(result.verdict).toBeUndefined();
    expect(result.dataLifecycle?.status).toBe("blocked");
    expect(driver.starts).toHaveLength(0);
    expect(provider.calls.map((call) => call.operation.function)).toEqual([
      "testLifecycle:setupS2",
      "testLifecycle:assertS2Ready",
      "testLifecycle:cleanupJourney",
    ]);

    const preflightArtifact = JSON.parse(
      await readFile(result.artifacts.dataLifecycle?.preflight ?? "", "utf8"),
    );
    expect(preflightArtifact.status).toBe("blocked");
    expect(preflightArtifact.operations[0].checks[0].status).toBe("fail");
  });
});
