import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { AppTarget, DataLifecycleConfig } from "../core/schemas.js";

const defaultTimeoutMs = 30_000;
const maxBufferBytes = 10 * 1024 * 1024;

export type AppLifecycleConfig = NonNullable<
  DataLifecycleConfig["appLifecycle"]
>;
type AppLifecycleScript = AppLifecycleConfig["start"];

export interface AppLifecycleContext {
  suiteRunId: string;
  runDir: string;
  ports: Record<string, number>;
  hosts: Record<string, string>;
  app?: AppTarget;
}

export interface AppLifecycleExecution {
  schemaVersion: "0.1";
  status: "passed" | "failed" | "skipped";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  context: AppLifecycleContext;
  artifacts: {
    start: string;
    cleanup: string;
  };
  start?: AppLifecycleScriptResult;
  cleanup?: AppLifecycleScriptResult;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface AppLifecycleScriptResult {
  command: string;
  args: string[];
  status: "passed" | "failed" | "skipped";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string;
  result?: unknown;
  error?: {
    message: string;
    stack?: string;
  };
}

export class AppLifecycleController {
  readonly result: AppLifecycleExecution;

  private readonly startedAt = new Date();
  private cleanedUp = false;

  private constructor(
    private readonly config: AppLifecycleConfig,
    context: AppLifecycleContext,
  ) {
    this.result = {
      schemaVersion: "0.1",
      status: "passed",
      startedAt: this.startedAt.toISOString(),
      context,
      artifacts: {
        start: join(context.runDir, "start.json"),
        cleanup: join(context.runDir, "cleanup.json"),
      },
    };
  }

  static async create(options: {
    config: AppLifecycleConfig;
    suiteRunId: string;
    runDir: string;
  }): Promise<AppLifecycleController> {
    const { ports, hosts } = await allocateRequestedPorts(options.config);
    const controller = new AppLifecycleController(options.config, {
      suiteRunId: options.suiteRunId,
      runDir: options.runDir,
      ports,
      hosts,
    });
    controller.result.context.app = controller.resolveAppTarget();
    return controller;
  }

  get appTarget(): AppTarget | undefined {
    return this.result.context.app;
  }

  async runStart(): Promise<void> {
    await mkdir(this.result.context.runDir, { recursive: true });
    try {
      this.result.start = await runAppLifecycleScript(
        this.config.start,
        "start",
        this.result.context,
      );
      await writeJson(this.result.artifacts.start, this.result.start);
      const resultTarget = appTargetFromScriptResult(this.result.start.result);
      if (resultTarget) {
        this.result.context.app = mergeAppTargets(
          this.result.context.app,
          resultTarget,
        );
      }
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      this.result.status = "failed";
      this.result.error = {
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      };
      if (!this.result.start) {
        this.result.start = failedScriptResult(
          this.config.start,
          "start",
          error,
        );
        await writeJson(this.result.artifacts.start, this.result.start);
      }
      throw error;
    }
  }

  async runCleanup(): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;

    if (!this.config.cleanup) {
      this.result.cleanup = skippedScriptResult("cleanup");
      await writeJson(this.result.artifacts.cleanup, this.result.cleanup);
      this.finish();
      return;
    }

    try {
      this.result.cleanup = await runAppLifecycleScript(
        this.config.cleanup,
        "cleanup",
        this.result.context,
      );
      await writeJson(this.result.artifacts.cleanup, this.result.cleanup);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      this.result.status = "failed";
      this.result.error = {
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      };
      if (!this.result.cleanup) {
        this.result.cleanup = failedScriptResult(
          this.config.cleanup,
          "cleanup",
          error,
        );
        await writeJson(this.result.artifacts.cleanup, this.result.cleanup);
      }
    } finally {
      this.finish();
    }
  }

  finish(status = this.result.status): void {
    const endedAt = new Date();
    this.result.status = status;
    this.result.endedAt = endedAt.toISOString();
    this.result.durationMs = Math.max(
      0,
      endedAt.getTime() - this.startedAt.getTime(),
    );
  }

  private resolveAppTarget(): AppTarget | undefined {
    if (!this.config.app?.baseUrl) {
      return undefined;
    }

    const baseUrl = renderTemplate(this.config.app.baseUrl, this.result.context);
    return {
      name: "App under test",
      baseUrl,
      ...(this.config.app.allowedOrigins
        ? {
            allowedOrigins: this.config.app.allowedOrigins.map((origin) =>
              renderTemplate(origin, this.result.context),
            ),
          }
        : {}),
    };
  }
}

export function applyAppTargetOverride<T extends { app: AppTarget }>(
  journey: T,
  appTarget: AppTarget | undefined,
): T {
  if (!appTarget) {
    return journey;
  }

  return {
    ...journey,
    app: mergeAppTargets(journey.app, appTarget),
  };
}

async function allocateRequestedPorts(
  config: AppLifecycleConfig,
): Promise<{ ports: Record<string, number>; hosts: Record<string, string> }> {
  const ports: Record<string, number> = {};
  const hosts: Record<string, string> = {};

  for (const [name, request] of Object.entries(config.ports ?? {})) {
    const host = request.host;
    hosts[name] = host;
    ports[name] = await allocatePort(host);
  }

  return { ports, hosts };
}

async function allocatePort(host: string): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(`Could not allocate an unused port on ${host}.`);
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function runAppLifecycleScript(
  script: AppLifecycleScript,
  phase: "start" | "cleanup",
  context: AppLifecycleContext,
): Promise<AppLifecycleScriptResult> {
  const startedAt = new Date();
  const args = (script.commandArgs ?? []).map((arg) =>
    renderTemplate(arg, context),
  );
  if (script.passContext === "json-argv") {
    args.push(JSON.stringify({ phase, ...context }));
  }
  const stdin =
    script.passContext === "json-stdin"
      ? JSON.stringify({ phase, ...context })
      : undefined;
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(script.env ?? {}).map(([key, value]) => [
        key,
        renderTemplate(value, context),
      ]),
    ),
  };
  const processResult = await runScriptProcess(script.command, args, {
    cwd: script.cwd ?? process.cwd(),
    env,
    stdin,
    timeoutMs: script.timeoutMs ?? defaultTimeoutMs,
  });
  const endedAt = new Date();
  const result: AppLifecycleScriptResult = {
    command: script.command,
    args: displayArgs(args, script.passContext),
    status:
      processResult.exitCode === 0 && !processResult.signal ? "passed" : "failed",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    exitCode: processResult.exitCode,
    ...(processResult.signal ? { signal: processResult.signal } : {}),
    result: parseScriptResult(processResult.stdout),
  };

  if (result.status === "failed") {
    result.error = {
      message: `App lifecycle ${phase} command exited with ${scriptExitStatus(processResult)}.`,
    };
    throw new AppLifecycleScriptError(result.error.message, result);
  }

  return result;
}

interface ScriptProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
}

interface ScriptProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

async function runScriptProcess(
  command: string,
  args: string[],
  options: ScriptProcessOptions,
): Promise<ScriptProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    timeout.unref?.();

    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (target === "stdout") {
        stdout += value;
      } else {
        stderr += value;
      }
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBufferBytes) {
        child.kill("SIGTERM");
        rejectOnce(
          new Error(
            `App lifecycle command exceeded ${maxBufferBytes} bytes of output.`,
          ),
        );
      }
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.on("error", (error) => {
      rejectOnce(
        new Error(`Could not start app lifecycle command: ${error.message}`),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `App lifecycle command timed out after ${options.timeoutMs}ms.`,
          ),
        );
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        ...(signal ? { signal } : {}),
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

class AppLifecycleScriptError extends Error {
  constructor(
    message: string,
    readonly scriptResult: AppLifecycleScriptResult,
  ) {
    super(message);
    this.name = "AppLifecycleScriptError";
  }
}

function failedScriptResult(
  script: AppLifecycleScript,
  phase: "start" | "cleanup",
  error: Error,
): AppLifecycleScriptResult {
  if (error instanceof AppLifecycleScriptError) {
    return error.scriptResult;
  }
  const now = new Date().toISOString();
  return {
    command: script.command,
    args: displayArgs(script.commandArgs ?? [], script.passContext),
    status: "failed",
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    error: {
      message: `App lifecycle ${phase} failed: ${error.message}`,
      ...(error.stack ? { stack: error.stack } : {}),
    },
  };
}

function skippedScriptResult(phase: "cleanup"): AppLifecycleScriptResult {
  const now = new Date().toISOString();
  return {
    command: phase,
    args: [],
    status: "skipped",
    startedAt: now,
    endedAt: now,
    durationMs: 0,
  };
}

function appTargetFromScriptResult(
  result: unknown,
): Partial<AppTarget> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const value = result as {
    app?: unknown;
    baseUrl?: unknown;
    allowedOrigins?: unknown;
  };
  const app = (value.app && typeof value.app === "object"
    ? value.app
    : value) as {
    name?: unknown;
    baseUrl?: unknown;
    allowedOrigins?: unknown;
  };
  const target: Partial<AppTarget> = {};
  if (typeof app.name === "string") {
    target.name = app.name;
  }
  if (typeof app.baseUrl === "string") {
    target.baseUrl = app.baseUrl;
  }
  if (Array.isArray(app.allowedOrigins)) {
    target.allowedOrigins = app.allowedOrigins.filter(
      (origin): origin is string => typeof origin === "string",
    );
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

function mergeAppTargets(
  existing: AppTarget | undefined,
  override: Partial<AppTarget>,
): AppTarget {
  const baseUrl = override.baseUrl ?? existing?.baseUrl;
  if (!baseUrl) {
    throw new Error("App lifecycle target override requires app.baseUrl.");
  }
  return {
    name: override.name ?? existing?.name ?? "App under test",
    baseUrl,
    allowedOrigins: override.allowedOrigins ?? existing?.allowedOrigins,
  };
}

function renderTemplate(value: string, context: AppLifecycleContext): string {
  return value.replace(
    /\$ports\.([a-zA-Z0-9._-]+)|\$hosts\.([a-zA-Z0-9._-]+)/g,
    (match, portName, hostName) => {
      if (portName) {
        const port = context.ports[portName];
        if (port === undefined) {
          throw new Error(`Unknown app lifecycle port template "${match}".`);
        }
        return String(port);
      }
      const host = context.hosts[hostName];
      if (host === undefined) {
        throw new Error(`Unknown app lifecycle host template "${match}".`);
      }
      return host;
    },
  );
}

function displayArgs(
  args: string[],
  passContext: AppLifecycleScript["passContext"],
): string[] {
  if (passContext === "json-argv" && args.length > 0) {
    return [...args.slice(0, -1), "<json-context>"];
  }
  return args;
}

function parseScriptResult(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue looking for the last JSON line printed by the script.
      }
    }
  }

  return trimmed;
}

function scriptExitStatus(result: ScriptProcessResult): string {
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  return `status ${result.exitCode}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
