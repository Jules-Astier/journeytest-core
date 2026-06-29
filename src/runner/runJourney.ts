import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDirector } from "../directors/types.js";
import type { UiChangeRecordingOptions } from "../directors/types.js";
import type { BrowserDriver } from "../drivers/types.js";
import { buildRawActionBookmarks } from "../core/bookmarks.js";
import {
  type AgentVerdict,
  type BrowserEnvironment,
  type DataEnvironment,
  type RunArtifacts,
  type RunResult,
  type TesterProfile,
  type UserJourney,
  type VideoBookmark,
} from "../core/schemas.js";
import type { BookmarkCurator } from "../curation/types.js";
import {
  assertNoValidationIssues,
  validateAllowedOrigins,
  validateAgentVerdictForJourney,
  validateJourneyProfileMatch,
} from "../core/validation.js";
import { renderHtmlDashboard } from "../reporters/dashboard.js";
import { renderMarkdownReport } from "../reporters/markdown.js";
import { allowedOriginsFor } from "../utils/url.js";
import { createRunDirectory } from "../utils/path.js";
import {
  redactSensitiveText,
  redactSensitiveValue,
  redactTextArtifactContent,
} from "../utils/redaction.js";
import { EventRecorder } from "./events.js";
import {
  DataLifecycleBlockedError,
  DataLifecycleController,
  type DataLifecycleProvider,
} from "../lifecycle/index.js";

export interface RunJourneyOptions {
  journey: UserJourney;
  profile: TesterProfile;
  driver: BrowserDriver;
  director: AgentDirector;
  outputDir: string;
  video?: boolean;
  sessionName?: string;
  tabLabel?: string;
  statePath?: string;
  headed?: boolean;
  browserEnvironment?: BrowserEnvironment;
  uiChangeRecording?: boolean;
  uiChangeRecordingOptions?: UiChangeRecordingOptions;
  bookmarkCurator?: BookmarkCurator;
  directorTimeoutMs?: number;
  dataLifecycle?: {
    environments: Record<string, DataEnvironment>;
    provider: DataLifecycleProvider;
    keepData?: boolean;
    suiteRunId?: string;
    suiteManifest?: unknown;
  };
}

export async function runJourney(
  options: RunJourneyOptions,
): Promise<RunResult> {
  const startedAt = new Date();
  assertNoValidationIssues([
    ...validateJourneyProfileMatch(options.journey, options.profile),
    ...validateAllowedOrigins(options.journey),
  ]);

  const { runId, runDir } = await createRunDirectory(
    options.outputDir,
    options.journey.id,
    startedAt,
  );

  const eventsPath = join(runDir, "events.ndjson");
  const dashboardPath = join(runDir, "dashboard.html");
  const reportPath = join(runDir, "report.md");
  const resultPath = join(runDir, "run.json");
  const videoPath = join(runDir, "video.webm");
  const screenshotsDir = join(runDir, "screenshots");
  const snapshotsDir = join(runDir, "snapshots");
  const consoleDir = join(runDir, "console");
  const networkDir = join(runDir, "network");
  const uiChangesDir = join(runDir, "ui-changes");
  const allowedOrigins = allowedOriginsFor(
    options.journey.app.baseUrl,
    options.journey.app.allowedOrigins,
  );
  const recorder = new EventRecorder({ eventsPath, startedAt });
  const browserEnvironment = mergeBrowserEnvironments(
    options.journey.browserEnvironment,
    options.browserEnvironment,
  );

  let verdict: AgentVerdict | undefined;
  let error: Error | undefined;
  let videoArtifactWritten = false;
  let recordingStarted = false;
  let driverStarted = false;
  let driverClosed = false;
  let lifecycleBlocked = false;
  let dataLifecycle: RunResult["dataLifecycle"];
  let dataLifecycleController: DataLifecycleController | undefined;

  try {
    await recorder.record(
      "journey.started",
      `Started journey ${options.journey.id}`,
      {
        journeyId: options.journey.id,
        testerProfileId: options.profile.id,
        browserEnvironment,
      },
    );

    if (options.journey.dataLifecycle) {
      if (!options.dataLifecycle) {
        throw new Error(
          `Journey "${options.journey.id}" declares dataLifecycle but no data lifecycle provider was configured.`,
        );
      }

      dataLifecycleController = new DataLifecycleController({
        definition: options.journey.dataLifecycle,
        environments: options.dataLifecycle.environments,
        provider: options.dataLifecycle.provider,
        scope: "journey",
        runId,
        runDir,
        suiteRunId: options.dataLifecycle.suiteRunId,
        journeyRunId: runId,
        journey: options.journey,
        profile: options.profile,
        suiteManifest: options.dataLifecycle.suiteManifest,
        keepData: options.dataLifecycle.keepData,
      });

      await recorder.record(
        "data_lifecycle.started",
        "Started journey data lifecycle",
        {
          environment: options.journey.dataLifecycle.environment,
          namespace: dataLifecycleController.result.namespace,
        },
      );

      await dataLifecycleController.runSetupAndPreflight();
      dataLifecycle = dataLifecycleController.result;
      await recorder.record(
        "data_lifecycle.preflight_passed",
        "Data lifecycle setup/preflight passed",
        {
          environment: dataLifecycle.environment,
          namespace: dataLifecycle.namespace,
        },
      );
    }

    await options.driver.start({
      runId,
      runDir,
      baseUrl: options.journey.app.baseUrl,
      allowedOrigins,
      sessionName: options.sessionName ?? runId,
      tabLabel: options.tabLabel,
      statePath: options.statePath,
      headed: options.headed,
      browserEnvironment,
    });
    driverStarted = true;

    try {
      if (options.video ?? true) {
        const startRecordingStartedAt = Date.now();
        await options.driver.startRecording(videoPath);
        recordingStarted = true;
        videoArtifactWritten = true;
        recorder.startVideoClock();
        await recorder.record("video.started", "Started video recording", {
          path: videoPath,
          startRecordingDurationMs: Date.now() - startRecordingStartedAt,
        });
      }

      const rawVerdict = await runDirectorWithTimeout({
        director: options.director,
        timeoutMs: options.directorTimeoutMs,
        context: {
          journey: options.journey,
          profile: options.profile,
          browser: options.driver,
          recorder,
          artifacts: {
            runDir,
            screenshotsDir,
            snapshotsDir,
            consoleDir,
            networkDir,
            uiChangesDir,
          },
          uiChangeRecording: options.uiChangeRecording ?? true,
          uiChangeRecordingOptions: options.uiChangeRecordingOptions,
        },
      });

      assertNoValidationIssues(
        validateAgentVerdictForJourney(options.journey, rawVerdict),
      );
      verdict = redactSensitiveValue(rawVerdict) as AgentVerdict;
      await recorder.record(
        "journey.completed",
        `Completed journey with verdict ${verdict.status}`,
        {
          verdictStatus: verdict.status,
        },
      );
    } finally {
      try {
        if (recordingStarted) {
          try {
            const stopRecordingStartedAt = Date.now();
            await options.driver.stopRecording();
            await recorder.record("video.stopped", "Stopped video recording", {
              path: videoPath,
              stopRecordingDurationMs: Date.now() - stopRecordingStartedAt,
            });
          } finally {
            recorder.stopVideoClock();
            recordingStarted = false;
          }
        }
      } finally {
        await options.driver.close();
        driverClosed = true;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
    lifecycleBlocked = error instanceof DataLifecycleBlockedError;
    await recorder.record(
      lifecycleBlocked ? "journey.blocked" : "journey.error",
      error.message,
      {
        stack: error.stack,
        lifecycleFailures:
          error instanceof DataLifecycleBlockedError
            ? error.results.map((result) => ({
                id: result.id,
                phase: result.phase,
                function: result.function,
                status: result.status,
                error: result.error?.message,
              }))
            : undefined,
      },
    );
  } finally {
    if (driverStarted && !driverClosed) {
      // The nested browser finally handles normal close. This is a guard for start/recording failures.
      await options.driver.close().catch(() => undefined);
    }
  }

  if (dataLifecycleController) {
    if (!lifecycleBlocked) {
      await dataLifecycleController.runPostconditions();
      const failedPostconditions =
        dataLifecycleController.result.postconditions.filter(
          (operation) => operation.status === "failed",
        );
      if (failedPostconditions.length > 0) {
        await recorder.record(
          "data_lifecycle.postconditions_failed",
          "Data lifecycle postconditions failed",
          {
            failed: failedPostconditions.map((operation) => ({
              id: operation.id,
              function: operation.function,
              error: operation.error?.message,
            })),
          },
        );
      } else {
        await recorder.record(
          "data_lifecycle.postconditions_passed",
          "Data lifecycle postconditions passed",
        );
      }
    }

    await dataLifecycleController.runCleanup();
    dataLifecycleController.finish();
    dataLifecycle = dataLifecycleController.result;

    const failedCleanup = dataLifecycle.cleanup.filter(
      (operation) => operation.status === "failed",
    );
    if (failedCleanup.length > 0) {
      await recorder.record(
        "data_lifecycle.cleanup_failed",
        "Data lifecycle cleanup failed",
        {
          failed: failedCleanup.map((operation) => ({
            id: operation.id,
            function: operation.function,
            error: operation.error?.message,
          })),
        },
      );
    } else if (options.dataLifecycle?.keepData) {
      await recorder.record(
        "data_lifecycle.cleanup_skipped",
        "Skipped data lifecycle cleanup because keepData is set",
      );
    } else {
      await recorder.record(
        "data_lifecycle.cleanup_completed",
        "Data lifecycle cleanup completed",
      );
    }
  }

  const snapshotArtifacts = await listFiles(snapshotsDir);
  const consoleArtifacts = await listFiles(consoleDir);
  const networkArtifacts = await listFiles(networkDir);
  const uiChangeArtifacts = await listFiles(uiChangesDir);
  await redactTextFiles([
    ...snapshotArtifacts,
    ...consoleArtifacts,
    ...networkArtifacts,
    ...uiChangeArtifacts,
  ]);

  const artifacts: RunArtifacts = {
    runDir,
    events: eventsPath,
    dashboard: dashboardPath,
    report: reportPath,
    result: resultPath,
    ...(videoArtifactWritten ? { video: videoPath } : {}),
    videoClips: [],
    screenshots: await listFiles(screenshotsDir),
    snapshots: snapshotArtifacts,
    console: consoleArtifacts,
    network: networkArtifacts,
    uiChanges: uiChangeArtifacts,
    ...(dataLifecycleController
      ? { dataLifecycle: dataLifecycleController.artifactPaths }
      : {}),
  };

  let bookmarks: VideoBookmark[] = buildRawActionBookmarks(recorder.timeline);
  const preliminaryEndedAt = new Date();
  const preliminaryResult: RunResult = {
    schemaVersion: "0.1",
    runId,
    journeyId: options.journey.id,
    testerProfileId: options.profile.id,
    runStatus: lifecycleBlocked ? "blocked" : error ? "error" : "completed",
    startedAt: startedAt.toISOString(),
    endedAt: preliminaryEndedAt.toISOString(),
    durationMs: Math.max(0, preliminaryEndedAt.getTime() - startedAt.getTime()),
    model: options.director.model,
    verdict,
    ...(error
      ? {
          error: {
            message: redactSensitiveText(error.message),
            stack: error.stack ? redactSensitiveText(error.stack) : undefined,
          },
        }
      : {}),
    bookmarks,
    ...(dataLifecycle ? { dataLifecycle } : {}),
    ...(browserEnvironment ? { browserEnvironment } : {}),
    artifacts,
    timeline: recorder.timeline,
  };

  if (options.bookmarkCurator) {
    await recorder.record(
      "bookmarks.curation.started",
      `Started bookmark curation with ${options.bookmarkCurator.name}`,
      {
        curator: options.bookmarkCurator.name,
        rawBookmarkCount: bookmarks.length,
      },
    );

    try {
      const curatedBookmarks = await options.bookmarkCurator.curate({
        result: {
          ...preliminaryResult,
          timeline: recorder.timeline,
          bookmarks,
        },
        journey: options.journey,
      });
      bookmarks = curatedBookmarks;
      await recorder.record(
        "bookmarks.curation.completed",
        `Curated ${bookmarks.length} video bookmark(s)`,
        {
          curator: options.bookmarkCurator.name,
          bookmarkCount: bookmarks.length,
        },
      );
    } catch (caught) {
      const curationError =
        caught instanceof Error ? caught : new Error(String(caught));
      await recorder.record(
        "bookmarks.curation_failed",
        curationError.message,
        {
          curator: options.bookmarkCurator.name,
          stack: curationError.stack,
        },
      );
    }
  }

  const endedAt = new Date();
  const result = redactSensitiveValue({
    ...preliminaryResult,
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    bookmarks,
    timeline: recorder.timeline,
  }) as RunResult;

  await recorder.flush();
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(reportPath, renderMarkdownReport(result), "utf8");
  await writeFile(
    dashboardPath,
    renderHtmlDashboard(result, {
      baseDir: runDir,
      snapshots: await readSnapshotFiles(artifacts.snapshots),
      console: await readTextArtifactFiles(artifacts.console),
      network: await readTextArtifactFiles(artifacts.network),
      uiChanges: await readTextArtifactFiles(artifacts.uiChanges),
    }),
    "utf8",
  );

  return result;
}

async function runDirectorWithTimeout(options: {
  director: AgentDirector;
  context: Omit<Parameters<AgentDirector["run"]>[0], "signal">;
  timeoutMs?: number;
}): Promise<AgentVerdict> {
  if (!options.timeoutMs) {
    return options.director.run(options.context);
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      options.director.run({
        ...options.context,
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new Error(
              `Journey director timed out after ${options.timeoutMs}ms.`,
            ),
          );
        }, options.timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    controller.abort();
  }
}

export function mergeBrowserEnvironments(
  defaults: BrowserEnvironment | undefined,
  overrides: BrowserEnvironment | undefined,
): BrowserEnvironment | undefined {
  const viewport = mergeViewportOptions(defaults?.viewport, overrides?.viewport);
  const environment: BrowserEnvironment = {
    ...(defaults ?? {}),
    ...(overrides ?? {}),
    ...(viewport ? { viewport } : {}),
  };

  return Object.keys(environment).length > 0 ? environment : undefined;
}

function mergeViewportOptions(
  defaults: BrowserEnvironment["viewport"] | undefined,
  overrides: BrowserEnvironment["viewport"] | undefined,
): BrowserEnvironment["viewport"] | undefined {
  if (!defaults && !overrides) {
    return undefined;
  }

  const width = overrides?.width ?? defaults?.width;
  const height = overrides?.height ?? defaults?.height;
  if (width === undefined || height === undefined) {
    return undefined;
  }

  const deviceScaleFactor = overrides?.deviceScaleFactor ?? defaults?.deviceScaleFactor;
  return {
    width,
    height,
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name))
    .sort();
}

async function readSnapshotFiles(paths: string[]) {
  return readTextArtifactFiles(paths, "Could not read snapshot");
}

async function redactTextFiles(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      const content = await readFile(path, "utf8");
      const redacted = redactTextArtifactContent(content);
      await writeFile(
        path,
        redacted.endsWith("\n") ? redacted : `${redacted}\n`,
        "utf8",
      );
    }),
  );
}

async function readTextArtifactFiles(
  paths: string[],
  errorPrefix = "Could not read artifact",
) {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      content: await readFile(path, "utf8").catch((error) =>
        error instanceof Error
          ? `${errorPrefix}: ${error.message}`
          : `${errorPrefix}.`,
      ),
    })),
  );
}
