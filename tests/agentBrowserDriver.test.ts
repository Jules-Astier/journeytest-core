import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentBrowserDriver } from "../src/drivers/agent-browser/index.js";

const allowedOrigins = ["http://127.0.0.1:3000"];

describe("AgentBrowserDriver shared tabs", () => {
  it("creates a labeled tab and switches to it before browser commands", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand();
    const driver = new AgentBrowserDriver({ command });

    await driver.start({
      runId: "run-1",
      runDir: "/tmp/run-1",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins,
      sessionName: "suite-shared-tabs",
      tabLabel: "journey-01-admin",
    });
    await driver.open("http://127.0.0.1:3000");
    await driver.screenshot({ path: "/tmp/run-1/screenshot.png" });
    await driver.close();

    expect(await readCommandLog(logPath)).toEqual([
      [
        "--session",
        "suite-shared-tabs",
        "tab",
        "new",
        "--label",
        "journey-01-admin",
      ],
      ["--session", "suite-shared-tabs", "tab", "journey-01-admin"],
      ["--session", "suite-shared-tabs", "open", "http://127.0.0.1:3000"],
      ["--session", "suite-shared-tabs", "tab", "journey-01-admin"],
      [
        "--session",
        "suite-shared-tabs",
        "screenshot",
        "/tmp/run-1/screenshot.png",
      ],
      ["--session", "suite-shared-tabs", "tab", "close", "journey-01-admin"],
      ["--session", "suite-shared-tabs", "close"],
    ]);
  });

  it("retries shared tab creation once after a transient agent-browser failure", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand({
      failTabNewTimes: 1,
    });
    const driver = new AgentBrowserDriver({ command });

    await driver.start({
      runId: "run-retry-tab",
      runDir: "/tmp/run-retry-tab",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins,
      sessionName: "suite-retry-tab",
      tabLabel: "journey-retry-tab",
    });
    await driver.close();

    const calls = await readCommandLog(logPath);
    expect(
      calls.filter(
        (args) =>
          args[2] === "tab" &&
          args[3] === "new" &&
          args[4] === "--label" &&
          args[5] === "journey-retry-tab",
      ),
    ).toHaveLength(2);
  });

  it("recovers a missing shared tab after start and restores the last URL", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand({
      failTabSelectLabels: ["journey-recover-after-start"],
    });
    const driver = new AgentBrowserDriver({ command });

    await driver.start({
      runId: "run-recover-after-start",
      runDir: "/tmp/run-recover-after-start",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins,
      sessionName: "suite-recover-after-start",
      tabLabel: "journey-recover-after-start",
    });
    await driver.open("http://127.0.0.1:3000/current");
    await driver.screenshot({ path: "/tmp/run-recover-after-start/after.png" });
    await driver.close();

    expect(await readCommandLog(logPath)).toEqual([
      [
        "--session",
        "suite-recover-after-start",
        "tab",
        "new",
        "--label",
        "journey-recover-after-start",
      ],
      ["--session", "suite-recover-after-start", "tab", "journey-recover-after-start"],
      [
        "--session",
        "suite-recover-after-start",
        "tab",
        "new",
        "--label",
        "journey-recover-after-start",
      ],
      ["--session", "suite-recover-after-start", "open", "http://127.0.0.1:3000"],
      ["--session", "suite-recover-after-start", "tab", "journey-recover-after-start"],
      ["--session", "suite-recover-after-start", "open", "http://127.0.0.1:3000/current"],
      ["--session", "suite-recover-after-start", "tab", "journey-recover-after-start"],
      [
        "--session",
        "suite-recover-after-start",
        "screenshot",
        "/tmp/run-recover-after-start/after.png",
      ],
      [
        "--session",
        "suite-recover-after-start",
        "tab",
        "close",
        "journey-recover-after-start",
      ],
      ["--session", "suite-recover-after-start", "close"],
    ]);
  });

  it("retries the original shared-tab action after missing-tab recovery", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand({
      failTabSelectLabels: ["journey-retry-action"],
    });
    const driver = new AgentBrowserDriver({ command });

    await driver.start({
      runId: "run-retry-action",
      runDir: "/tmp/run-retry-action",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins,
      sessionName: "suite-retry-action",
      tabLabel: "journey-retry-action",
    });
    await driver.click("@continue");
    await driver.close();

    const calls = await readCommandLog(logPath);
    expect(calls.filter((args) => args.includes("@continue"))).toEqual([
      ["--session", "suite-retry-action", "click", "@continue"],
    ]);
    const recoveredTabSelectIndex = calls.reduce(
      (lastIndex, args, index) =>
        args[2] === "tab" && args[3] === "journey-retry-action"
          ? index
          : lastIndex,
      -1,
    );
    const clickIndex = calls.findIndex((args) => args.includes("@continue"));
    expect(recoveredTabSelectIndex).toBeGreaterThanOrEqual(0);
    expect(clickIndex).toBeGreaterThan(recoveredTabSelectIndex);
  });

  it("includes command stdout and stderr when shared tab creation fails", async () => {
    const { command } = await createStubAgentBrowserCommand({
      failTabNewTimes: 2,
    });
    const driver = new AgentBrowserDriver({ command });

    await expect(
      driver.start({
        runId: "run-failed-tab",
        runDir: "/tmp/run-failed-tab",
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins,
        sessionName: "suite-failed-tab",
        tabLabel: "journey-failed-tab",
      }),
    ).rejects.toThrow(
      /agent-browser command failed: .*tab new --label journey-failed-tab[\s\S]*stdout:[\s\S]*tab setup started[\s\S]*stderr:[\s\S]*tab new failed/,
    );
  });

  it("stops recording without selecting the tab first", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand();
    const driver = new AgentBrowserDriver({ command });

    await driver.start({
      runId: "run-record-stop",
      runDir: "/tmp/run-record-stop",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins,
      sessionName: "suite-record-stop-session-command",
      tabLabel: "journey-record-stop",
    });

    await driver.startRecording("/tmp/run-record-stop/video.webm");
    await driver.stopRecording();
    await driver.close();

    const calls = await readCommandLog(logPath);
    const recordStopIndex = calls.findIndex(
      (args) => args[2] === "record" && args[3] === "stop",
    );

    expect(recordStopIndex).toBeGreaterThanOrEqual(0);
    expect(calls[recordStopIndex]).toEqual([
      "--session",
      "suite-record-stop-session-command",
      "record",
      "stop",
    ]);
    expect(calls[recordStopIndex - 1]).not.toEqual([
      "--session",
      "suite-record-stop-session-command",
      "tab",
      "journey-record-stop",
    ]);
  });

  it("releases the local recording lock when record stop fails", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand({
      failRecordStopTimes: 1,
    });
    const sessionName = "suite-failed-record-stop-lock";
    const first = new AgentBrowserDriver({ command });
    const second = new AgentBrowserDriver({ command });

    await Promise.all([
      first.start({
        runId: "run-fail-stop-a",
        runDir: "/tmp/run-fail-stop-a",
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins,
        sessionName,
        tabLabel: "journey-fail-stop-a",
      }),
      second.start({
        runId: "run-fail-stop-b",
        runDir: "/tmp/run-fail-stop-b",
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins,
        sessionName,
        tabLabel: "journey-fail-stop-b",
      }),
    ]);

    await first.startRecording("/tmp/run-fail-stop-a/video.webm");
    await expect(first.stopRecording()).rejects.toThrow();

    await expect(second.open("http://127.0.0.1:3000/b")).resolves.toMatchObject({
      summary: "Opened http://127.0.0.1:3000/b",
    });
    await expect(first.stopRecording()).resolves.toMatchObject({
      summary: "Browser recording already stopped",
    });
    await Promise.all([first.close(), second.close()]);

    const calls = await readCommandLog(logPath);
    expect(
      calls.filter((args) => args[2] === "record" && args[3] === "stop"),
    ).toHaveLength(1);
  });

  it("treats record stop as idempotent when no shared recording is active", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand();
    const driver = new AgentBrowserDriver({ command });

    await driver.start({
      runId: "run-no-recording",
      runDir: "/tmp/run-no-recording",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins,
      sessionName: "suite-no-recording",
      tabLabel: "journey-no-recording",
    });

    await expect(driver.stopRecording()).resolves.toMatchObject({
      summary: "Browser recording already stopped",
    });
    await driver.close();

    const calls = await readCommandLog(logPath);
    expect(
      calls.filter((args) => args[2] === "record" && args[3] === "stop"),
    ).toHaveLength(0);
  });

  it("holds other shared tabs while one tab has an active recording", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand();
    const sessionName = "suite-recording-lock";
    const first = new AgentBrowserDriver({ command });
    const second = new AgentBrowserDriver({ command });

    await Promise.all([
      first.start({
        runId: "run-a",
        runDir: "/tmp/run-a",
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins,
        sessionName,
        tabLabel: "journey-a",
      }),
      second.start({
        runId: "run-b",
        runDir: "/tmp/run-b",
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins,
        sessionName,
        tabLabel: "journey-b",
      }),
    ]);

    await first.startRecording("/tmp/run-a/video.webm");
    await first.startNetworkRecording();
    const blockedOpen = second
      .open("http://127.0.0.1:3000/b")
      .then(() => "opened");

    await expect(
      Promise.race([blockedOpen, delay(25).then(() => "blocked")]),
    ).resolves.toBe("blocked");

    await first.stopNetworkRecording({ path: "/tmp/run-a/network.har" });
    await expect(
      Promise.race([blockedOpen, delay(25).then(() => "blocked")]),
    ).resolves.toBe("blocked");

    await first.stopRecording();
    await expect(blockedOpen).resolves.toBe("opened");
    await Promise.all([first.close(), second.close()]);

    const calls = await readCommandLog(logPath);
    const recordStartIndex = calls.findIndex(
      (args) => args[2] === "record" && args[3] === "start",
    );
    const recordStopIndex = calls.findIndex(
      (args) => args[2] === "record" && args[3] === "stop",
    );
    const secondOpenIndex = calls.findIndex((args) =>
      args.includes("http://127.0.0.1:3000/b"),
    );

    expect(recordStartIndex).toBeGreaterThanOrEqual(0);
    expect(recordStopIndex).toBeGreaterThan(recordStartIndex);
    expect(secondOpenIndex).toBeGreaterThan(recordStopIndex);
  });

  it("counts queued shared starts before tab creation completes", async () => {
    const { command, logPath } = await createStubAgentBrowserCommand({
      delayedTabLabel: "journey-queued-b",
      delayedTabMs: 100,
    });
    const sessionName = "suite-queued-start-retain";
    const first = new AgentBrowserDriver({ command });
    const second = new AgentBrowserDriver({ command });

    await first.start({
      runId: "run-queued-a",
      runDir: "/tmp/run-queued-a",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins,
      sessionName,
      tabLabel: "journey-queued-a",
    });

    const secondStart = second.start({
      runId: "run-queued-b",
      runDir: "/tmp/run-queued-b",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins,
      sessionName,
      tabLabel: "journey-queued-b",
    });
    await waitForCommand(logPath, (args) =>
      args.includes("journey-queued-b"),
    );

    await first.close();
    await secondStart;
    await second.close();

    const calls = await readCommandLog(logPath);
    const secondTabNewIndex = calls.findIndex((args) =>
      args.includes("journey-queued-b"),
    );
    const firstTabCloseIndex = calls.findIndex(
      (args) =>
        args[2] === "tab" &&
        args[3] === "close" &&
        args[4] === "journey-queued-a",
    );
    const sessionCloseIndex = calls.findIndex(
      (args) => args[2] === "close",
    );

    expect(secondTabNewIndex).toBeGreaterThanOrEqual(0);
    expect(firstTabCloseIndex).toBeGreaterThan(secondTabNewIndex);
    expect(sessionCloseIndex).toBeGreaterThan(firstTabCloseIndex);
  });
});

interface StubAgentBrowserOptions {
  delayedTabLabel?: string;
  delayedTabMs?: number;
  failRecordStopTimes?: number;
  failTabSelectLabels?: string[];
  failTabNewTimes?: number;
}

async function createStubAgentBrowserCommand(): Promise<{
  command: string;
  logPath: string;
}>;
async function createStubAgentBrowserCommand(
  options: StubAgentBrowserOptions,
): Promise<{
  command: string;
  logPath: string;
}>;
async function createStubAgentBrowserCommand(
  options: StubAgentBrowserOptions = {},
): Promise<{
  command: string;
  logPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "journeytest-agent-browser-"));
  const command = join(dir, "agent-browser.cjs");
  const logPath = join(dir, "calls.ndjson");
  const statePath = join(dir, "state.json");
  await writeFile(
    command,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const statePath = ${JSON.stringify(statePath)};
const options = ${JSON.stringify(options)};
function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { recordStopFailures: 0, tabNewFailures: 0, tabSelectFailures: {} };
  }
}
function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state));
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
if (
  options.delayedTabLabel &&
  options.delayedTabMs &&
  args.at(-4) === "tab" &&
  args.at(-3) === "new" &&
  args.at(-2) === "--label" &&
  args.at(-1) === options.delayedTabLabel
) {
  sleep(options.delayedTabMs);
}
if (args.at(-4) === "tab" && args.at(-3) === "new" && args.at(-2) === "--label") {
  const state = readState();
  if (state.tabNewFailures < (options.failTabNewTimes ?? 0)) {
    state.tabNewFailures++;
    writeState(state);
    process.stdout.write("tab setup started\\n");
    process.stderr.write("tab new failed\\n");
    process.exit(1);
  }
}
if (args.at(-2) === "tab" && options.failTabSelectLabels?.includes(args.at(-1))) {
  const state = readState();
  state.tabSelectFailures ||= {};
  if (!state.tabSelectFailures[args.at(-1)]) {
    state.tabSelectFailures[args.at(-1)] = 1;
    writeState(state);
    process.stderr.write("No tab with label " + args.at(-1) + "\\n");
    process.exit(1);
  }
}
if (args.at(-2) === "record" && args.at(-1) === "stop") {
  const state = readState();
  if (state.recordStopFailures < (options.failRecordStopTimes ?? 0)) {
    state.recordStopFailures++;
    writeState(state);
    process.stderr.write("record stop failed\\n");
    process.exit(1);
  }
}
if (args.at(-2) === "get" && args.at(-1) === "url") {
  process.stdout.write("http://127.0.0.1:3000");
} else if (args.at(-2) === "get" && args.at(-1) === "title") {
  process.stdout.write("JourneyTest");
} else if (args.includes("snapshot")) {
  process.stdout.write('@e1 [button] "Continue"\\n');
} else if (args.includes("network") && args.includes("har") && args.includes("stop")) {
  writeFileSync(args.at(-1), '{"log":{"entries":[]}}\\n');
  process.stdout.write("ok\\n");
} else {
  process.stdout.write("ok\\n");
}
`,
    "utf8",
  );
  await chmod(command, 0o755);
  return { command, logPath };
}

async function readCommandLog(path: string): Promise<string[][]> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCommand(
  path: string,
  predicate: (args: string[]) => boolean,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if ((await readCommandLog(path)).some(predicate)) {
      return;
    }
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Timed out waiting for stub command.");
    }
    await delay(5);
  }
}
