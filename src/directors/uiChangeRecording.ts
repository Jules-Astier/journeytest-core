import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BrowserDriver,
  UiChangeObservation,
  UiChangeRecord,
} from "../drivers/types.js";
import type { DirectorRunContext, UiChangeRecordingOptions } from "./types.js";
import { sanitizePathSegment } from "../utils/path.js";
import {
  redactSensitiveText,
  redactSensitiveValue,
} from "../utils/redaction.js";

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_QUIET_MS = 300;
const DEFAULT_MIN_WATCH_MS = 800;
const DEFAULT_POLL_MS = 150;
const DEFAULT_MAX_CHANGES = 80;
const DEFAULT_MAX_SCREENSHOTS = 3;

export interface UiChangeActionOptions {
  index: number;
  actionKind: string;
  target?: string;
  timeoutMs?: number;
  quietMs?: number;
}

export interface UiChangeArtifactSummary {
  path: string;
  actionKind: string;
  businessStateChanged: boolean;
  changeCount: number;
  screenshots: {
    before?: string;
    changes: string[];
    after?: string;
  };
  snapshots: {
    before?: string;
    after?: string;
  };
  domSnapshots: {
    before?: string;
    after?: string;
  };
  changes: UiChangeRecord[];
}

export interface UiChangeRecordingResult<T> {
  result: T;
  uiChanges?: UiChangeArtifactSummary;
}

export async function runWithUiChangeRecording<T>(
  context: DirectorRunContext,
  options: UiChangeActionOptions,
  action: () => Promise<T>,
): Promise<UiChangeRecordingResult<T>> {
  if (
    context.uiChangeRecording === false ||
    !supportsUiChangeObservation(context.browser)
  ) {
    return { result: await action() };
  }

  const recordingOptions = resolveRecordingOptions(
    context.uiChangeRecordingOptions,
    options,
  );
  const {
    timeoutMs,
    quietMs,
    minWatchMs,
    pollMs,
    maxChanges,
    maxScreenshots,
    screenshots,
    snapshots,
    domSnapshots,
  } = recordingOptions;
  const stem = uiChangeStem(options);
  const beforeUrl = await context.browser.getUrl().catch(() => undefined);
  const beforeTitle = await context.browser.getTitle().catch(() => undefined);
  const beforePath = join(
    context.artifacts.screenshotsDir,
    `${stem}-before.png`,
  );
  const beforeSnapshotPath = join(
    context.artifacts.snapshotsDir,
    `${stem}-before.txt`,
  );
  const beforeDomSnapshotPath = join(
    context.artifacts.snapshotsDir,
    `${stem}-before-dom.json`,
  );

  let wroteBefore = false;
  let wroteBeforeSnapshot = false;
  let wroteBeforeDomSnapshot = false;
  let observationStarted = false;

  if (screenshots) {
    try {
      await context.browser.screenshot({ path: beforePath, full: true });
      wroteBefore = true;
    } catch {
      // The timeline is still valuable when a baseline image cannot be captured.
    }
  }

  if (snapshots) {
    try {
      await context.browser.snapshot({
        interactive: true,
        compact: true,
        savePath: beforeSnapshotPath,
      });
      wroteBeforeSnapshot = true;
    } catch {
      // Keep going; snapshots are supporting evidence.
    }
  }

  if (domSnapshots && context.browser.captureDomSnapshot) {
    try {
      await context.browser.captureDomSnapshot({
        savePath: beforeDomSnapshotPath,
      });
      wroteBeforeDomSnapshot = true;
    } catch {
      // Keep going; DOM snapshots are supporting evidence.
    }
  }

  try {
    await context.browser.startUiChangeObservation({
      timeoutMs,
      quietMs,
      maxChanges,
    });
    observationStarted = true;
  } catch (error) {
    await removeIfWritten(wroteBefore ? beforePath : undefined);
    await removeIfWritten(wroteBeforeSnapshot ? beforeSnapshotPath : undefined);
    await removeIfWritten(
      wroteBeforeDomSnapshot ? beforeDomSnapshotPath : undefined,
    );
    await recordUiChangeFailure(context, "setup", error);
    return { result: await action() };
  }

  let result: T;
  try {
    result = await action();
  } catch (error) {
    await stopObservationQuietly(context.browser, observationStarted);
    await removeIfWritten(wroteBefore ? beforePath : undefined);
    await removeIfWritten(wroteBeforeSnapshot ? beforeSnapshotPath : undefined);
    await removeIfWritten(
      wroteBeforeDomSnapshot ? beforeDomSnapshotPath : undefined,
    );
    throw error;
  }

  const changeScreenshots: string[] = [];
  try {
    if (screenshots) {
      changeScreenshots.push(
        ...(await captureChangeScreenshots(
          context.browser,
          context.artifacts.screenshotsDir,
          stem,
          {
            timeoutMs,
            quietMs,
            minWatchMs,
            pollMs,
            maxScreenshots,
          },
        )),
      );
    } else {
      await waitForChanges(context.browser, {
        timeoutMs,
        quietMs,
        minWatchMs,
        pollMs,
      });
    }

    const finalObservation = await context.browser.stopUiChangeObservation();
    observationStarted = false;
    const observation = finalObservation.details ?? emptyObservation();
    const afterUrl = await context.browser
      .getUrl()
      .catch(() => observation.url || undefined);
    const afterTitle = await context.browser.getTitle().catch(() => undefined);
    const changes = withUrlChange(
      observation.changes ?? [],
      beforeUrl,
      afterUrl,
      observation.elapsedMs,
    ).map(enrichChange);
    const significantChanges = changes.filter(
      (change) => change.significance !== "low",
    );

    if (changes.length === 0) {
      await removeIfWritten(wroteBefore ? beforePath : undefined);
      await removeIfWritten(
        wroteBeforeSnapshot ? beforeSnapshotPath : undefined,
      );
      await removeIfWritten(
        wroteBeforeDomSnapshot ? beforeDomSnapshotPath : undefined,
      );
      return { result };
    }

    const afterPath = join(
      context.artifacts.screenshotsDir,
      `${stem}-after.png`,
    );
    let wroteAfter = false;
    if (screenshots) {
      try {
        await context.browser.screenshot({ path: afterPath, full: true });
        wroteAfter = true;
      } catch {
        // The JSON artifact is still useful without an after image.
      }
    }

    const afterSnapshotPath = join(
      context.artifacts.snapshotsDir,
      `${stem}-after.txt`,
    );
    let wroteAfterSnapshot = false;
    if (snapshots) {
      try {
        await context.browser.snapshot({
          interactive: true,
          compact: true,
          savePath: afterSnapshotPath,
        });
        wroteAfterSnapshot = true;
      } catch {
        // The JSON artifact is still useful without an after snapshot.
      }
    }

    const afterDomSnapshotPath = join(
      context.artifacts.snapshotsDir,
      `${stem}-after-dom.json`,
    );
    let wroteAfterDomSnapshot = false;
    if (domSnapshots && context.browser.captureDomSnapshot) {
      try {
        await context.browser.captureDomSnapshot({
          savePath: afterDomSnapshotPath,
        });
        wroteAfterDomSnapshot = true;
      } catch {
        // The JSON artifact is still useful without an after DOM snapshot.
      }
    }

    const artifactPath = join(context.artifacts.uiChangesDir, `${stem}.json`);
    const endedAt = new Date();
    const navigation = {
      beforeUrl,
      afterUrl,
      beforeTitle,
      afterTitle,
      changed: Boolean(beforeUrl && afterUrl && beforeUrl !== afterUrl),
      observerSurvived:
        observation.active === false && observation.elapsedMs > 0,
    };
    const businessStateChanged = hasBusinessStateChange(significantChanges);
    const artifact = redactSensitiveValue({
      schemaVersion: "0.1",
      actionKind: options.actionKind,
      businessStateChanged,
      action: {
        kind: options.actionKind,
        ...(options.target ? { target: options.target } : {}),
      },
      endedAt: endedAt.toISOString(),
      timeoutMs,
      quietMs,
      changeCount: changes.length,
      significantChangeCount: significantChanges.length,
      finalUrl: afterUrl ?? observation.url,
      navigation,
      groups: summarizeGroups(changes),
      screenshots: {
        ...(wroteBefore ? { before: beforePath } : {}),
        changes: changeScreenshots,
        ...(wroteAfter ? { after: afterPath } : {}),
      },
      snapshots: {
        ...(wroteBeforeSnapshot ? { before: beforeSnapshotPath } : {}),
        ...(wroteAfterSnapshot ? { after: afterSnapshotPath } : {}),
      },
      domSnapshots: {
        ...(wroteBeforeDomSnapshot ? { before: beforeDomSnapshotPath } : {}),
        ...(wroteAfterDomSnapshot ? { after: afterDomSnapshotPath } : {}),
      },
      changes,
      significantChanges,
    });

    await writeFile(
      artifactPath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
    const summary: UiChangeArtifactSummary = {
      path: artifactPath,
      actionKind: options.actionKind,
      businessStateChanged,
      changeCount: changes.length,
      screenshots: {
        ...(wroteBefore ? { before: beforePath } : {}),
        changes: changeScreenshots,
        ...(wroteAfter ? { after: afterPath } : {}),
      },
      snapshots: {
        ...(wroteBeforeSnapshot ? { before: beforeSnapshotPath } : {}),
        ...(wroteAfterSnapshot ? { after: afterSnapshotPath } : {}),
      },
      domSnapshots: {
        ...(wroteBeforeDomSnapshot ? { before: beforeDomSnapshotPath } : {}),
        ...(wroteAfterDomSnapshot ? { after: afterDomSnapshotPath } : {}),
      },
      changes,
    };

    await context.recorder.record(
      "browser.ui_changes",
      `Captured ${changes.length} UI change(s) after ${options.actionKind}`,
      {
        actionKind: options.actionKind,
        target: options.target,
        path: artifactPath,
        businessStateChanged,
        changeCount: changes.length,
        significantChangeCount: significantChanges.length,
        screenshots: summary.screenshots,
        snapshots: summary.snapshots,
        domSnapshots: summary.domSnapshots,
        navigation,
        groups: summarizeGroups(changes),
      },
    );

    return { result, uiChanges: summary };
  } catch (error) {
    await stopObservationQuietly(context.browser, observationStarted);
    await removeIfWritten(wroteBefore ? beforePath : undefined);
    await removeIfWritten(wroteBeforeSnapshot ? beforeSnapshotPath : undefined);
    await removeIfWritten(
      wroteBeforeDomSnapshot ? beforeDomSnapshotPath : undefined,
    );
    await Promise.all(changeScreenshots.map(removeIfWritten));
    await recordUiChangeFailure(context, "collect", error);
    return { result };
  }
}

export function formatUiChangeToolSuffix(
  uiChanges: UiChangeArtifactSummary | undefined,
): string {
  if (!uiChanges) {
    return "";
  }

  const snippets = uiChanges.changes
    .slice(0, 3)
    .map(
      (change) => change.text || change.role || change.selector || change.kind,
    )
    .filter(Boolean);
  const suffix = snippets.length > 0 ? ` (${snippets.join("; ")})` : "";
  return `\nUI changes saved: ${uiChanges.path}${suffix}\nUse this path as evidence.uiChangeTimeline when it supports a criterion.`;
}

function supportsUiChangeObservation(
  browser: BrowserDriver,
): browser is BrowserDriver &
  Required<
    Pick<
      BrowserDriver,
      | "startUiChangeObservation"
      | "readUiChangeObservation"
      | "stopUiChangeObservation"
    >
  > {
  return (
    typeof browser.startUiChangeObservation === "function" &&
    typeof browser.readUiChangeObservation === "function" &&
    typeof browser.stopUiChangeObservation === "function"
  );
}

function resolveRecordingOptions(
  contextOptions: UiChangeRecordingOptions | undefined,
  actionOptions: UiChangeActionOptions,
): Required<UiChangeRecordingOptions> {
  return {
    timeoutMs:
      actionOptions.timeoutMs ??
      contextOptions?.timeoutMs ??
      DEFAULT_TIMEOUT_MS,
    quietMs:
      actionOptions.quietMs ?? contextOptions?.quietMs ?? DEFAULT_QUIET_MS,
    minWatchMs: contextOptions?.minWatchMs ?? DEFAULT_MIN_WATCH_MS,
    pollMs: contextOptions?.pollMs ?? DEFAULT_POLL_MS,
    maxChanges: contextOptions?.maxChanges ?? DEFAULT_MAX_CHANGES,
    maxScreenshots: contextOptions?.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS,
    screenshots: contextOptions?.screenshots ?? true,
    snapshots: contextOptions?.snapshots ?? true,
    domSnapshots: contextOptions?.domSnapshots ?? true,
  };
}

async function captureChangeScreenshots(
  browser: Required<
    Pick<BrowserDriver, "readUiChangeObservation" | "screenshot">
  >,
  screenshotsDir: string,
  stem: string,
  options: {
    timeoutMs: number;
    quietMs: number;
    minWatchMs: number;
    pollMs: number;
    maxScreenshots: number;
  },
): Promise<string[]> {
  const screenshots: string[] = [];
  const startedAt = Date.now();
  let observedChangeCount = 0;

  while (Date.now() - startedAt < options.timeoutMs) {
    await delay(options.pollMs);
    const observation = await browser.readUiChangeObservation();
    const details = observation.details ?? emptyObservation();
    const changes = details.changes ?? [];

    if (changes.length > observedChangeCount) {
      observedChangeCount = changes.length;
      if (screenshots.length < options.maxScreenshots) {
        const screenshotPath = join(
          screenshotsDir,
          `${stem}-change-${String(screenshots.length + 1).padStart(3, "0")}.png`,
        );
        try {
          await browser.screenshot({ path: screenshotPath, full: true });
          screenshots.push(screenshotPath);
        } catch {
          // Keep observing; the JSON timeline still preserves the transient change.
        }
      }
    }

    const elapsedMs = Date.now() - startedAt;
    if (
      changes.length > 0 &&
      elapsedMs >= options.minWatchMs &&
      details.lastChangeAgeMs >= options.quietMs
    ) {
      break;
    }
  }

  return screenshots;
}

async function waitForChanges(
  browser: Required<Pick<BrowserDriver, "readUiChangeObservation">>,
  options: {
    timeoutMs: number;
    quietMs: number;
    minWatchMs: number;
    pollMs: number;
  },
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < options.timeoutMs) {
    await delay(options.pollMs);
    const observation = await browser.readUiChangeObservation();
    const details = observation.details ?? emptyObservation();
    const changes = details.changes ?? [];
    const elapsedMs = Date.now() - startedAt;
    if (
      changes.length > 0 &&
      elapsedMs >= options.minWatchMs &&
      details.lastChangeAgeMs >= options.quietMs
    ) {
      return;
    }
  }
}

async function stopObservationQuietly(
  browser: BrowserDriver,
  observationStarted: boolean,
): Promise<void> {
  if (!observationStarted || !browser.stopUiChangeObservation) {
    return;
  }

  await browser.stopUiChangeObservation().catch(() => undefined);
}

async function removeIfWritten(path: string | undefined): Promise<void> {
  if (!path) {
    return;
  }

  await unlink(path).catch(() => undefined);
}

async function recordUiChangeFailure(
  context: DirectorRunContext,
  phase: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await context.recorder.record(
    "browser.ui_changes_failed",
    redactSensitiveText(message),
    {
      phase,
    },
  );
}

function uiChangeStem(options: UiChangeActionOptions): string {
  const targetStem = options.target
    ? `-${sanitizePathSegment(options.target)}`
    : "";
  return `${String(options.index).padStart(3, "0")}-${sanitizePathSegment(options.actionKind)}${targetStem}`.slice(
    0,
    120,
  );
}

function withUrlChange(
  changes: UiChangeRecord[],
  beforeUrl: string | undefined,
  afterUrl: string | undefined,
  elapsedMs: number,
): UiChangeRecord[] {
  if (!beforeUrl || !afterUrl || beforeUrl === afterUrl) {
    return changes;
  }
  if (changes.some((change) => change.kind === "url")) {
    return changes;
  }

  return [
    ...changes,
    {
      index: changes.length + 1,
      elapsedMs,
      kind: "url",
      previousText: beforeUrl,
      text: afterUrl,
    },
  ];
}

function enrichChange(change: UiChangeRecord): UiChangeRecord {
  const group = groupForChange(change);
  const significance = significanceForChange(change, group);
  return {
    ...change,
    group,
    significance,
    summary: summarizeChange(change, group),
  };
}

function groupForChange(change: UiChangeRecord): string {
  if (change.kind === "url") {
    return "navigation";
  }
  if (change.role === "alert" || change.role === "status") {
    return "status";
  }
  if (change.role === "dialog" || change.selector?.includes("dialog")) {
    return "dialog";
  }
  if (change.kind === "focus") {
    return "focus";
  }
  if (change.kind === "input" || change.role === "form-control") {
    return "form";
  }
  if (change.role === "row" || change.role === "listitem") {
    return "collection";
  }
  if (change.kind === "state") {
    return "state";
  }
  if (change.kind === "text" || change.kind === "added") {
    return "content";
  }
  return "other";
}

function significanceForChange(
  change: UiChangeRecord,
  group: string,
): "high" | "medium" | "low" {
  if (group === "navigation" || group === "dialog" || group === "status") {
    return "high";
  }
  if (
    change.kind === "state" &&
    change.attributes &&
    Object.keys(change.attributes).some((key) =>
      [
        "disabled",
        "aria-disabled",
        "aria-busy",
        "aria-live",
        "role",
        "open",
      ].includes(key),
    )
  ) {
    return "high";
  }
  if (change.kind === "text" || change.kind === "added") {
    return "medium";
  }
  if (group === "form" || group === "collection") {
    return "medium";
  }
  return "low";
}

function summarizeChange(change: UiChangeRecord, group: string): string {
  if (change.kind === "url") {
    return `URL changed to ${change.text ?? "(unknown URL)"}`;
  }
  if (change.kind === "text" && change.previousText && change.text) {
    return `${labelForChange(change)} changed from "${change.previousText}" to "${change.text}"`;
  }
  if (change.kind === "added" && change.text) {
    return `${labelForChange(change)} appeared: "${change.text}"`;
  }
  if (change.kind === "removed" && change.text) {
    return `${labelForChange(change)} disappeared: "${change.text}"`;
  }
  if (change.kind === "state" && change.attributes) {
    return `${labelForChange(change)} state changed: ${Object.keys(change.attributes).join(", ")}`;
  }
  if (change.kind === "focus") {
    return `Focus moved to ${labelForChange(change)}`;
  }
  return `${group} change on ${labelForChange(change)}`;
}

function labelForChange(change: UiChangeRecord): string {
  return change.role ?? change.selector ?? "element";
}

function summarizeGroups(changes: UiChangeRecord[]): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const change of changes) {
    const group = change.group ?? groupForChange(change);
    groups[group] = (groups[group] ?? 0) + 1;
  }
  return groups;
}

function hasBusinessStateChange(changes: UiChangeRecord[]): boolean {
  return changes.some((change) => {
    const group = change.group ?? groupForChange(change);
    return [
      "navigation",
      "status",
      "dialog",
      "form",
      "collection",
      "state",
      "content",
    ].includes(group);
  });
}

function emptyObservation(): UiChangeObservation {
  return {
    active: false,
    url: "",
    elapsedMs: 0,
    lastChangeAgeMs: 0,
    changes: [],
  };
}
