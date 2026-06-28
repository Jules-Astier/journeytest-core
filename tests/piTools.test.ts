import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPiBrowserTools } from "../src/directors/pi/tools.js";
import type {
  BrowserCommandResult,
  BrowserDriver,
  BrowserStartOptions,
  ElementBox,
  ScreenshotOptions,
  SnapshotOptions,
  UiChangeObservation,
  UiChangeObservationOptions,
  ViewportSize,
  WaitOptions,
} from "../src/drivers/types.js";
import { TesterProfileSchema, UserJourneySchema } from "../src/core/schemas.js";
import { EventRecorder } from "../src/runner/events.js";

class UiChangeFakeBrowserDriver implements BrowserDriver {
  clicked = false;
  screenshots: string[] = [];
  observationStarted = false;

  async start(_options: BrowserStartOptions): Promise<void> {}

  async startRecording(_path: string): Promise<BrowserCommandResult> {
    return { summary: "Started recording" };
  }

  async stopRecording(): Promise<BrowserCommandResult> {
    return { summary: "Stopped recording" };
  }

  async open(url: string): Promise<BrowserCommandResult> {
    return { summary: `Opened ${url}` };
  }

  async snapshot(
    options: SnapshotOptions = {},
  ): Promise<BrowserCommandResult<{ path?: string }>> {
    if (options.savePath) {
      await writeFile(options.savePath, '@save [button] "Save"\n', "utf8");
    }
    return { summary: "Snapshot", details: { path: options.savePath } };
  }

  async scrollIntoView(target: string): Promise<BrowserCommandResult> {
    return { summary: `Scrolled ${target}` };
  }

  async scroll(): Promise<BrowserCommandResult> {
    return { summary: "Scrolled" };
  }

  async click(target: string): Promise<BrowserCommandResult> {
    this.clicked = true;
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
    this.screenshots.push(options.path);
    await writeFile(options.path, "fake png", "utf8");
    return {
      summary: `Screenshot ${options.path}`,
      details: { path: options.path },
    };
  }

  async startUiChangeObservation(
    _options?: UiChangeObservationOptions,
  ): Promise<BrowserCommandResult<UiChangeObservation>> {
    this.observationStarted = true;
    return {
      summary: "Started UI change observation",
      details: this.observation([]),
    };
  }

  async readUiChangeObservation(): Promise<
    BrowserCommandResult<UiChangeObservation>
  > {
    return {
      summary: "Read UI change observation",
      details: this.observation(this.clicked ? [this.savedChange()] : []),
    };
  }

  async stopUiChangeObservation(): Promise<
    BrowserCommandResult<UiChangeObservation>
  > {
    this.observationStarted = false;
    return {
      summary: "Stopped UI change observation",
      details: this.observation(this.clicked ? [this.savedChange()] : []),
    };
  }

  async getElementBox(): Promise<BrowserCommandResult<ElementBox>> {
    return {
      summary: "Box",
      details: { x: 10, y: 20, width: 80, height: 30 },
    };
  }

  async getViewport(): Promise<BrowserCommandResult<ViewportSize>> {
    return { summary: "Viewport", details: { width: 800, height: 600 } };
  }

  async getUrl(): Promise<string> {
    return "http://127.0.0.1:3000/settings";
  }

  async getTitle(): Promise<string> {
    return "Settings";
  }

  async close(): Promise<void> {}

  private savedChange() {
    return {
      index: 1,
      elapsedMs: 40,
      kind: "text",
      selector: "button",
      role: "button",
      previousText: "Save",
      text: "Saved",
      boundingBox: { x: 10, y: 20, width: 80, height: 30 },
      visible: true,
    };
  }

  private observation(
    changes: UiChangeObservation["changes"],
  ): UiChangeObservation {
    return {
      active: this.observationStarted,
      url: "http://127.0.0.1:3000/settings",
      elapsedMs: 900,
      lastChangeAgeMs: 500,
      changes,
    };
  }
}

describe("createPiBrowserTools", () => {
  it("records UI change artifacts around click actions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "journeytest-tools-"));
    const screenshotsDir = join(tempDir, "screenshots");
    const snapshotsDir = join(tempDir, "snapshots");
    const consoleDir = join(tempDir, "console");
    const networkDir = join(tempDir, "network");
    const uiChangesDir = join(tempDir, "ui-changes");
    await Promise.all(
      [screenshotsDir, snapshotsDir, consoleDir, networkDir, uiChangesDir].map(
        (dir) => mkdir(dir, { recursive: true }),
      ),
    );

    const journey = UserJourneySchema.parse(
      JSON.parse(
        await readFile("examples/journeys/admin-invite-user.json", "utf8"),
      ),
    );
    const profile = TesterProfileSchema.parse(
      JSON.parse(await readFile("examples/profiles/admin.json", "utf8")),
    );
    const driver = new UiChangeFakeBrowserDriver();
    const recorder = new EventRecorder({
      eventsPath: join(tempDir, "events.ndjson"),
      startedAt: new Date(),
    });
    const tools = createPiBrowserTools(
      {
        journey,
        profile,
        browser: driver,
        recorder,
        artifacts: {
          runDir: tempDir,
          screenshotsDir,
          snapshotsDir,
          consoleDir,
          networkDir,
          uiChangesDir,
        },
        uiChangeRecording: true,
      },
      {},
    );

    const clickTool = tools.find((tool) => tool.name === "browser_click");
    if (!clickTool) {
      throw new Error("browser_click tool was not registered.");
    }

    const result = await clickTool.execute("tool-1", { target: "@save" });
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("UI changes saved:");
    expect(result.content[0]?.text).toContain("evidence.uiChangeTimeline");

    const uiChangeFiles = await readdir(uiChangesDir);
    expect(uiChangeFiles).toHaveLength(1);
    const artifact = JSON.parse(
      await readFile(join(uiChangesDir, uiChangeFiles[0] ?? ""), "utf8"),
    );
    expect(artifact.actionKind).toBe("click");
    expect(artifact.businessStateChanged).toBe(true);
    expect(artifact.changeCount).toBe(1);
    expect(artifact.significantChangeCount).toBe(1);
    expect(artifact.changes[0]).toMatchObject({
      kind: "text",
      previousText: "Save",
      text: "Saved",
      significance: "medium",
      group: "content",
    });
    expect(artifact.significantChanges[0]).toMatchObject({
      summary: 'button changed from "Save" to "Saved"',
    });
    expect(artifact.screenshots.before).toContain("-before.png");
    expect(artifact.screenshots.changes[0]).toContain("-change-001.png");
    expect(artifact.screenshots.after).toContain("-after.png");
    expect(artifact.snapshots.before).toContain("-before.txt");
    expect(artifact.snapshots.after).toContain("-after.txt");

    const eventTypes = recorder.timeline.map((event) => event.type);
    expect(eventTypes.indexOf("browser.click")).toBeLessThan(
      eventTypes.indexOf("browser.ui_changes"),
    );
  });
});
