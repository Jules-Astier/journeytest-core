#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const vitestBin = join(rootDir, "node_modules", "vitest", "vitest.mjs");

const options = parseArgs(process.argv.slice(2));

for (let run = 1; run <= options.runs; run += 1) {
  const started = performance.now();
  console.log(
    `\n[test-smoke] run ${run}/${options.runs}, timeout ${options.timeoutMs}ms`,
  );

  const result = await runVitest(options.timeoutMs);
  const elapsedMs = Math.round(performance.now() - started);

  if (result.timedOut) {
    console.error(
      `[test-smoke] run ${run} stalled after ${options.timeoutMs}ms`,
    );
    process.exit(124);
  }

  if (result.exitCode !== 0) {
    console.error(`[test-smoke] run ${run} failed after ${elapsedMs}ms`);
    process.exit(result.exitCode ?? 1);
  }

  console.log(`[test-smoke] run ${run} passed in ${elapsedMs}ms`);
}

console.log(`\n[test-smoke] ${options.runs} run(s) passed`);

function parseArgs(args) {
  let runs = 1;
  let timeoutMs = 30_000;

  for (const arg of args) {
    if (arg.startsWith("--runs=")) {
      runs = parsePositiveInteger(arg.slice("--runs=".length), "--runs");
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      timeoutMs = parsePositiveInteger(arg.slice("--timeout=".length), "--timeout");
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { runs, timeoutMs };
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function runVitest(timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [vitestBin, "run", "--reporter=verbose"],
      {
        cwd: rootDir,
        detached: true,
        stdio: "inherit",
      },
    );

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      terminateProcessGroup(child.pid);
      setTimeout(() => terminateProcessGroup(child.pid, "SIGKILL"), 2_000).unref();
      resolve({ exitCode: 124, timedOut: true });
    }, timeoutMs);

    child.on("exit", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: exitCode ?? (signal ? 1 : 0), timedOut: false });
    });
  });
}

function terminateProcessGroup(pid, signal = "SIGTERM") {
  if (!pid) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between the timeout and the signal.
    }
  }
}
