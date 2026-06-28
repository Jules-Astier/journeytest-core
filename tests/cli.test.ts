import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BookmarkCurationContext,
  BookmarkCurator,
} from "../src/curation/types.js";
import { PiBookmarkCurator } from "../src/curation/index.js";
import type {
  AgentDirector,
  DirectorRunContext,
} from "../src/directors/types.js";
import { PiSdkDirector } from "../src/directors/pi/index.js";
import type {
  BrowserCommandResult,
  BrowserDriver,
  BrowserStartOptions,
  ElementBox,
  ScreenshotOptions,
  SnapshotOptions,
  ViewportSize,
  WaitOptions,
} from "../src/drivers/types.js";
import { AgentBrowserDriver } from "../src/drivers/agent-browser/index.js";
import {
  ConvexDataLifecycleProvider,
  DataLifecycleProviderRouter,
  HttpDataLifecycleProvider,
  ScriptDataLifecycleProvider,
} from "../src/lifecycle/index.js";
import {
  bookmarkCuratorNameForOptions,
  browserSessionNameForRun,
  browserTabLabelForRun,
  buildUiChangeRecordingOptions,
  defaultUserAuthPath,
  formatMissingOAuthCredentialsMessage,
  getOAuthAuthStatus,
  parallelBrowserSessionName,
  parseParallelAgents,
  parseParallelBrowserMode,
  resolveAuthPath,
  runCli,
  sessionNameForRun,
  shouldUseSharedBrowserTabs,
} from "../src/cli.js";
import {
  createDefaultJourneyTestFactoryRegistry,
  type JourneyTestFactoryRegistry,
} from "../src/factories/index.js";
import type { AgentVerdict } from "../src/core/schemas.js";

class DummyBrowserDriver implements BrowserDriver {
  starts: BrowserStartOptions[] = [];
  private currentUrl = "http://127.0.0.1:3000";

  async start(options: BrowserStartOptions): Promise<void> {
    this.starts.push(options);
    this.currentUrl = options.baseUrl;
  }

  async startRecording(): Promise<BrowserCommandResult> {
    return { summary: "Started dummy recording" };
  }

  async stopRecording(): Promise<BrowserCommandResult> {
    return { summary: "Stopped dummy recording" };
  }

  async open(url: string): Promise<BrowserCommandResult> {
    this.currentUrl = url;
    return { summary: `Opened ${url}` };
  }

  async snapshot(
    options: SnapshotOptions = {},
  ): Promise<BrowserCommandResult<{ path?: string }>> {
    if (options.savePath) {
      await writeFile(options.savePath, '@dummy [button] "Submit"\n', "utf8");
    }
    return {
      summary: "Captured dummy snapshot",
      stdout: '@dummy [button] "Submit"\n',
      details: { path: options.savePath },
    };
  }

  async scrollIntoView(target: string): Promise<BrowserCommandResult> {
    return { summary: `Scrolled ${target} into view` };
  }

  async scroll(): Promise<BrowserCommandResult> {
    return { summary: "Scrolled dummy page" };
  }

  async click(target: string): Promise<BrowserCommandResult> {
    return { summary: `Clicked ${target}` };
  }

  async fill(target: string, value: string): Promise<BrowserCommandResult> {
    return { summary: `Filled ${target} with ${value}` };
  }

  async type(target: string, value: string): Promise<BrowserCommandResult> {
    return { summary: `Typed ${value} into ${target}` };
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
    await writeFile(options.path, "dummy screenshot", "utf8");
    return {
      summary: `Captured ${options.path}`,
      details: { path: options.path },
    };
  }

  async getElementBox(): Promise<BrowserCommandResult<ElementBox>> {
    return {
      summary: "Read dummy element box",
      details: { x: 20, y: 30, width: 100, height: 40 },
    };
  }

  async getViewport(): Promise<BrowserCommandResult<ViewportSize>> {
    return {
      summary: "Read dummy viewport",
      details: { width: 1280, height: 720, deviceScaleFactor: 1 },
    };
  }

  async getUrl(): Promise<string> {
    return this.currentUrl;
  }

  async getTitle(): Promise<string> {
    return "Dummy";
  }

  async close(): Promise<void> {}
}

class DummyDirector implements AgentDirector {
  readonly name = "dummy-director";
  readonly model = { provider: "dummy", name: "dummy-model" };

  constructor(private readonly calls: { directorRuns: number }) {}

  async run(context: DirectorRunContext): Promise<AgentVerdict> {
    this.calls.directorRuns++;
    await context.browser.open(context.journey.app.baseUrl);
    const screenshot = await context.browser.screenshot({
      path: join(context.artifacts.screenshotsDir, "dummy-confirmation.png"),
    });
    await context.recorder.record("browser.click", "Clicked dummy submit", {
      target: "@dummy",
    });

    return {
      status: "passed",
      confidence: "high",
      summary: "Dummy director completed the journey.",
      criteria: [
        {
          id: "invite-confirmed",
          result: "met",
          explanation: "The dummy run observed a confirmation.",
          evidence: {
            videoTimeMs: 0,
            screenshot: screenshot.details?.path,
            observation: "The invitation was confirmed.",
          },
        },
        {
          id: "cannot-find-user-management",
          result: "not-met",
          explanation: "The dummy user management path was reachable.",
        },
        {
          id: "invite-not-confirmed",
          result: "not-met",
          explanation: "The dummy run included confirmation evidence.",
        },
        {
          id: "auth-blocked",
          result: "not-met",
          explanation: "The dummy run was not blocked by auth.",
        },
      ],
      blockers: [],
      uxFindings: [],
      suggestedImprovements: [],
    };
  }
}

class DummyBookmarkCurator implements BookmarkCurator {
  readonly name = "dummy-bookmark-curator";

  constructor(private readonly calls: { curatorRuns: number }) {}

  async curate(_context: BookmarkCurationContext) {
    this.calls.curatorRuns++;
    return [
      {
        id: "dummy-bookmark",
        timeMs: 0,
        label: "Dummy bookmark",
        kind: "milestone" as const,
      },
    ];
  }
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("CLI parallel agents options", () => {
  it("parses a positive parallel agent count", () => {
    expect(parseParallelAgents("1")).toBe(1);
    expect(parseParallelAgents("4")).toBe(4);
  });

  it("rejects invalid parallel agent counts", () => {
    expect(() => parseParallelAgents("0")).toThrow("--parallel-agents");
    expect(() => parseParallelAgents("1.5")).toThrow("--parallel-agents");
    expect(() => parseParallelAgents("many")).toThrow("--parallel-agents");
  });

  it("parses parallel browser modes", () => {
    expect(parseParallelBrowserMode("shared-tabs")).toBe("shared-tabs");
    expect(parseParallelBrowserMode("isolated-sessions")).toBe(
      "isolated-sessions",
    );
    expect(() => parseParallelBrowserMode("shared-contexts")).toThrow(
      "--parallel-browser-mode",
    );
  });

  it("keeps explicit session unchanged for sequential runs", () => {
    expect(sessionNameForRun("admin-suite", 1, "admin-invite-user", 0)).toBe(
      "admin-suite",
    );
  });

  it("derives distinct session names for parallel runs", () => {
    expect(sessionNameForRun("admin-suite", 3, "admin invite user", 1)).toBe(
      "admin-suite-02-admin-invite-user",
    );
  });

  it("plans shared browser tabs for parallel agent-browser runs", () => {
    expect(
      shouldUseSharedBrowserTabs({
        browser: "agent-browser",
        parallelAgents: 3,
        journeyCount: 4,
        parallelBrowserMode: "shared-tabs",
      }),
    ).toBe(true);
    expect(parallelBrowserSessionName(undefined, "suite-123")).toBe(
      "suite-123",
    );
    expect(
      browserSessionNameForRun({
        baseSession: "admin-suite",
        parallelAgents: 3,
        journeyId: "admin invite user",
        index: 1,
        suiteRunId: "suite-123",
        sharedBrowserTabs: true,
      }),
    ).toBe("admin-suite");
    expect(
      browserTabLabelForRun({
        parallelAgents: 3,
        journeyId: "admin invite user",
        index: 1,
        sharedBrowserTabs: true,
      }),
    ).toBe("journey-02-admin-invite-user");
  });

  it("keeps isolated session planning when shared tabs are disabled", () => {
    expect(
      shouldUseSharedBrowserTabs({
        browser: "agent-browser",
        parallelAgents: 3,
        journeyCount: 4,
        parallelBrowserMode: "isolated-sessions",
      }),
    ).toBe(false);
    expect(
      browserSessionNameForRun({
        baseSession: "admin-suite",
        parallelAgents: 3,
        journeyId: "admin invite user",
        index: 1,
        suiteRunId: "suite-123",
        sharedBrowserTabs: false,
      }),
    ).toBe("admin-suite-02-admin-invite-user");
    expect(
      browserTabLabelForRun({
        parallelAgents: 3,
        journeyId: "admin invite user",
        index: 1,
        sharedBrowserTabs: false,
      }),
    ).toBeUndefined();
  });

  it("maps bookmark curation compatibility flags to factory names", () => {
    expect(bookmarkCuratorNameForOptions({ bookmarkCurator: "pi" })).toBe("pi");
    expect(bookmarkCuratorNameForOptions({ bookmarkCurator: "dummy" })).toBe(
      "dummy",
    );
    expect(
      bookmarkCuratorNameForOptions({
        bookmarkCurator: "pi",
        curateBookmarks: false,
      }),
    ).toBe("none");
  });

  it("builds UI change recording options from CLI flags", () => {
    expect(
      buildUiChangeRecordingOptions({
        uiChangeTimeoutMs: "3000",
        uiChangeQuietMs: "400",
        uiChangeMaxChanges: "25",
        uiChangeMaxScreenshots: "2",
        uiChangeScreenshots: false,
        uiChangeSnapshots: true,
        uiChangeDomSnapshots: false,
      }),
    ).toEqual({
      timeoutMs: 3000,
      quietMs: 400,
      maxChanges: 25,
      maxScreenshots: 2,
      screenshots: false,
      snapshots: true,
      domSnapshots: false,
    });
    expect(() =>
      buildUiChangeRecordingOptions({ uiChangeTimeoutMs: "0" }),
    ).toThrow("--ui-change-timeout-ms");
  });
});

describe("CLI auth path resolution", () => {
  it("prefers --auth over env and local auth files", async () => {
    const cwd = resolve("/tmp/journeytest-auth");
    const result = await resolveAuthPath("cli-auth.json", {
      cwd,
      env: { JOURNEYTEST_AUTH_PATH: "env-auth.json" },
      homeDir: "/home/journeytest",
      platform: "linux",
      fileExists: async () => true,
    });

    expect(result).toMatchObject({
      source: "cli",
      path: join(cwd, "cli-auth.json"),
      localPath: join(cwd, "auth.json"),
    });
  });

  it("prefers JOURNEYTEST_AUTH_PATH over local auth files", async () => {
    const cwd = resolve("/tmp/journeytest-auth");
    const result = await resolveAuthPath(undefined, {
      cwd,
      env: { JOURNEYTEST_AUTH_PATH: "env-auth.json" },
      homeDir: "/home/journeytest",
      platform: "linux",
      fileExists: async () => true,
    });

    expect(result).toMatchObject({
      source: "env",
      path: join(cwd, "env-auth.json"),
    });
  });

  it("preserves existing local auth.json compatibility", async () => {
    const cwd = resolve("/tmp/journeytest-auth");
    const localPath = join(cwd, "auth.json");
    const result = await resolveAuthPath(undefined, {
      cwd,
      env: {},
      homeDir: "/home/journeytest",
      platform: "linux",
      fileExists: async (path) => path === localPath,
    });

    expect(result).toMatchObject({
      source: "local",
      path: localPath,
    });
  });

  it("falls back to the user config auth path when no local auth file exists", async () => {
    const cwd = resolve("/tmp/journeytest-auth");
    const env = { XDG_CONFIG_HOME: join(cwd, "xdg") };
    const result = await resolveAuthPath(undefined, {
      cwd,
      env,
      homeDir: "/home/journeytest",
      platform: "linux",
      fileExists: async () => false,
    });

    expect(result).toMatchObject({
      source: "user-config",
      path: join(cwd, "xdg", "journeytest", "auth.json"),
    });
    expect(
      defaultUserAuthPath({
        env,
        homeDir: "/home/journeytest",
        platform: "linux",
      }),
    ).toBe(join(cwd, "xdg", "journeytest", "auth.json"));
  });

  it("formats missing OAuth credential guidance with override and login details", async () => {
    const cwd = resolve("/tmp/journeytest-auth");
    const authPath = await resolveAuthPath("custom-auth.json", {
      cwd,
      env: {},
      homeDir: "/home/journeytest",
      platform: "linux",
      fileExists: async () => false,
    });
    const message = formatMissingOAuthCredentialsMessage("anthropic", authPath);

    expect(message).toContain('No OAuth credentials found for "anthropic"');
    expect(message).toContain("npx @earendil-works/pi-ai login anthropic");
    expect(message).toContain("--auth <path>");
    expect(message).toContain("JOURNEYTEST_AUTH_PATH");
    expect(message).toContain("move it");
  });

  it("reports configured OAuth providers without exposing credentials", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "journeytest-auth-status-"));
    const authFile = join(cwd, "auth.json");
    await writeFile(
      authFile,
      `${JSON.stringify(
        {
          anthropic: {
            type: "oauth",
            access: "access-token-value",
            refresh: "refresh-token-value",
            expires: 123,
          },
          "openai-codex": {
            type: "oauth",
            access: "codex-access-token-value",
            refresh: "codex-refresh-token-value",
            expires: 456,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const authPath = await resolveAuthPath(undefined, {
      cwd,
      env: {},
      homeDir: "/home/journeytest",
      platform: "linux",
    });
    const status = await getOAuthAuthStatus(authPath);
    const serialized = JSON.stringify(status);

    expect(status).toMatchObject({
      path: authFile,
      source: "local",
      exists: true,
      configuredProviders: ["anthropic", "openai-codex"],
    });
    expect(status.availableOAuthProviders).toContain("anthropic");
    expect(serialized).not.toContain("access-token-value");
    expect(serialized).not.toContain("refresh-token-value");
  });
});

describe("CLI factories", () => {
  it("registers default implementation factories", () => {
    const registry = createDefaultJourneyTestFactoryRegistry();
    const modelContext = {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    };

    expect(registry.directors.names()).toEqual(["pi"]);
    expect(registry.browserDrivers.names()).toEqual(["agent-browser"]);
    expect(registry.bookmarkCurators.names()).toEqual(["none", "pi"]);
    expect(registry.dataLifecycleProviders.names()).toEqual([
      "convex",
      "default",
      "http",
      "script",
    ]);
    expect(registry.directors.create("pi", modelContext)).toBeInstanceOf(
      PiSdkDirector,
    );
    expect(registry.directors.authProvider("pi", modelContext)).toBe(
      "anthropic",
    );
    expect(registry.browserDrivers.create("agent-browser", {})).toBeInstanceOf(
      AgentBrowserDriver,
    );
    expect(registry.bookmarkCurators.create("pi", modelContext)).toBeInstanceOf(
      PiBookmarkCurator,
    );
    expect(
      registry.bookmarkCurators.create("none", modelContext),
    ).toBeUndefined();
    expect(registry.dataLifecycleProviders.create("convex", {})).toBeInstanceOf(
      ConvexDataLifecycleProvider,
    );
    expect(
      registry.dataLifecycleProviders.create("default", {}),
    ).toBeInstanceOf(DataLifecycleProviderRouter);
    expect(registry.dataLifecycleProviders.create("http", {})).toBeInstanceOf(
      HttpDataLifecycleProvider,
    );
    expect(registry.dataLifecycleProviders.create("script", {})).toBeInstanceOf(
      ScriptDataLifecycleProvider,
    );
  });

  it("uses CLI-selected dummy factories for a run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const outputDir = await mkdtemp(join(tmpdir(), "journeytest-cli-"));
    const calls = {
      browsersCreated: 0,
      directorRuns: 0,
      curatorRuns: 0,
    };
    const registry: JourneyTestFactoryRegistry =
      createDefaultJourneyTestFactoryRegistry();

    registry.browserDrivers.register("dummy", () => {
      calls.browsersCreated++;
      return new DummyBrowserDriver();
    });
    registry.directors.register("dummy", () => new DummyDirector(calls));
    registry.bookmarkCurators.register(
      "dummy",
      () => new DummyBookmarkCurator(calls),
    );

    await runCli(
      [
        "node",
        "journeytest",
        "run",
        "examples/journeys/admin-invite-user.json",
        "--profile",
        "examples/profiles/admin.json",
        "--out",
        outputDir,
        "--provider",
        "dummy",
        "--model",
        "dummy-model",
        "--director",
        "dummy",
        "--browser",
        "dummy",
        "--bookmark-curator",
        "dummy",
        "--no-video",
        "--no-trim-solid-video",
        "--no-condense-static-video",
      ],
      { factories: registry },
    );

    const runDirs = await readdir(outputDir);
    const result = JSON.parse(
      await readFile(join(outputDir, runDirs[0] ?? "", "run.json"), "utf8"),
    );

    expect(process.exitCode).toBeUndefined();
    expect(calls.browsersCreated).toBe(1);
    expect(calls.directorRuns).toBe(1);
    expect(calls.curatorRuns).toBe(1);
    expect(result.model).toEqual({ provider: "dummy", name: "dummy-model" });
    expect(result.bookmarks[0].label).toBe("Dummy bookmark");
  });
});
