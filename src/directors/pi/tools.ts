import { join } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BrowserDriver } from "../../drivers/types.js";
import {
  AgentVerdictSchema,
  type AgentVerdict,
  type UserJourney,
} from "../../core/schemas.js";
import {
  assertNoValidationIssues,
  validateAgentVerdictForJourney,
} from "../../core/validation.js";
import type { DirectorRunContext } from "../types.js";
import { sanitizePathSegment } from "../../utils/path.js";
import { truncateText } from "../../utils/text.js";
import {
  formatUiChangeToolSuffix,
  runWithUiChangeRecording,
  type UiChangeRecordingResult,
} from "../uiChangeRecording.js";

const EvidenceReferenceType = Type.Object({
  videoTimeMs: Type.Optional(Type.Number()),
  screenshot: Type.Optional(Type.String()),
  snapshot: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  observation: Type.Optional(Type.String()),
  console: Type.Optional(Type.String()),
  network: Type.Optional(Type.String()),
  uiChangeTimeline: Type.Optional(Type.String()),
});

const FindingType = Type.Object({
  id: Type.String(),
  severity: Type.Union([
    Type.Literal("info"),
    Type.Literal("minor"),
    Type.Literal("major"),
    Type.Literal("critical"),
  ]),
  category: Type.Union([
    Type.Literal("ux"),
    Type.Literal("ui"),
    Type.Literal("accessibility"),
    Type.Literal("performance"),
    Type.Literal("bug"),
    Type.Literal("copy"),
    Type.Literal("blocker"),
    Type.Literal("security"),
  ]),
  title: Type.String(),
  description: Type.String(),
  evidence: Type.Optional(EvidenceReferenceType),
  recommendation: Type.Optional(Type.String()),
});

const CriterionAssessmentType = Type.Object({
  id: Type.String(),
  result: Type.Union([
    Type.Literal("met"),
    Type.Literal("not-met"),
    Type.Literal("blocked"),
    Type.Literal("not-observed"),
  ]),
  explanation: Type.String(),
  evidence: Type.Optional(EvidenceReferenceType),
});

const AgentVerdictType = Type.Object({
  status: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("blocked"),
    Type.Literal("inconclusive"),
  ]),
  confidence: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
  ]),
  summary: Type.String(),
  criteria: Type.Array(CriterionAssessmentType),
  blockers: Type.Array(FindingType),
  uxFindings: Type.Array(FindingType),
  suggestedImprovements: Type.Array(FindingType),
});

export interface JourneyFinishState {
  verdict?: AgentVerdict;
}

export function createPiBrowserTools(
  context: DirectorRunContext,
  finishState: JourneyFinishState,
): AgentTool<any>[] {
  let snapshotCount = 0;
  let screenshotCount = 0;
  let consoleCount = 0;
  let networkCount = 0;
  let networkHarCount = 0;
  let uiActionCount = 0;

  const browserOpenParams = Type.Object({ url: Type.String() });
  const browserSnapshotParams = Type.Object({
    selector: Type.Optional(Type.String()),
    compact: Type.Optional(Type.Boolean()),
  });
  const browserClickParams = Type.Object({ target: Type.String() });
  const browserScrollIntoViewParams = Type.Object({ target: Type.String() });
  const browserScrollParams = Type.Object({
    direction: Type.Union([
      Type.Literal("up"),
      Type.Literal("down"),
      Type.Literal("left"),
      Type.Literal("right"),
    ]),
    amount: Type.Optional(Type.Number()),
    target: Type.Optional(Type.String()),
  });
  const browserHoverParams = Type.Object({ target: Type.String() });
  const browserDragParams = Type.Object({
    source: Type.String(),
    target: Type.String(),
  });
  const browserUploadParams = Type.Object({
    target: Type.String(),
    files: Type.Array(Type.String()),
  });
  const browserFillParams = Type.Object({
    target: Type.String(),
    value: Type.String(),
  });
  const browserTypeParams = Type.Object({
    target: Type.String(),
    value: Type.String(),
  });
  const browserPressParams = Type.Object({ key: Type.String() });
  const browserWaitParams = Type.Object({
    kind: Type.Union([
      Type.Literal("duration"),
      Type.Literal("load"),
      Type.Literal("text"),
      Type.Literal("url"),
      Type.Literal("selector"),
    ]),
    value: Type.Optional(Type.String()),
  });
  const browserScreenshotParams = Type.Object({
    name: Type.Optional(Type.String()),
    full: Type.Optional(Type.Boolean()),
    annotate: Type.Optional(Type.Boolean()),
  });
  const browserConsoleEvidenceParams = Type.Object({
    name: Type.Optional(Type.String()),
    source: Type.Optional(
      Type.Union([
        Type.Literal("all"),
        Type.Literal("console"),
        Type.Literal("errors"),
      ]),
    ),
    clear: Type.Optional(Type.Boolean()),
  });
  const browserNetworkEvidenceParams = Type.Object({
    name: Type.Optional(Type.String()),
    filter: Type.Optional(Type.String()),
    resourceTypes: Type.Optional(Type.Array(Type.String())),
    method: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    clear: Type.Optional(Type.Boolean()),
  });
  const browserNetworkHarStopParams = Type.Object({
    name: Type.Optional(Type.String()),
  });
  const finishParams = Type.Object({ verdict: AgentVerdictType });

  return [
    {
      name: "browser_open",
      label: "Open URL",
      description: "Open a URL under the journey's allowed origins.",
      parameters: browserOpenParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserOpenParams>;
        const result = await context.browser.open(params.url);
        await context.recorder.record("browser.open", result.summary, {
          url: params.url,
        });
        return textResult(result.summary, result);
      },
    },
    {
      name: "browser_snapshot",
      label: "Snapshot",
      description:
        "Capture the accessibility snapshot. Use this before interactions and after page changes. Refs are stale after changes.",
      parameters: browserSnapshotParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserSnapshotParams>;
        const snapshotPath = join(
          context.artifacts.snapshotsDir,
          `${String(++snapshotCount).padStart(3, "0")}-snapshot.txt`,
        );
        const result = await context.browser.snapshot({
          interactive: true,
          compact: params.compact ?? true,
          selector: params.selector,
          savePath: snapshotPath,
        });
        await context.recorder.record("browser.snapshot", result.summary, {
          path: snapshotPath,
          selector: params.selector,
        });
        return textResult(
          `${result.summary}\nSaved: ${snapshotPath}\n\n${truncateText(result.stdout ?? "")}`,
          { path: snapshotPath },
        );
      },
    },
    {
      name: "browser_click",
      label: "Click",
      description:
        "Click a snapshot ref such as @e3, semantic locator, or selector. For offscreen targets from a snapshot, call browser_scroll_into_view first. Re-snapshot after page-changing clicks.",
      parameters: browserClickParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserClickParams>;
        let clickContext: Record<string, unknown> = {};
        const observed = await runRecordedUiAction(
          context,
          {
            index: ++uiActionCount,
            actionKind: "click",
            target: params.target,
          },
          async () => {
            clickContext = await captureClickContext(
              context.browser,
              params.target,
            );
            const result = await context.browser.click(params.target);
            await context.recorder.record("browser.click", result.summary, {
              ...params,
              ...clickContext,
            });
            return result;
          },
        );
        return textResult(
          `${observed.result.summary}${formatUiChangeToolSuffix(observed.uiChanges)}`,
          { ...observed.result, uiChanges: observed.uiChanges },
        );
      },
    },
    {
      name: "browser_scroll_into_view",
      label: "Scroll Into View",
      description:
        "Scroll a snapshot ref, semantic locator, or selector into the visible viewport before clicking or typing. Use this when a control appears in the snapshot but may be offscreen.",
      parameters: browserScrollIntoViewParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserScrollIntoViewParams>;
        const result = await context.browser.scrollIntoView(params.target);
        await context.recorder.record(
          "browser.scroll_into_view",
          result.summary,
          params,
        );
        return textResult(result.summary, result);
      },
    },
    {
      name: "browser_scroll",
      label: "Scroll",
      description:
        "Scroll the active page or a specific scrollable target. Pass target to scroll within a modal or panel instead of the page.",
      parameters: browserScrollParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserScrollParams>;
        const result = await context.browser.scroll({
          direction: params.direction,
          amount: params.amount,
          target: params.target,
        });
        await context.recorder.record("browser.scroll", result.summary, params);
        return textResult(result.summary, result);
      },
    },
    {
      name: "browser_hover",
      label: "Hover",
      description:
        "Hover a snapshot ref, semantic locator, or selector to reveal hover-only controls or tooltips.",
      parameters: browserHoverParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserHoverParams>;
        const observed = await runRecordedUiAction(
          context,
          {
            index: ++uiActionCount,
            actionKind: "hover",
            target: params.target,
          },
          async () => {
            const result = await context.browser.hover(params.target);
            await context.recorder.record("browser.hover", result.summary, params);
            return result;
          },
        );
        return textResult(
          `${observed.result.summary}${formatUiChangeToolSuffix(observed.uiChanges)}`,
          { ...observed.result, uiChanges: observed.uiChanges },
        );
      },
    },
    {
      name: "browser_drag",
      label: "Drag",
      description:
        "Drag from one target to another, such as reordering cards or dropping onto a target zone.",
      parameters: browserDragParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserDragParams>;
        const observed = await runRecordedUiAction(
          context,
          {
            index: ++uiActionCount,
            actionKind: "drag",
            target: `${params.source} -> ${params.target}`,
          },
          async () => {
            const result = await context.browser.dragAndDrop({
              source: params.source,
              target: params.target,
            });
            await context.recorder.record("browser.drag", result.summary, params);
            return result;
          },
        );
        return textResult(
          `${observed.result.summary}${formatUiChangeToolSuffix(observed.uiChanges)}`,
          { ...observed.result, uiChanges: observed.uiChanges },
        );
      },
    },
    {
      name: "browser_upload",
      label: "Upload",
      description:
        "Upload one or more local files into a file input target.",
      parameters: browserUploadParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserUploadParams>;
        const observed = await runRecordedUiAction(
          context,
          {
            index: ++uiActionCount,
            actionKind: "upload",
            target: params.target,
          },
          async () => {
            const result = await context.browser.upload({
              target: params.target,
              files: params.files,
            });
            await context.recorder.record("browser.upload", result.summary, {
              target: params.target,
              files: params.files,
              fileCount: params.files.length,
            });
            return result;
          },
        );
        return textResult(
          `${observed.result.summary}${formatUiChangeToolSuffix(observed.uiChanges)}`,
          { ...observed.result, uiChanges: observed.uiChanges },
        );
      },
    },
    {
      name: "browser_fill",
      label: "Fill",
      description: "Clear and fill an input or textarea target.",
      parameters: browserFillParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserFillParams>;
        const observed = await runRecordedUiAction(
          context,
          {
            index: ++uiActionCount,
            actionKind: "fill",
            target: params.target,
          },
          async () => {
            const result = await context.browser.fill(
              params.target,
              params.value,
            );
            await context.recorder.record("browser.fill", result.summary, {
              target: params.target,
              valueLength: params.value.length,
            });
            return result;
          },
        );
        return textResult(
          `${observed.result.summary}${formatUiChangeToolSuffix(observed.uiChanges)}`,
          { target: params.target, uiChanges: observed.uiChanges },
        );
      },
    },
    {
      name: "browser_type",
      label: "Type",
      description: "Type into the current target without clearing first.",
      parameters: browserTypeParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserTypeParams>;
        const observed = await runRecordedUiAction(
          context,
          {
            index: ++uiActionCount,
            actionKind: "type",
            target: params.target,
          },
          async () => {
            const result = await context.browser.type(
              params.target,
              params.value,
            );
            await context.recorder.record("browser.type", result.summary, {
              target: params.target,
              valueLength: params.value.length,
            });
            return result;
          },
        );
        return textResult(
          `${observed.result.summary}${formatUiChangeToolSuffix(observed.uiChanges)}`,
          { target: params.target, uiChanges: observed.uiChanges },
        );
      },
    },
    {
      name: "browser_press",
      label: "Press Key",
      description:
        "Press a key or key combination, such as Enter or Control+a.",
      parameters: browserPressParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserPressParams>;
        const observed = await runRecordedUiAction(
          context,
          {
            index: ++uiActionCount,
            actionKind: "press",
            target: params.key,
          },
          async () => {
            const result = await context.browser.press(params.key);
            await context.recorder.record(
              "browser.press",
              result.summary,
              params,
            );
            return result;
          },
        );
        return textResult(
          `${observed.result.summary}${formatUiChangeToolSuffix(observed.uiChanges)}`,
          { ...observed.result, uiChanges: observed.uiChanges },
        );
      },
    },
    {
      name: "browser_wait",
      label: "Wait",
      description:
        "Wait for duration, load, text, URL pattern, or selector. For duration, value is milliseconds. For load, value is networkidle or domcontentloaded.",
      parameters: browserWaitParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserWaitParams>;
        const waitOptions = toWaitOptions(params);
        const result = await context.browser.wait(waitOptions);
        await context.recorder.record(
          "browser.wait",
          result.summary,
          waitOptions,
        );
        return textResult(result.summary, result);
      },
    },
    {
      name: "browser_screenshot",
      label: "Screenshot",
      description: "Capture a screenshot for evidence.",
      parameters: browserScreenshotParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof browserScreenshotParams>;
        const stem = params.name
          ? sanitizePathSegment(params.name)
          : `${String(++screenshotCount).padStart(3, "0")}-screenshot`;
        const screenshotPath = join(
          context.artifacts.screenshotsDir,
          `${stem}.png`,
        );
        const result = await context.browser.screenshot({
          path: screenshotPath,
          full: params.full,
          annotate: params.annotate,
        });
        await context.recorder.record("browser.screenshot", result.summary, {
          path: screenshotPath,
        });
        return textResult(`Screenshot saved: ${screenshotPath}`, {
          path: screenshotPath,
        });
      },
    },
    {
      name: "browser_console_evidence",
      label: "Console Evidence",
      description:
        "Capture browser console logs and/or page errors as evidence. If a criterion requires console evidence, attach the returned path as evidence.console in the final verdict.",
      parameters: browserConsoleEvidenceParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        if (!context.browser.captureConsole) {
          throw new Error(
            "The active browser driver does not support console evidence capture.",
          );
        }

        const params = rawParams as Static<typeof browserConsoleEvidenceParams>;
        const stem = params.name
          ? sanitizePathSegment(params.name)
          : `${String(++consoleCount).padStart(3, "0")}-console`;
        const consolePath = join(context.artifacts.consoleDir, `${stem}.txt`);
        const result = await context.browser.captureConsole({
          path: consolePath,
          source: params.source ?? "all",
          clear: params.clear,
        });
        await context.recorder.record(
          "browser.console_evidence",
          result.summary,
          {
            path: consolePath,
            source: params.source ?? "all",
            clear: params.clear,
          },
        );
        return textResult(`Console evidence saved: ${consolePath}`, {
          path: consolePath,
        });
      },
    },
    {
      name: "browser_network_evidence",
      label: "Network Evidence",
      description:
        "Capture the browser network request log as evidence. Use filters for API-focused evidence. If a criterion requires network evidence, attach the returned path as evidence.network in the final verdict.",
      parameters: browserNetworkEvidenceParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        if (!context.browser.captureNetwork) {
          throw new Error(
            "The active browser driver does not support network evidence capture.",
          );
        }

        const params = rawParams as Static<typeof browserNetworkEvidenceParams>;
        const stem = params.name
          ? sanitizePathSegment(params.name)
          : `${String(++networkCount).padStart(3, "0")}-network`;
        const networkPath = join(context.artifacts.networkDir, `${stem}.txt`);
        const result = await context.browser.captureNetwork({
          path: networkPath,
          filter: params.filter,
          resourceTypes: params.resourceTypes,
          method: params.method,
          status: params.status,
          clear: params.clear,
        });
        await context.recorder.record(
          "browser.network_evidence",
          result.summary,
          {
            path: networkPath,
            filter: params.filter,
            resourceTypes: params.resourceTypes,
            method: params.method,
            status: params.status,
            clear: params.clear,
          },
        );
        return textResult(`Network evidence saved: ${networkPath}`, {
          path: networkPath,
        });
      },
    },
    {
      name: "browser_network_har_start",
      label: "Start HAR",
      description:
        "Start recording a HAR for detailed network evidence. Stop it with browser_network_har_stop and attach the returned path as evidence.network when relevant.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        if (!context.browser.startNetworkRecording) {
          throw new Error(
            "The active browser driver does not support network HAR recording.",
          );
        }

        const result = await context.browser.startNetworkRecording();
        await context.recorder.record(
          "browser.network_har.start",
          result.summary,
        );
        return textResult(result.summary, result);
      },
    },
    {
      name: "browser_network_har_stop",
      label: "Stop HAR",
      description:
        "Stop network HAR recording and save it as an evidence artifact. Attach the returned path as evidence.network in the final verdict when it supports a criterion.",
      parameters: browserNetworkHarStopParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        if (!context.browser.stopNetworkRecording) {
          throw new Error(
            "The active browser driver does not support network HAR recording.",
          );
        }

        const params = rawParams as Static<typeof browserNetworkHarStopParams>;
        const stem = params.name
          ? sanitizePathSegment(params.name)
          : `${String(++networkHarCount).padStart(3, "0")}-network`;
        const networkPath = join(context.artifacts.networkDir, `${stem}.har`);
        const result = await context.browser.stopNetworkRecording({
          path: networkPath,
        });
        await context.recorder.record(
          "browser.network_har.stop",
          result.summary,
          {
            path: networkPath,
          },
        );
        return textResult(`Network HAR saved: ${networkPath}`, {
          path: networkPath,
        });
      },
    },
    {
      name: "browser_get_url",
      label: "Get URL",
      description: "Read the current page URL.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        const url = await context.browser.getUrl();
        await context.recorder.record(
          "browser.get_url",
          `Current URL: ${url}`,
          { url },
        );
        return textResult(url, { url });
      },
    },
    {
      name: "browser_get_title",
      label: "Get Title",
      description: "Read the current page title.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        const title = await context.browser.getTitle();
        await context.recorder.record(
          "browser.get_title",
          `Current title: ${title}`,
          {
            title,
          },
        );
        return textResult(title, { title });
      },
    },
    {
      name: "journey_finish",
      label: "Finish Journey",
      description:
        "Finish the journey with the final agent-owned verdict. Include one criterion assessment for every pass, fail, and blocker criterion id.",
      parameters: finishParams,
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Static<typeof finishParams>;
        const verdict = AgentVerdictSchema.parse(params.verdict);
        assertNoValidationIssues(
          validateAgentVerdictForJourney(context.journey, verdict),
        );
        finishState.verdict = verdict;
        await context.recorder.record(
          "journey.verdict",
          `Agent verdict: ${verdict.status}`,
          {
            verdict,
          },
        );
        return {
          content: [
            { type: "text", text: `Verdict accepted: ${verdict.status}` },
          ],
          details: verdict,
          terminate: true,
        };
      },
    },
  ];
}

function runRecordedUiAction<T>(
  context: DirectorRunContext,
  action: {
    index: number;
    actionKind: string;
    target?: string;
  },
  execute: () => Promise<T>,
): Promise<UiChangeRecordingResult<T>> {
  const observed = () => runWithUiChangeRecording(context, action, execute);
  if (!context.actionVideoRecorder) {
    return observed();
  }

  return context.actionVideoRecorder.record(
    {
      actionKind: action.actionKind,
      target: action.target,
    },
    observed,
  );
}

async function captureClickContext(
  browser: BrowserDriver,
  target: string,
): Promise<Record<string, unknown>> {
  try {
    const boxResult = await browser.getElementBox(target);
    const box = boxResult.details;
    if (!box) {
      return {};
    }

    const viewport = await browser
      .getViewport()
      .then((result) => result.details)
      .catch(() => undefined);
    return {
      elementBox: box,
      click: {
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2),
        ...(viewport
          ? { viewportWidth: viewport.width, viewportHeight: viewport.height }
          : {}),
      },
    };
  } catch {
    return {};
  }
}

function textResult<T>(text: string, details: T) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

type BrowserWaitToolParams = {
  kind: "duration" | "load" | "text" | "url" | "selector";
  value?: string;
};

function toWaitOptions(params: BrowserWaitToolParams) {
  const value = typeof params.value === "string" ? params.value : "";
  if (params.kind === "duration") {
    return {
      kind: "duration" as const,
      ms: Number.parseInt(value || "1000", 10),
    };
  }
  if (params.kind === "load") {
    return {
      kind: "load" as const,
      state:
        value === "domcontentloaded"
          ? ("domcontentloaded" as const)
          : ("networkidle" as const),
    };
  }
  if (params.kind === "text") {
    return { kind: "text" as const, text: value };
  }
  if (params.kind === "url") {
    return { kind: "url" as const, pattern: value };
  }
  return { kind: "selector" as const, selector: value };
}

export function summarizeJourneyCriteria(journey: UserJourney): string {
  return JSON.stringify(
    {
      passCriteria: journey.passCriteria,
      failCriteria: journey.failCriteria,
      blockerCriteria: journey.blockerCriteria ?? [],
    },
    null,
    2,
  );
}
