import type { TimelineEvent, VideoBookmark } from "./schemas.js";

export const uiActionEventTypes = new Set([
  "browser.click",
  "browser.dblclick",
  "browser.drag",
  "browser.fill",
  "browser.type",
  "browser.press",
  "browser.check",
  "browser.uncheck",
  "browser.select",
  "browser.upload",
  "browser.scroll",
  "browser.hover",
]);

export function isUiActionEvent(event: TimelineEvent): boolean {
  return event.videoTimeMs !== undefined && uiActionEventTypes.has(event.type);
}

export function buildRawActionBookmarks(timeline: TimelineEvent[]): VideoBookmark[] {
  return timeline
    .filter(isUiActionEvent)
    .map((event) => ({
      id: `action-${event.id}`,
      timeMs: event.videoTimeMs ?? 0,
      label: event.summary,
      detail: actionDetail(event),
      sourceEventIds: [event.id],
      kind: "action" as const,
    }))
    .sort((a, b) => a.timeMs - b.timeMs || a.label.localeCompare(b.label));
}

export function actionDetail(event: TimelineEvent): string {
  if (event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    const target = typeof data.target === "string" ? data.target : undefined;
    const key = typeof data.key === "string" ? data.key : undefined;
    const valueLength = typeof data.valueLength === "number" ? `value length ${data.valueLength}` : undefined;
    return [event.type, target, key, valueLength].filter(Boolean).join(" · ");
  }

  return event.type;
}
