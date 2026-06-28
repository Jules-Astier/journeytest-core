import { spawn } from "node:child_process";
import type { ScriptDataEnvironment } from "../core/schemas.js";
import {
  DataLifecycleProviderError,
  type DataLifecycleProvider,
  type DataLifecycleProviderContext,
  type DataLifecycleProviderResult,
} from "./types.js";

const defaultTimeoutMs = 30_000;
const maxBufferBytes = 10 * 1024 * 1024;

export class ScriptDataLifecycleProvider implements DataLifecycleProvider {
  readonly name = "script";

  async runOperation(
    context: DataLifecycleProviderContext,
  ): Promise<DataLifecycleProviderResult> {
    if (context.environment.provider !== "script") {
      throw new Error(
        `Script data lifecycle provider cannot run "${context.environment.provider}" environments.`,
      );
    }

    const environment = context.environment;
    const command = environment.command ?? context.operation.function;
    const commandArgs = scriptCommandArgs(environment, context);
    const stdin = scriptStdin(environment, context);
    const displayName = displayScriptCommand(command, environment, context);
    const result = await runScriptProcess(command, commandArgs, {
      cwd: environment.cwd ?? process.cwd(),
      env: { ...process.env, ...(environment.env ?? {}) },
      stdin,
      timeoutMs: environment.timeoutMs ?? defaultTimeoutMs,
      displayName,
    });

    if (result.exitCode !== 0 || result.signal) {
      throw new DataLifecycleProviderError(
        `Script data lifecycle command "${displayName}" exited with ${scriptExitStatus(result)}.`,
        {
          classification: "execution",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
        },
      );
    }

    return {
      result: parseScriptResult(result.stdout),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
}

function scriptCommandArgs(
  environment: ScriptDataEnvironment,
  context: DataLifecycleProviderContext,
): string[] {
  const args = [...(environment.commandArgs ?? [])];
  if (environment.command) {
    args.push(context.operation.function);
  }
  if ((environment.passArgs ?? "json-argv") === "json-argv") {
    args.push(JSON.stringify(context.args ?? {}));
  }
  return args;
}

function scriptStdin(
  environment: ScriptDataEnvironment,
  context: DataLifecycleProviderContext,
): string | undefined {
  return (environment.passArgs ?? "json-argv") === "json-stdin"
    ? JSON.stringify(context.args ?? {})
    : undefined;
}

interface ScriptProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  displayName: string;
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

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

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
          new DataLifecycleProviderError(
            `Script data lifecycle command "${options.displayName}" exceeded ${maxBufferBytes} bytes of output.`,
            {
              classification: "execution",
              stdout,
              stderr,
            },
          ),
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.on("error", (error) => {
      rejectOnce(
        new DataLifecycleProviderError(
          `Could not start script data lifecycle command "${options.displayName}": ${error.message}`,
          {
            classification: "configuration",
            stdout,
            stderr,
            cause: error,
          },
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const exitCode = code ?? 0;
      if (timedOut) {
        reject(
          new DataLifecycleProviderError(
            `Script data lifecycle command "${options.displayName}" timed out after ${options.timeoutMs}ms.`,
            {
              classification: "execution",
              stdout,
              stderr,
              exitCode,
              signal: signal ?? undefined,
            },
          ),
        );
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode,
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

function displayScriptCommand(
  command: string,
  environment: ScriptDataEnvironment,
  context: DataLifecycleProviderContext,
): string {
  const args = [...(environment.commandArgs ?? [])];
  if (environment.command) {
    args.push(context.operation.function);
  }
  if ((environment.passArgs ?? "json-argv") === "json-argv") {
    args.push("<json-args>");
  }
  return [command, ...args].join(" ");
}
