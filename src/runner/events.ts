import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TimelineEvent } from "../core/schemas.js";
import type { StaticFrameSegment } from "../video/static.js";
import { redactSensitiveText, redactSensitiveValue } from "../utils/redaction.js";

export interface EventRecorderOptions {
  eventsPath: string;
  startedAt: Date;
}

export class EventRecorder {
  private readonly events: TimelineEvent[] = [];
  private sequence = 0;
  private videoStartedAtMs?: number;

  constructor(private readonly options: EventRecorderOptions) {}

  get timeline(): TimelineEvent[] {
    return [...this.events];
  }

  startVideoClock(): void {
    this.videoStartedAtMs = Date.now();
  }

  stopVideoClock(): void {
    this.videoStartedAtMs = undefined;
  }

  shiftVideoTimeMs(offsetMs: number): void {
    if (offsetMs <= 0) {
      return;
    }

    for (const event of this.events) {
      if (event.videoTimeMs !== undefined) {
        event.videoTimeMs = Math.max(0, event.videoTimeMs - offsetMs);
      }
    }
  }

  applyVideoCuts(cuts: StaticFrameSegment[]): void {
    if (cuts.length === 0) {
      return;
    }

    const sortedCuts = [...cuts].sort((a, b) => a.startMs - b.startMs);
    for (const event of this.events) {
      if (event.videoTimeMs !== undefined) {
        event.videoTimeMs = remapVideoTime(event.videoTimeMs, sortedCuts);
      }
    }
  }

  async flush(): Promise<void> {
    await mkdir(dirname(this.options.eventsPath), { recursive: true });
    await writeFile(
      this.options.eventsPath,
      this.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
  }

  async record(
    type: string,
    summary: string,
    data?: unknown,
    taskId?: string,
  ): Promise<TimelineEvent> {
    const now = new Date();
    const elapsedMs = Math.max(0, now.getTime() - this.options.startedAt.getTime());
    const event: TimelineEvent = {
      id: `${String(++this.sequence).padStart(5, "0")}`,
      type,
      wallTime: now.toISOString(),
      elapsedMs,
      ...(this.videoStartedAtMs === undefined
        ? {}
        : { videoTimeMs: Math.max(0, now.getTime() - this.videoStartedAtMs) }),
      ...(taskId ? { taskId } : {}),
      summary: redactSensitiveText(summary),
      ...(data === undefined ? {} : { data: redactSensitiveValue(data) }),
    };

    this.events.push(event);
    await mkdir(dirname(this.options.eventsPath), { recursive: true });
    await appendFile(this.options.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }
}

function remapVideoTime(timeMs: number, cuts: StaticFrameSegment[]): number {
  let removedBeforeMs = 0;

  for (const cut of cuts) {
    if (timeMs >= cut.endMs) {
      removedBeforeMs += cut.durationMs;
      continue;
    }

    if (timeMs > cut.startMs) {
      return Math.max(0, cut.startMs - removedBeforeMs);
    }

    break;
  }

  return Math.max(0, timeMs - removedBeforeMs);
}
