import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type {
  BrowserCommandResult,
  BrowserDriver,
  BrowserStartOptions,
  ConsoleCaptureOptions,
  DomSnapshotOptions,
  ElementBox,
  NetworkCaptureOptions,
  NetworkRecordingOptions,
  ScrollOptions,
  ScreenshotOptions,
  SnapshotOptions,
  UiChangeObservation,
  UiChangeObservationOptions,
  ViewportSize,
  WaitOptions,
} from "../types.js";
import { assertUrlAllowed } from "../../utils/url.js";
import {
  redactSensitiveText,
  redactTextArtifactContent,
} from "../../utils/redaction.js";
import type {
  BrowserDevicePreset,
  BrowserEnvironment,
} from "../../core/schemas.js";

const execFileAsync = promisify(execFile);

export interface AgentBrowserDriverOptions {
  command?: string;
  timeoutMs?: number;
}

interface SharedRunOptions {
  startsRecording?: boolean;
  stopsRecording?: boolean;
}

const DEFAULT_AGENT_BROWSER_SESSION = "default";
const TAB_NEW_RETRY_DELAY_MS = 500;
const sharedAgentBrowserSessions = new Map<string, SharedAgentBrowserSession>();
const AGENT_BROWSER_DEVICE_NAMES: Record<BrowserDevicePreset, string> = {
  "iphone-14": "iPhone 14",
  "pixel-7": "Pixel 7",
  "ipad-pro-11": "iPad Pro 11",
};

class SharedAgentBrowserSession {
  activeTabs = 0;
  private queue: Promise<void> = Promise.resolve();
  private recordingOwner?: string;
  private recordingDepth = 0;
  private recordingFinished?: Promise<void>;
  private finishRecording?: () => void;

  constructor(readonly name: string) {}

  retain(): void {
    this.activeTabs++;
  }

  async release(closeBrowser: () => Promise<void>): Promise<void> {
    if (this.activeTabs > 0) {
      this.activeTabs--;
    }

    if (this.activeTabs > 0) {
      return;
    }

    await this.enqueue(async () => {
      await closeBrowser();
      sharedAgentBrowserSessions.delete(this.name);
    });
  }

  async runForTab<T>(
    tabLabel: string,
    operation: () => Promise<T>,
    options: SharedRunOptions = {},
  ): Promise<T> {
    for (;;) {
      const recordingWait = this.waitForOtherRecording(tabLabel);
      if (recordingWait) {
        await recordingWait;
        continue;
      }

      const outcome = await this.enqueue(async () => {
        const queuedRecordingWait = this.waitForOtherRecording(tabLabel);
        if (queuedRecordingWait) {
          return { kind: "retry", wait: queuedRecordingWait } as const;
        }

        try {
          const value = await operation();
          if (options.startsRecording) {
            this.startRecording(tabLabel);
          }
          if (options.stopsRecording && this.recordingOwner === tabLabel) {
            this.stopRecording(tabLabel);
          }
          return { kind: "value", value } as const;
        } catch (error) {
          if (options.stopsRecording && this.recordingOwner === tabLabel) {
            this.clearRecording();
          }
          throw error;
        }
      });

      if (outcome.kind === "value") {
        return outcome.value;
      }

      await outcome.wait;
    }
  }

  private waitForOtherRecording(tabLabel: string): Promise<void> | undefined {
    if (!this.recordingOwner || this.recordingOwner === tabLabel) {
      return undefined;
    }
    return this.recordingFinished;
  }

  private startRecording(tabLabel: string): void {
    if (this.recordingOwner === tabLabel) {
      this.recordingDepth++;
      return;
    }

    this.clearRecording();
    this.recordingOwner = tabLabel;
    this.recordingDepth = 1;
    this.recordingFinished = new Promise((resolve) => {
      this.finishRecording = resolve;
    });
  }

  private stopRecording(tabLabel: string): void {
    if (this.recordingOwner !== tabLabel) {
      return;
    }
    this.recordingDepth = Math.max(0, this.recordingDepth - 1);
    if (this.recordingDepth === 0) {
      this.clearRecording();
    }
  }

  ownsRecording(tabLabel: string): boolean {
    return this.recordingOwner === tabLabel;
  }

  private clearRecording(): void {
    this.recordingOwner = undefined;
    this.recordingDepth = 0;
    const finishRecording = this.finishRecording;
    this.recordingFinished = undefined;
    this.finishRecording = undefined;
    finishRecording?.();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function sharedAgentBrowserSessionFor(
  name: string | undefined,
): SharedAgentBrowserSession {
  const sessionName = name ?? DEFAULT_AGENT_BROWSER_SESSION;
  const existing = sharedAgentBrowserSessions.get(sessionName);
  if (existing) {
    return existing;
  }

  const session = new SharedAgentBrowserSession(sessionName);
  sharedAgentBrowserSessions.set(sessionName, session);
  return session;
}

export class AgentBrowserDriver implements BrowserDriver {
  private readonly command: string;
  private readonly timeoutMs: number;
  private startOptions?: BrowserStartOptions;
  private sharedSession?: SharedAgentBrowserSession;
  private retainedSharedSession = false;
  private closed = false;
  private lastKnownUrl?: string;

  constructor(options: AgentBrowserDriverOptions = {}) {
    this.command = options.command ?? "agent-browser";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async start(options: BrowserStartOptions): Promise<void> {
    this.startOptions = options;
    this.closed = false;
    this.retainedSharedSession = false;

    if (!options.tabLabel) {
      await this.applyBrowserEnvironment(options.browserEnvironment);
      return;
    }

    this.sharedSession = sharedAgentBrowserSessionFor(options.sessionName);
    this.sharedSession.retain();
    this.retainedSharedSession = true;
    try {
      await this.sharedSession.runForTab(options.tabLabel, () =>
        this.execWithRetry(
          ["tab", "new", "--label", options.tabLabel as string],
          `Opened shared browser tab ${options.tabLabel}`,
          1,
        ),
      );
      if (options.browserEnvironment) {
        await this.sharedSession.runForTab(options.tabLabel, async () => {
          await this.selectSharedTab(options.tabLabel as string);
          await this.applyBrowserEnvironment(options.browserEnvironment);
        });
      }
    } catch (error) {
      this.retainedSharedSession = false;
      const sharedSession = this.sharedSession;
      this.sharedSession = undefined;
      await sharedSession.release(() =>
        this.exec(["close"], "Closed shared browser session")
          .then(() => undefined)
          .catch(() => undefined),
      );
      throw error;
    }
  }

  async startRecording(path: string): Promise<BrowserCommandResult> {
    return this.run(
      ["record", "start", path],
      `Started browser recording at ${path}`,
    );
  }

  async stopRecording(): Promise<BrowserCommandResult> {
    const sharedSession = this.sharedSession;
    const tabLabel = this.startOptions?.tabLabel;
    if (sharedSession && tabLabel && !sharedSession.ownsRecording(tabLabel)) {
      return {
        summary: "Browser recording already stopped",
      };
    }

    try {
      return await this.run(["record", "stop"], "Stopped browser recording");
    } catch (error) {
      if (isNoRecordingInProgressError(error)) {
        return {
          summary: "Browser recording already stopped",
        };
      }
      throw error;
    }
  }

  async open(url: string): Promise<BrowserCommandResult> {
    const options = this.assertStarted();
    assertUrlAllowed(url, options.allowedOrigins);
    const result = await this.run(["open", url], `Opened ${url}`);
    this.lastKnownUrl = url;
    return result;
  }

  async snapshot(
    options: SnapshotOptions = {},
  ): Promise<BrowserCommandResult<{ path?: string }>> {
    const args = ["snapshot"];
    if (options.interactive ?? true) {
      args.push("-i");
    }
    if (options.compact) {
      args.push("-c");
    }
    if (options.selector) {
      if (options.selector.startsWith("@")) {
        args.push(options.selector);
      } else {
        args.push("-s", options.selector);
      }
    }

    const result = await this.run(args, "Captured browser snapshot");
    if (options.savePath) {
      await writeFile(
        options.savePath,
        redactTextArtifactContent(result.stdout ?? ""),
        "utf8",
      );
    }

    return {
      ...result,
      details: { path: options.savePath },
    };
  }

  async click(target: string): Promise<BrowserCommandResult> {
    return this.run(["click", target], `Clicked ${target}`);
  }

  async scrollIntoView(target: string): Promise<BrowserCommandResult> {
    return this.run(["scrollintoview", target], `Scrolled ${target} into view`);
  }

  async scroll(options: ScrollOptions): Promise<BrowserCommandResult> {
    const amount = options.amount ?? 500;
    const args = ["scroll", options.direction, String(amount)];
    if (options.target) {
      args.push("--selector", options.target);
    }
    return this.run(
      args,
      options.target
        ? `Scrolled ${options.target} ${options.direction} ${amount}px`
        : `Scrolled ${options.direction} ${amount}px`,
    );
  }

  async hover(target: string): Promise<BrowserCommandResult> {
    return this.run(["hover", target], `Hovered ${target}`);
  }

  async dragAndDrop(options: {
    source: string;
    target: string;
  }): Promise<BrowserCommandResult> {
    return this.run(
      ["drag", options.source, options.target],
      `Dragged ${options.source} to ${options.target}`,
    );
  }

  async upload(options: {
    target: string;
    files: string[];
  }): Promise<BrowserCommandResult> {
    if (options.files.length === 0) {
      throw new Error("Upload requires at least one file.");
    }
    return this.run(
      ["upload", options.target, ...options.files],
      `Uploaded ${options.files.length} file(s) to ${options.target}`,
    );
  }

  async download(options: {
    target: string;
    path: string;
  }): Promise<BrowserCommandResult<{ path: string }>> {
    const result = await this.run(
      ["download", options.target, options.path],
      `Downloaded from ${options.target} to ${options.path}`,
    );
    return { ...result, details: { path: options.path } };
  }

  async fill(target: string, value: string): Promise<BrowserCommandResult> {
    return this.run(["fill", target, value], `Filled ${target}`);
  }

  async type(target: string, value: string): Promise<BrowserCommandResult> {
    return this.run(["type", target, value], `Typed into ${target}`);
  }

  async press(key: string): Promise<BrowserCommandResult> {
    return this.run(["press", key], `Pressed ${key}`);
  }

  async wait(options: WaitOptions): Promise<BrowserCommandResult> {
    if (options.kind === "duration") {
      return this.run(["wait", String(options.ms)], `Waited ${options.ms}ms`);
    }
    if (options.kind === "load") {
      return this.run(
        ["wait", "--load", options.state],
        `Waited for ${options.state}`,
      );
    }
    if (options.kind === "text") {
      return this.run(
        ["wait", "--text", options.text],
        `Waited for text "${options.text}"`,
      );
    }
    if (options.kind === "url") {
      return this.run(
        ["wait", "--url", options.pattern],
        `Waited for URL ${options.pattern}`,
      );
    }

    return this.run(
      ["wait", options.selector],
      `Waited for selector ${options.selector}`,
    );
  }

  async screenshot(
    options: ScreenshotOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    const args = ["screenshot"];
    if (options.full) {
      args.push("--full");
    }
    if (options.annotate) {
      args.push("--annotate");
    }
    args.push(options.path);

    const result = await this.run(args, `Captured screenshot ${options.path}`);
    return {
      ...result,
      details: { path: options.path },
    };
  }

  async captureConsole(
    options: ConsoleCaptureOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    const source = options.source ?? "all";
    const sections: string[] = [];

    if (source === "all" || source === "console") {
      const result = await this.run(
        ["console"],
        "Captured browser console logs",
      );
      sections.push(formatEvidenceSection("Console Logs", result));
    }

    if (source === "all" || source === "errors") {
      const result = await this.run(["errors"], "Captured browser page errors");
      sections.push(formatEvidenceSection("Page Errors", result));
    }

    await writeTextArtifact(options.path, sections.join("\n\n"));

    if (options.clear) {
      if (source === "all" || source === "console") {
        await this.run(
          ["console", "--clear"],
          "Cleared browser console logs",
        ).catch(() => undefined);
      }
      if (source === "all" || source === "errors") {
        await this.run(
          ["errors", "--clear"],
          "Cleared browser page errors",
        ).catch(() => undefined);
      }
    }

    return {
      summary: `Captured console evidence ${options.path}`,
      details: { path: options.path },
    };
  }

  async captureNetwork(
    options: NetworkCaptureOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    const args = ["network", "requests"];
    if (options.filter) {
      args.push("--filter", options.filter);
    }
    if (options.resourceTypes && options.resourceTypes.length > 0) {
      args.push("--type", options.resourceTypes.join(","));
    }
    if (options.method) {
      args.push("--method", options.method);
    }
    if (options.status) {
      args.push("--status", options.status);
    }

    const result = await this.run(args, "Captured browser network requests");
    await writeTextArtifact(options.path, result.stdout ?? "");

    if (options.clear) {
      await this.run(
        ["network", "requests", "--clear"],
        "Cleared browser network request log",
      ).catch(() => undefined);
    }

    return {
      summary: `Captured network evidence ${options.path}`,
      stdout: result.stdout,
      stderr: result.stderr,
      details: { path: options.path },
    };
  }

  async startNetworkRecording(): Promise<BrowserCommandResult> {
    return this.run(
      ["network", "har", "start"],
      "Started browser network HAR recording",
    );
  }

  async stopNetworkRecording(
    options: NetworkRecordingOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    await mkdir(dirname(options.path), { recursive: true });
    const result = await this.run(
      ["network", "har", "stop", options.path],
      `Stopped browser network HAR recording ${options.path}`,
    );
    await redactTextArtifact(options.path);
    return {
      ...result,
      details: { path: options.path },
    };
  }

  async captureDomSnapshot(
    options: DomSnapshotOptions,
  ): Promise<BrowserCommandResult<{ path: string }>> {
    const result = await this.run(
      ["eval", buildDomSnapshotScript(options.maxElements ?? 250)],
      "Captured DOM snapshot",
    );
    const snapshot = parseEvalJson<unknown>(result.stdout ?? "");
    await writeTextArtifact(
      options.savePath,
      snapshot && typeof snapshot === "object"
        ? JSON.stringify(snapshot, null, 2)
        : (result.stdout ?? ""),
    );
    return {
      ...result,
      details: { path: options.savePath },
    };
  }

  async startUiChangeObservation(
    options: UiChangeObservationOptions = {},
  ): Promise<BrowserCommandResult<UiChangeObservation>> {
    const result = await this.run(
      ["eval", buildUiChangeObserverStartScript(options)],
      "Started UI change observation",
    );
    return {
      ...result,
      details:
        parseEvalJson<UiChangeObservation>(result.stdout ?? "") ??
        emptyUiChangeObservation(),
    };
  }

  async readUiChangeObservation(): Promise<
    BrowserCommandResult<UiChangeObservation>
  > {
    const result = await this.run(
      ["eval", UI_CHANGE_OBSERVER_READ_SCRIPT],
      "Read UI change observation",
    );
    return {
      ...result,
      details:
        parseEvalJson<UiChangeObservation>(result.stdout ?? "") ??
        emptyUiChangeObservation(),
    };
  }

  async stopUiChangeObservation(): Promise<
    BrowserCommandResult<UiChangeObservation>
  > {
    const result = await this.run(
      ["eval", UI_CHANGE_OBSERVER_STOP_SCRIPT],
      "Stopped UI change observation",
    );
    return {
      ...result,
      details:
        parseEvalJson<UiChangeObservation>(result.stdout ?? "") ??
        emptyUiChangeObservation(),
    };
  }

  async getElementBox(
    selector: string,
  ): Promise<BrowserCommandResult<ElementBox>> {
    const result = await this.run(
      ["get", "box", selector],
      `Read box for ${selector}`,
    );
    const details = parseElementBox(result.stdout ?? "");
    if (!details) {
      throw new Error(`Could not parse element box for ${selector}.`);
    }

    return { ...result, details };
  }

  async getViewport(): Promise<BrowserCommandResult<ViewportSize>> {
    const script =
      "JSON.stringify({width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio})";
    const result = await this.run(["eval", script], "Read viewport size");
    const details = parseViewportSize(result.stdout ?? "");
    if (!details) {
      throw new Error("Could not parse viewport size.");
    }

    return { ...result, details };
  }

  async getUrl(): Promise<string> {
    const result = await this.run(["get", "url"], "Read current URL");
    const url = (result.stdout ?? "").trim();
    if (url) {
      assertUrlAllowed(url, this.startOptions?.allowedOrigins ?? []);
      this.lastKnownUrl = url;
    }
    return url;
  }

  async getTitle(): Promise<string> {
    const result = await this.run(["get", "title"], "Read page title");
    return (result.stdout ?? "").trim();
  }

  async close(): Promise<void> {
    if (!this.startOptions) {
      return;
    }
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.startOptions.tabLabel && this.sharedSession) {
      const tabLabel = this.startOptions.tabLabel;
      if (this.sharedSession.ownsRecording(tabLabel)) {
        await this.sharedSession.runForTab(
          tabLabel,
          () => this.exec(["record", "stop"], "Stopped browser recording"),
          { stopsRecording: true },
        ).catch(() => undefined);
      }
      await this.sharedSession
        .runForTab(tabLabel, () =>
          this.exec(["tab", "close", tabLabel], `Closed browser tab ${tabLabel}`),
        )
        .catch(() => undefined);
      if (this.retainedSharedSession) {
        this.retainedSharedSession = false;
        await this.sharedSession.release(() =>
          this.exec(["close"], "Closed shared browser session")
            .then(() => undefined)
            .catch(() => undefined),
        );
      }
      return;
    }

    await this.exec(["close"], "Closed browser").catch(() => undefined);
  }

  private async run(
    args: string[],
    summary: string,
  ): Promise<BrowserCommandResult> {
    this.assertStarted();

    const sharedSession = this.sharedSession;
    const tabLabel = this.startOptions?.tabLabel;
    if (sharedSession && tabLabel) {
      const recordingOptions = sharedRunOptionsFor(args);
      if (isSharedSessionLevelCommand(args)) {
        return sharedSession.runForTab(
          tabLabel,
          () => this.exec(args, summary),
          recordingOptions,
        );
      }
      return sharedSession.runForTab(
        tabLabel,
        () => this.runInSharedTabWithRecovery(tabLabel, args, summary),
        recordingOptions,
      );
    }

    return this.exec(args, summary);
  }

  private async runInSharedTabWithRecovery(
    tabLabel: string,
    args: string[],
    summary: string,
  ): Promise<BrowserCommandResult> {
    try {
      await this.selectSharedTab(tabLabel);
      return await this.exec(args, summary);
    } catch (error) {
      if (!isMissingTabError(error)) {
        throw error;
      }

      try {
        await this.reopenSharedTab(tabLabel);
        await this.selectSharedTab(tabLabel);
        return await this.exec(args, summary);
      } catch (recoveryError) {
        throw new Error(
          [
            "agent-browser shared tab recovery failed",
            `original failure:\n${messageFromError(error)}`,
            `recovery failure:\n${messageFromError(recoveryError)}`,
          ].join("\n"),
        );
      }
    }
  }

  private async selectSharedTab(tabLabel: string): Promise<BrowserCommandResult> {
    return this.exec(["tab", tabLabel], `Selected browser tab ${tabLabel}`);
  }

  private async reopenSharedTab(tabLabel: string): Promise<void> {
    await this.execWithRetry(
      ["tab", "new", "--label", tabLabel],
      `Reopened shared browser tab ${tabLabel}`,
      1,
    );

    const restoreUrl = this.lastKnownUrl ?? this.startOptions?.baseUrl;
    if (!restoreUrl) {
      return;
    }

    assertUrlAllowed(restoreUrl, this.startOptions?.allowedOrigins ?? []);
    await this.exec(["open", restoreUrl], `Restored ${restoreUrl}`);
    this.lastKnownUrl = restoreUrl;
  }

  private async exec(
    args: string[],
    summary: string,
  ): Promise<BrowserCommandResult> {
    this.assertStarted();

    const fullArgs = [...this.globalArgs(), ...args];
    try {
      const { stdout, stderr } = await execFileAsync(this.command, fullArgs, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        summary: redactSensitiveText(summary),
        stdout: redactSensitiveText(stdout.toString()),
        stderr: redactSensitiveText(stderr.toString()),
      };
    } catch (error) {
      throw new Error(
        redactSensitiveText(formatExecFailure(this.command, fullArgs, error)),
      );
    }
  }

  private async execWithRetry(
    args: string[],
    summary: string,
    retries: number,
  ): Promise<BrowserCommandResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.exec(args, summary);
      } catch (error) {
        lastError = error;
        if (attempt >= retries) {
          break;
        }
        await delay(TAB_NEW_RETRY_DELAY_MS);
      }
    }

    throw lastError;
  }

  private async applyBrowserEnvironment(
    environment: BrowserEnvironment | undefined,
  ): Promise<void> {
    if (!environment) {
      return;
    }

    if (environment.device) {
      const deviceName = AGENT_BROWSER_DEVICE_NAMES[environment.device];
      await this.exec(
        ["set", "device", deviceName],
        `Set browser device ${environment.device}`,
      );
    }

    if (environment.viewport) {
      const args = [
        "set",
        "viewport",
        String(environment.viewport.width),
        String(environment.viewport.height),
      ];
      if (environment.viewport.deviceScaleFactor !== undefined) {
        args.push(String(environment.viewport.deviceScaleFactor));
      }
      await this.exec(
        args,
        `Set browser viewport ${environment.viewport.width}x${environment.viewport.height}`,
      );
    }
  }

  private globalArgs(): string[] {
    const options = this.assertStarted();
    const args: string[] = [];
    if (options.sessionName) {
      args.push("--session", options.sessionName);
    }
    if (options.statePath) {
      args.push("--state", options.statePath);
    }
    if (options.headed) {
      args.push("--headed");
    }
    return args;
  }

  private assertStarted(): BrowserStartOptions {
    if (!this.startOptions) {
      throw new Error("Browser driver has not been started.");
    }
    return this.startOptions;
  }
}

function isSharedSessionLevelCommand(args: string[]): boolean {
  return args[0] === "record" && args[1] === "stop";
}

function sharedRunOptionsFor(args: string[]): SharedRunOptions {
  if (args[0] === "record" && args[1] === "start") {
    return { startsRecording: true };
  }
  if (args[0] === "record" && args[1] === "stop") {
    return { stopsRecording: true };
  }
  if (args[0] === "network" && args[1] === "har" && args[2] === "start") {
    return { startsRecording: true };
  }
  if (args[0] === "network" && args[1] === "har" && args[2] === "stop") {
    return { stopsRecording: true };
  }
  return {};
}

function isNoRecordingInProgressError(error: unknown): boolean {
  return /no recording in progress/i.test(messageFromError(error));
}

function isMissingTabError(error: unknown): boolean {
  const message = messageFromError(error);
  return /no tab with label/i.test(message) || /tab .*not found/i.test(message);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatExecFailure(
  command: string,
  args: string[],
  error: unknown,
): string {
  const executable = `${command} ${args.join(" ")}`;
  if (!isExecError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return `agent-browser command failed: ${executable}\n${message}`;
  }

  const details = [
    `agent-browser command failed: ${executable}`,
    error.message ? `message: ${error.message}` : undefined,
    error.code !== undefined ? `exit code: ${String(error.code)}` : undefined,
    error.signal ? `signal: ${String(error.signal)}` : undefined,
    textFromExecOutput(error.stdout)
      ? `stdout:\n${textFromExecOutput(error.stdout)}`
      : undefined,
    textFromExecOutput(error.stderr)
      ? `stderr:\n${textFromExecOutput(error.stderr)}`
      : undefined,
  ];

  return details.filter((detail): detail is string => Boolean(detail)).join("\n");
}

function isExecError(error: unknown): error is Error & {
  code?: number | string;
  signal?: NodeJS.Signals | string;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
} {
  return typeof error === "object" && error !== null && error instanceof Error;
}

function textFromExecOutput(value: Buffer | string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return value.toString().trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeTextArtifact(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const redacted = redactTextArtifactContent(content);
  await writeFile(
    path,
    redacted.endsWith("\n") ? redacted : `${redacted}\n`,
    "utf8",
  );
}

async function redactTextArtifact(path: string): Promise<void> {
  await writeTextArtifact(path, await readFile(path, "utf8"));
}

function formatEvidenceSection(
  title: string,
  result: BrowserCommandResult,
): string {
  return [
    `# ${title}`,
    result.stdout?.trim() || "(no output)",
    result.stderr?.trim() ? `\n## stderr\n${result.stderr.trim()}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function parseElementBox(stdout: string): ElementBox | undefined {
  const value = parseLooseJson(stdout);
  return normalizeBox(
    findObjectWithNumbers(value, ["x", "y", "width", "height"]),
  );
}

function parseViewportSize(stdout: string): ViewportSize | undefined {
  const value = parseLooseJson(stdout);
  const viewport = findObjectWithNumbers(value, ["width", "height"]);
  if (!viewport) {
    return undefined;
  }

  return {
    width: viewport.width,
    height: viewport.height,
    ...(typeof viewport.deviceScaleFactor === "number"
      ? { deviceScaleFactor: viewport.deviceScaleFactor }
      : {}),
  };
}

function normalizeBox(
  value: Record<string, number> | undefined,
): ElementBox | undefined {
  if (!value) {
    return undefined;
  }

  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

function findObjectWithNumbers(
  value: unknown,
  keys: string[],
): (Record<string, number> & { deviceScaleFactor?: number }) | undefined {
  if (typeof value === "string") {
    return findObjectWithNumbers(parseLooseJson(value), keys);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectWithNumbers(item, keys);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (keys.every((key) => typeof record[key] === "number")) {
    return record as Record<string, number> & { deviceScaleFactor?: number };
  }

  for (const nested of Object.values(record)) {
    const found = findObjectWithNumbers(nested, keys);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function parseLooseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
}

function parseEvalJson<T>(stdout: string): T | undefined {
  const value = parseLooseJson(stdout);
  const parsed = typeof value === "string" ? parseLooseJson(value) : value;
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  return parsed as T;
}

function emptyUiChangeObservation(): UiChangeObservation {
  return {
    active: false,
    url: "",
    elapsedMs: 0,
    lastChangeAgeMs: 0,
    changes: [],
  };
}

function buildDomSnapshotScript(maxElements: number): string {
  return String.raw`(() => {
  const maxElements = ${JSON.stringify(maxElements)};
  const signalSelector = [
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "dialog",
    "[role]",
    "[aria-live]",
    "[aria-busy]",
    "[aria-disabled]",
    "[disabled]",
    "[hidden]",
    "[open]",
    "[data-testid]",
    "[data-test]",
    "[data-cy]",
    "li",
    "tr",
    "article",
    "form",
    "[class*=\"toast\" i]",
    "[class*=\"alert\" i]",
    "[class*=\"banner\" i]",
    "[class*=\"dialog\" i]",
    "[class*=\"modal\" i]",
    "[class*=\"notification\" i]",
    "[class*=\"status\" i]"
  ].join(",");
  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const attrEscape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0 ||
      element.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const selectorFor = (element) => {
    if (element.id) {
      return "#" + cssEscape(element.id);
    }
    for (const attr of ["data-testid", "data-test", "data-cy", "name", "aria-label"]) {
      const value = element.getAttribute(attr);
      if (value) {
        return element.tagName.toLowerCase() + "[" + attr + "=\"" + attrEscape(value) + "\"]";
      }
    }
    const parts = [];
    let current = element;
    while (current && current !== document.body && current !== document.documentElement && parts.length < 5) {
      const tag = current.tagName.toLowerCase();
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const roleFor = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "dialog") return "dialog";
    if (tag === "input" || tag === "textarea" || tag === "select") return "form-control";
    if (tag === "li") return "listitem";
    if (tag === "tr") return "row";
    return undefined;
  };
  const attrsFor = (element) => {
    const attrs = {};
    for (const name of ["id", "class", "role", "aria-label", "aria-live", "aria-busy", "aria-disabled", "disabled", "hidden", "open", "data-testid", "data-test", "data-cy"]) {
      if (element.hasAttribute(name)) {
        attrs[name] = element.getAttribute(name);
      }
    }
    return attrs;
  };
  const boxFor = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  };
  const elements = [];
  for (const element of Array.from(document.querySelectorAll(signalSelector))) {
    if (elements.length >= maxElements) {
      break;
    }
    if (!visible(element)) {
      continue;
    }
    elements.push({
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      role: roleFor(element),
      text: normalizeText(element.innerText || element.textContent || element.getAttribute("aria-label") || ""),
      attributes: attrsFor(element),
      boundingBox: boxFor(element)
    });
  }
  return JSON.stringify({
    schemaVersion: "0.1",
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    elementCount: elements.length,
    elements
  }, null, 2);
})()`;
}

function buildUiChangeObserverStartScript(
  options: UiChangeObservationOptions,
): string {
  const serializedOptions = JSON.stringify({
    maxChanges: options.maxChanges ?? 80,
  });

  return String.raw`(() => {
  const options = ${serializedOptions};
  const existing = window.__journeytestUiChangeObserver;
  if (existing && typeof existing.stop === "function") {
    existing.stop();
  }

  const maxChanges = Number.isFinite(options.maxChanges) ? options.maxChanges : 80;
  const startedAt = performance.now();
  const state = {
    active: true,
    changes: [],
    fingerprints: new Set(),
    observedRoots: new WeakSet(),
    lastChangeAt: startedAt,
    lastUrl: location.href,
    seenText: new Map(),
    seenAttrs: new Map(),
  };
  const signalSelector = [
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "option",
    "summary",
    "dialog",
    "[role]",
    "[aria-live]",
    "[aria-busy]",
    "[aria-disabled]",
    "[disabled]",
    "[hidden]",
    "[open]",
    "[data-testid]",
    "[data-test]",
    "[data-cy]",
    "li",
    "tr",
    "article",
    "form",
    "[class*=\"toast\" i]",
    "[class*=\"alert\" i]",
    "[class*=\"banner\" i]",
    "[class*=\"dialog\" i]",
    "[class*=\"modal\" i]",
    "[class*=\"notification\" i]",
    "[class*=\"status\" i]"
  ].join(",");
  const interestingAttributeNames = [
    "disabled",
    "aria-disabled",
    "aria-busy",
    "aria-live",
    "aria-hidden",
    "role",
    "hidden",
    "open",
    "checked",
    "selected",
    "style",
    "class"
  ];

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const attrEscape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);

  const isElement = (value) => value && value.nodeType === Node.ELEMENT_NODE;
  const asElement = (value) => {
    if (isElement(value)) {
      return value;
    }
    return value && value.parentElement ? value.parentElement : null;
  };
  const visible = (element) => {
    if (!element || !element.isConnected) {
      return false;
    }
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0 ||
      element.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const boundingBox = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  const roleFor = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button") {
      return "button";
    }
    if (tag === "a" && element.hasAttribute("href")) {
      return "link";
    }
    if (tag === "dialog") {
      return "dialog";
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return "form-control";
    }
    if (tag === "li") {
      return "listitem";
    }
    if (tag === "tr") {
      return "row";
    }
    return undefined;
  };
  const isSensitiveControl = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") {
      return false;
    }
    const haystack = [
      element.getAttribute("type"),
      element.getAttribute("name"),
      element.id,
      element.getAttribute("autocomplete"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder")
    ].join(" ");
    return /password|secret|token|api[-_ ]?key|credential|authorization/i.test(haystack);
  };
  const textFor = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (isSensitiveControl(element)) {
        return element.value ? "(value present)" : "";
      }
      return normalizeText(element.value || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "");
    }
    return normalizeText(element.innerText || element.textContent || element.getAttribute("aria-label") || "");
  };
  const selectorFor = (element) => {
    if (!element || !element.tagName) {
      return undefined;
    }
    if (element.id) {
      return "#" + cssEscape(element.id);
    }
    for (const attr of ["data-testid", "data-test", "data-cy", "name", "aria-label"]) {
      const value = element.getAttribute(attr);
      if (value) {
        return element.tagName.toLowerCase() + "[" + attr + "=\"" + attrEscape(value) + "\"]";
      }
    }

    const parts = [];
    let current = element;
    while (current && current !== document.body && current !== document.documentElement && parts.length < 5) {
      const tag = current.tagName.toLowerCase();
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const matchesSignal = (element) => {
    if (!element || !element.matches) {
      return false;
    }
    try {
      return element.matches(signalSelector);
    } catch {
      return false;
    }
  };
  const closestSignal = (node) => {
    let element = asElement(node);
    while (element && element !== document.documentElement) {
      if (matchesSignal(element)) {
        return element;
      }
      if (element === document.body) {
        return null;
      }
      element = element.parentElement;
    }
    return null;
  };
  const interestingAttrs = (element) => {
    const attrs = {};
    for (const name of interestingAttributeNames) {
      if (element.hasAttribute(name)) {
        attrs[name] = element.getAttribute(name);
      }
    }
    return attrs;
  };
  const changedAttrs = (selector, attrs) => {
    const previous = state.seenAttrs.get(selector) || {};
    const changed = {};
    for (const name of new Set([...Object.keys(previous), ...Object.keys(attrs)])) {
      const before = Object.prototype.hasOwnProperty.call(previous, name) ? previous[name] : null;
      const after = Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      if (before !== after) {
        changed[name] = after;
      }
    }
    return Object.keys(changed).length > 0 ? changed : undefined;
  };
  const remember = (element) => {
    if (!element) {
      return;
    }
    const selector = selectorFor(element);
    if (!selector) {
      return;
    }
    state.seenText.set(selector, textFor(element));
    state.seenAttrs.set(selector, interestingAttrs(element));
  };
  const rememberInitialElements = (root = document) => {
    if (!root || !root.querySelectorAll) {
      return;
    }
    for (const element of Array.from(root.querySelectorAll(signalSelector)).slice(0, 400)) {
      if (visible(element)) {
        remember(element);
      }
    }
  };
  const record = (kind, element, extra = {}) => {
    if (state.changes.length >= maxChanges) {
      return;
    }
    const selector = element ? selectorFor(element) : undefined;
    const text = element ? textFor(element) : undefined;
    const role = element ? roleFor(element) : undefined;
    const attrs = extra.attributes;
    if ((kind === "added" || kind === "text") && !text && !role) {
      return;
    }
    if (element && kind !== "removed" && kind !== "url" && !visible(element)) {
      return;
    }
    const change = {
      index: state.changes.length + 1,
      elapsedMs: elapsedMs(),
      kind,
      ...(selector ? { selector } : {}),
      ...(role ? { role } : {}),
      ...(text ? { text } : {}),
      ...(extra.previousText ? { previousText: extra.previousText } : {}),
      ...(attrs ? { attributes: attrs } : {}),
      ...(element ? { boundingBox: boundingBox(element), visible: visible(element) } : {}),
    };
    const fingerprint = JSON.stringify([
      change.kind,
      change.selector,
      change.text,
      change.previousText,
      change.attributes,
    ]);
    if (state.fingerprints.has(fingerprint)) {
      return;
    }
    state.fingerprints.add(fingerprint);
    state.changes.push(change);
    state.lastChangeAt = performance.now();
  };
  const inspectElement = (input, hint) => {
    const element = matchesSignal(asElement(input)) ? asElement(input) : closestSignal(input);
    if (!element) {
      return;
    }
    const selector = selectorFor(element);
    if (!selector) {
      return;
    }
    const text = textFor(element);
    const previousText = state.seenText.get(selector);
    const attrs = interestingAttrs(element);
    const attrDiff = changedAttrs(selector, attrs);

    if (previousText !== undefined && text && previousText !== text) {
      record("text", element, { previousText });
    } else if (hint === "added" && visible(element)) {
      record("added", element);
    }

    if (attrDiff && (roleFor(element) || text || matchesSignal(element))) {
      record("state", element, { attributes: attrDiff });
    }
    remember(element);
  };
  const inspectAdded = (node) => {
    const element = asElement(node);
    if (!element) {
      return;
    }
    observeNestedRoots(element);
    inspectElement(element, "added");
    if (element.querySelectorAll) {
      for (const child of Array.from(element.querySelectorAll(signalSelector)).slice(0, 20)) {
        inspectElement(child, "added");
      }
    }
  };
  const recordRemoved = (node) => {
    const element = asElement(node);
    if (!element) {
      return;
    }
    const signal = matchesSignal(element) ? element : element.querySelector?.(signalSelector);
    if (!signal) {
      return;
    }
    const text = textFor(signal);
    if (text || roleFor(signal)) {
      record("removed", signal);
    }
  };
  const checkUrl = () => {
    if (location.href !== state.lastUrl) {
      const previousText = state.lastUrl;
      state.lastUrl = location.href;
      record("url", null, { previousText, attributes: { url: location.href } });
    }
  };

  const observer = new MutationObserver((mutations) => {
    checkUrl();
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of Array.from(mutation.addedNodes)) {
          inspectAdded(node);
        }
        for (const node of Array.from(mutation.removedNodes)) {
          recordRemoved(node);
        }
      } else if (mutation.type === "characterData") {
        inspectElement(mutation.target, "text");
      } else if (mutation.type === "attributes") {
        inspectElement(mutation.target, "attributes");
      }
    }
  });
  const observeRoot = (root) => {
    const target = root && root.documentElement ? root.documentElement : root;
    if (!target || state.observedRoots.has(target)) {
      return;
    }
    try {
      observer.observe(target, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: interestingAttributeNames,
      });
      state.observedRoots.add(target);
      rememberInitialElements(root);
    } catch {
      // Cross-origin frames and closed roots are intentionally inaccessible.
    }
  };
  const observeSameOriginFrame = (iframe) => {
    try {
      if (iframe.contentDocument?.documentElement) {
        observeRoot(iframe.contentDocument);
      }
    } catch {
      // Cross-origin frame.
    }
  };
  const observeNestedRoots = (root) => {
    const element = asElement(root);
    if (!element) {
      return;
    }
    if (element.shadowRoot) {
      observeRoot(element.shadowRoot);
      observeNestedRoots(element.shadowRoot);
    }
    if (element.tagName?.toLowerCase() === "iframe") {
      observeSameOriginFrame(element);
      element.addEventListener("load", () => observeSameOriginFrame(element), { once: true });
    }
    if (element.querySelectorAll) {
      for (const child of Array.from(element.querySelectorAll("*")).slice(0, 500)) {
        if (child.shadowRoot) {
          observeRoot(child.shadowRoot);
        }
        if (child.tagName?.toLowerCase() === "iframe") {
          observeSameOriginFrame(child);
          child.addEventListener("load", () => observeSameOriginFrame(child), { once: true });
        }
      }
    }
  };

  const onFocus = (event) => {
    const element = asElement(event.target);
    if (element) {
      record("focus", element);
      remember(element);
    }
  };
  const onInput = (event) => {
    const element = asElement(event.target);
    if (element) {
      record("input", element);
      remember(element);
    }
  };
  const onRouteEvent = () => checkUrl();
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  const originalAttachShadow = Element.prototype.attachShadow;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    checkUrl();
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    checkUrl();
    return result;
  };
  Element.prototype.attachShadow = function (...args) {
    const shadowRoot = originalAttachShadow.apply(this, args);
    observeRoot(shadowRoot);
    return shadowRoot;
  };

  observeRoot(document);
  observeNestedRoots(document.body);
  window.addEventListener("focusin", onFocus, true);
  window.addEventListener("input", onInput, true);
  window.addEventListener("change", onInput, true);
  window.addEventListener("hashchange", onRouteEvent);
  window.addEventListener("popstate", onRouteEvent);

  const api = {
    snapshot(activeOverride) {
      checkUrl();
      return JSON.stringify({
        active: activeOverride === undefined ? state.active : Boolean(activeOverride),
        url: location.href,
        elapsedMs: elapsedMs(),
        lastChangeAgeMs: Math.max(0, Math.round(performance.now() - state.lastChangeAt)),
        changes: state.changes,
      });
    },
    stop() {
      if (!state.active) {
        return this.snapshot(false);
      }
      state.active = false;
      observer.disconnect();
      window.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("input", onInput, true);
      window.removeEventListener("change", onInput, true);
      window.removeEventListener("hashchange", onRouteEvent);
      window.removeEventListener("popstate", onRouteEvent);
      if (history.pushState !== originalPushState) {
        history.pushState = originalPushState;
      }
      if (history.replaceState !== originalReplaceState) {
        history.replaceState = originalReplaceState;
      }
      if (Element.prototype.attachShadow !== originalAttachShadow) {
        Element.prototype.attachShadow = originalAttachShadow;
      }
      return this.snapshot(false);
    },
  };
  window.__journeytestUiChangeObserver = api;
  return api.snapshot(true);
})()`;
}

const UI_CHANGE_OBSERVER_READ_SCRIPT = String.raw`(() => {
  const observer = window.__journeytestUiChangeObserver;
  if (!observer || typeof observer.snapshot !== "function") {
    return JSON.stringify({ active: false, url: location.href, elapsedMs: 0, lastChangeAgeMs: 0, changes: [] });
  }
  return observer.snapshot();
})()`;

const UI_CHANGE_OBSERVER_STOP_SCRIPT = String.raw`(() => {
  const observer = window.__journeytestUiChangeObserver;
  if (!observer || typeof observer.stop !== "function") {
    return JSON.stringify({ active: false, url: location.href, elapsedMs: 0, lastChangeAgeMs: 0, changes: [] });
  }
  return observer.stop();
})()`;
