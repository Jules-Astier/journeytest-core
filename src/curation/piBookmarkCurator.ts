import { Agent } from "@earendil-works/pi-agent-core";
import {
  getModel,
  type KnownProvider,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  buildRawActionBookmarks,
  isUiActionEvent,
} from "../core/bookmarks.js";
import {
  type TimelineEvent,
  type VideoBookmark,
} from "../core/schemas.js";
import { extractJsonObject, truncateText } from "../utils/text.js";
import { redactSensitiveText, redactSensitiveValue } from "../utils/redaction.js";
import type { BookmarkCurationContext, BookmarkCurator } from "./types.js";

export const DEFAULT_BOOKMARK_CURATOR_SYSTEM_PROMPT = `You are a video chapter editor for JourneyTest browser test recordings.

Your job is to turn low-level UI action events into useful human video chapters.

Rules:
- Keep only meaningful UI action moments. You may drop noisy or redundant action candidates.
- Do not create chapters for snapshots, screenshots, tool start/end, assistant message events, or generic timeline events.
- Use concise labels like YouTube chapters: 2-8 words, specific, human-readable.
- Prefer labels that explain intent: "Submit invite form", "Open workspace menu", "Choose Member role".
- If the target is ambiguous, use the nearby assistant text and event data to infer the action purpose.
- Use the exact source event ids from the provided candidates.
- Use the exact timestamp from the action candidate. Do not invent timestamps.
- Return JSON only.`;

const BookmarkCurationOutputSchema = z
  .object({
    bookmarks: z.array(
      z
        .object({
          id: z.string().min(1),
          timeMs: z.number().int().nonnegative(),
          label: z.string().min(1),
          detail: z.string().optional(),
          sourceEventIds: z.array(z.string().min(1)).optional(),
          kind: z.enum(["action", "milestone", "finding"]).default("action"),
        })
        .strict(),
    ),
  })
  .strict();

export interface PiBookmarkCuratorOptions {
  provider?: Provider;
  modelId?: string;
  model?: Model<any>;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  systemPrompt?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export class PiBookmarkCurator implements BookmarkCurator {
  readonly name = "pi-bookmark-curator";
  private readonly piModel: Model<any>;
  private readonly thinkingLevel: NonNullable<PiBookmarkCuratorOptions["thinkingLevel"]>;
  private readonly systemPrompt: string;
  private readonly getApiKey?: PiBookmarkCuratorOptions["getApiKey"];

  constructor(options: PiBookmarkCuratorOptions) {
    this.piModel =
      options.model ??
      getModel(options.provider as KnownProvider, options.modelId as never);
    this.thinkingLevel = options.thinkingLevel ?? "low";
    this.systemPrompt = options.systemPrompt ?? DEFAULT_BOOKMARK_CURATOR_SYSTEM_PROMPT;
    this.getApiKey = options.getApiKey;
  }

  async curate(context: BookmarkCurationContext): Promise<VideoBookmark[]> {
    const candidates = buildCurationCandidates(context.result.timeline);
    if (candidates.length === 0) {
      return [];
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model: this.piModel,
        thinkingLevel: this.thinkingLevel,
        tools: [],
      },
      getApiKey: this.getApiKey,
      toolExecution: "sequential",
    });

    await agent.prompt(buildPrompt(context, candidates));

    if (agent.state.errorMessage) {
      throw new Error(`Pi bookmark curator provider error: ${redactSensitiveText(agent.state.errorMessage)}`);
    }

    const lastAssistant = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!lastAssistant || lastAssistant.role !== "assistant") {
      throw new Error("Pi bookmark curator did not produce a response.");
    }

    const text = lastAssistant.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    const parsed = BookmarkCurationOutputSchema.parse(extractJsonObject(text));

    return normalizeCuratedBookmarks(parsed.bookmarks, candidates);
  }
}

interface CurationCandidate {
  eventId: string;
  type: string;
  timeMs: number;
  summary: string;
  data?: unknown;
  nearbyAssistantText?: string;
  previousEvents: Array<Pick<TimelineEvent, "id" | "type" | "summary" | "videoTimeMs">>;
}

function buildPrompt(
  context: BookmarkCurationContext,
  candidates: CurationCandidate[],
): string {
  return `Curate video chapters for this JourneyTest run.

Run:
${JSON.stringify(
  {
    runId: context.result.runId,
    journeyId: context.result.journeyId,
    runStatus: context.result.runStatus,
    verdict: context.result.verdict
      ? {
          status: context.result.verdict.status,
          confidence: context.result.verdict.confidence,
          summary: context.result.verdict.summary,
        }
      : undefined,
    objective: context.journey.objective,
    tasks: context.journey.tasks.map((task) => ({
      id: task.id,
      instruction: task.instruction,
      expectedOutcome: task.expectedOutcome,
    })),
  },
  null,
  2,
)}

UI action candidates:
${JSON.stringify(candidates, null, 2)}

Return this exact shape:
{
  "bookmarks": [
    {
      "id": "short-stable-id",
      "timeMs": 1234,
      "label": "Submit invite form",
      "detail": "Clicked the form submit button after filling the invite email.",
      "sourceEventIds": ["00012"],
      "kind": "action"
    }
  ]
}

Only include source event ids that appear in the UI action candidates.`;
}

function buildCurationCandidates(timeline: TimelineEvent[]): CurationCandidate[] {
  const assistantMessages = timeline.filter((event) => event.type === "agent.message.end");

  return timeline.filter(isUiActionEvent).map((event) => {
    const previousEvents = timeline
      .filter((candidate) => candidate.elapsedMs <= event.elapsedMs && candidate.id !== event.id)
      .slice(-6)
      .map(({ id, type, summary, videoTimeMs }) => ({ id, type, summary, videoTimeMs }));
    const nearbyAssistant = [...assistantMessages]
      .reverse()
      .find((message) => message.elapsedMs <= event.elapsedMs);

    return {
      eventId: event.id,
      type: event.type,
      timeMs: event.videoTimeMs ?? 0,
      summary: event.summary,
    data: redactSensitiveValue(event.data),
    nearbyAssistantText: extractAssistantText(nearbyAssistant),
      previousEvents,
    };
  });
}

function extractAssistantText(event: TimelineEvent | undefined): string | undefined {
  if (!event?.data || typeof event.data !== "object") {
    return undefined;
  }

  const text = (event.data as Record<string, unknown>).text;
  return typeof text === "string" && text.trim() ? truncateText(text, 1800) : undefined;
}

function normalizeCuratedBookmarks(
  bookmarks: VideoBookmark[],
  candidates: CurationCandidate[],
): VideoBookmark[] {
  if (bookmarks.length === 0) {
    return [];
  }

  const candidateById = new Map(candidates.map((candidate) => [candidate.eventId, candidate]));
  const seen = new Set<string>();
  const normalized: VideoBookmark[] = [];

  for (const bookmark of bookmarks) {
    const sourceEventId = bookmark.sourceEventIds?.find((id) => candidateById.has(id));
    if (!sourceEventId || seen.has(sourceEventId)) {
      continue;
    }

    const candidate = candidateById.get(sourceEventId);
    if (!candidate) {
      continue;
    }

    seen.add(sourceEventId);
    normalized.push({
      ...bookmark,
      id: normalizeBookmarkId(bookmark.id, sourceEventId),
      timeMs: candidate.timeMs,
      label: bookmark.label.trim(),
      detail: bookmark.detail?.trim(),
      sourceEventIds: [sourceEventId],
      kind: "action",
    });
  }

  return normalized.length > 0
    ? normalized.sort((a, b) => a.timeMs - b.timeMs || a.label.localeCompare(b.label))
    : buildRawActionBookmarks(candidatesToEvents(candidates));
}

function normalizeBookmarkId(id: string, sourceEventId: string): string {
  const normalized = id.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 80);
  return normalized || `action-${sourceEventId}`;
}

function candidatesToEvents(candidates: CurationCandidate[]): TimelineEvent[] {
  return candidates.map((candidate) => ({
    id: candidate.eventId,
    type: candidate.type,
    wallTime: new Date(0).toISOString(),
    elapsedMs: candidate.timeMs,
    videoTimeMs: candidate.timeMs,
    summary: redactSensitiveText(candidate.summary),
    data: redactSensitiveValue(candidate.data),
  }));
}
