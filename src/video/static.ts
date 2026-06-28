import { execFile as execFileCallback } from "node:child_process";
import { access, rename } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface StaticFrameSample {
  timeMs: number;
  hash: string;
}

export interface StaticFrameSegment {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface CondenseStaticFrameVideoOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  sampleEveryMs?: number;
  minStaticMs?: number;
  keepPaddingMs?: number;
  minRemovedMs?: number;
  sampleScaleWidth?: number;
  preserveOriginal?: boolean;
  protectedTimesMs?: number[];
  protectedPaddingMs?: number;
}

export interface CondenseStaticFrameVideoResult {
  condensed: boolean;
  removedMs: number;
  removedSegments: StaticFrameSegment[];
  originalPath?: string;
  reason: string;
}

export async function condenseStaticFrameVideo(
  videoPath: string,
  options: CondenseStaticFrameVideoOptions = {},
): Promise<CondenseStaticFrameVideoResult> {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const durationMs = await getVideoDurationMs(videoPath, options.ffprobePath ?? "ffprobe");
  if (durationMs === undefined) {
    return skipped("duration-unavailable");
  }

  const samples = await readFrameHashes(videoPath, options);
  if (!samples.ok) {
    return skipped(samples.reason);
  }

  const removedSegments = detectStaticFrameSegments(samples.samples, {
    minStaticMs: options.minStaticMs ?? 2_500,
    keepPaddingMs: options.keepPaddingMs ?? 500,
    minRemovedMs: options.minRemovedMs ?? 1_000,
    videoDurationMs: durationMs,
    protectedTimesMs: options.protectedTimesMs,
    protectedPaddingMs: options.protectedPaddingMs,
  });

  const removedMs = removedSegments.reduce((total, segment) => total + segment.durationMs, 0);
  if (removedSegments.length === 0 || removedMs <= 0) {
    return skipped("no-static-segments");
  }

  const keepSegments = buildKeepSegments(durationMs, removedSegments);
  if (keepSegments.length === 0) {
    return skipped("no-keep-segments");
  }

  const extension = extname(videoPath) || ".webm";
  const outputPath = join(dirname(videoPath), `${basename(videoPath, extension)}.condensed${extension}`);
  const originalPath = originalVideoPath(videoPath);
  const preserveOriginal = options.preserveOriginal ?? true;
  const inputPath = preserveOriginal ? originalPath : videoPath;

  try {
    if (preserveOriginal) {
      await rename(videoPath, originalPath);
    } else {
      await access(videoPath);
    }
    await renderCondensedVideo(inputPath, outputPath, keepSegments, ffmpegPath);
    await rename(outputPath, videoPath);
  } catch {
    await rename(originalPath, videoPath).catch(() => {});
    return skipped("condense-failed");
  }

  return {
    condensed: true,
    removedMs,
    removedSegments,
    ...(preserveOriginal ? { originalPath } : {}),
    reason: "condensed-static-frames",
  };
}

export function detectStaticFrameSegments(
  samples: StaticFrameSample[],
  options: {
    minStaticMs: number;
    keepPaddingMs: number;
    minRemovedMs: number;
    videoDurationMs: number;
    protectedTimesMs?: number[];
    protectedPaddingMs?: number;
  },
): StaticFrameSegment[] {
  if (samples.length < 2) {
    return [];
  }

  const segments: StaticFrameSegment[] = [];
  let runStartMs: number | undefined;
  let previous = samples[0];

  for (const sample of samples.slice(1)) {
    if (sample.hash === previous.hash) {
      runStartMs ??= previous.timeMs;
    } else if (runStartMs !== undefined) {
      addStaticSegment(segments, runStartMs, previous.timeMs, options);
      runStartMs = undefined;
    }

    previous = sample;
  }

  if (runStartMs !== undefined) {
    addStaticSegment(segments, runStartMs, Math.min(previous.timeMs, options.videoDurationMs), options);
  }

  return protectTimelineWindows(segments, {
    protectedTimesMs: options.protectedTimesMs ?? [],
    protectedPaddingMs: options.protectedPaddingMs ?? 1_250,
    minRemovedMs: options.minRemovedMs,
    videoDurationMs: options.videoDurationMs,
  });
}

function addStaticSegment(
  segments: StaticFrameSegment[],
  staticStartMs: number,
  staticEndMs: number,
  options: {
    minStaticMs: number;
    keepPaddingMs: number;
    minRemovedMs: number;
    videoDurationMs: number;
  },
): void {
  const boundedStartMs = Math.max(0, staticStartMs);
  const boundedEndMs = Math.min(options.videoDurationMs, staticEndMs);
  if (boundedEndMs - boundedStartMs < options.minStaticMs) {
    return;
  }

  const startMs = Math.min(options.videoDurationMs, boundedStartMs + options.keepPaddingMs);
  const endMs = Math.max(0, boundedEndMs - options.keepPaddingMs);
  const durationMs = Math.max(0, endMs - startMs);
  if (durationMs < options.minRemovedMs) {
    return;
  }

  segments.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), durationMs: Math.round(durationMs) });
}

function protectTimelineWindows(
  segments: StaticFrameSegment[],
  options: {
    protectedTimesMs: number[];
    protectedPaddingMs: number;
    minRemovedMs: number;
    videoDurationMs: number;
  },
): StaticFrameSegment[] {
  const windows = mergeProtectedWindows(
    options.protectedTimesMs
      .filter((timeMs) => Number.isFinite(timeMs))
      .map((timeMs) => ({
        startMs: Math.max(0, Math.round(timeMs - options.protectedPaddingMs)),
        endMs: Math.min(options.videoDurationMs, Math.round(timeMs + options.protectedPaddingMs)),
      })),
  );
  if (windows.length === 0) {
    return segments;
  }

  const protectedSegments: StaticFrameSegment[] = [];
  for (const segment of segments) {
    let remaining = [segment];
    for (const window of windows) {
      remaining = remaining.flatMap((candidate) => subtractWindow(candidate, window));
      if (remaining.length === 0) {
        break;
      }
    }

    for (const candidate of remaining) {
      if (candidate.durationMs >= options.minRemovedMs) {
        protectedSegments.push(candidate);
      }
    }
  }

  return protectedSegments;
}

function mergeProtectedWindows(windows: Array<{ startMs: number; endMs: number }>) {
  const sorted = windows
    .filter((window) => window.endMs > window.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];

  for (const window of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && window.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, window.endMs);
    } else {
      merged.push({ ...window });
    }
  }

  return merged;
}

function subtractWindow(
  segment: StaticFrameSegment,
  window: { startMs: number; endMs: number },
): StaticFrameSegment[] {
  if (window.endMs <= segment.startMs || window.startMs >= segment.endMs) {
    return [segment];
  }

  const parts: StaticFrameSegment[] = [];
  if (window.startMs > segment.startMs) {
    const endMs = Math.min(window.startMs, segment.endMs);
    parts.push({
      startMs: segment.startMs,
      endMs,
      durationMs: endMs - segment.startMs,
    });
  }
  if (window.endMs < segment.endMs) {
    const startMs = Math.max(window.endMs, segment.startMs);
    parts.push({
      startMs,
      endMs: segment.endMs,
      durationMs: segment.endMs - startMs,
    });
  }

  return parts.filter((part) => part.durationMs > 0);
}

function buildKeepSegments(durationMs: number, removedSegments: StaticFrameSegment[]): StaticFrameSegment[] {
  const keepSegments: StaticFrameSegment[] = [];
  let cursorMs = 0;

  for (const segment of removedSegments) {
    if (segment.startMs > cursorMs) {
      keepSegments.push({
        startMs: cursorMs,
        endMs: segment.startMs,
        durationMs: segment.startMs - cursorMs,
      });
    }
    cursorMs = Math.max(cursorMs, segment.endMs);
  }

  if (cursorMs < durationMs) {
    keepSegments.push({
      startMs: cursorMs,
      endMs: durationMs,
      durationMs: durationMs - cursorMs,
    });
  }

  return keepSegments.filter((segment) => segment.durationMs > 0);
}

async function readFrameHashes(
  videoPath: string,
  options: CondenseStaticFrameVideoOptions,
): Promise<{ ok: true; samples: StaticFrameSample[] } | { ok: false; reason: string }> {
  const sampleEveryMs = options.sampleEveryMs ?? 500;
  if (sampleEveryMs <= 0) {
    return { ok: false, reason: "invalid-sample-interval" };
  }

  const fps = Math.max(0.01, 1000 / sampleEveryMs);
  const filters = [`fps=${fps.toFixed(3)}`];
  if ((options.sampleScaleWidth ?? 160) > 0) {
    filters.push(`scale=${options.sampleScaleWidth ?? 160}:-1`);
  }

  try {
    const { stdout } = await execFile(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoPath,
        "-map",
        "0:v:0",
        "-vf",
        filters.join(","),
        "-f",
        "framemd5",
        "pipe:1",
      ],
      {
        maxBuffer: 128 * 1024 * 1024,
        timeout: 180_000,
      },
    );

    const samples = parseFrameMd5(stdout.toString(), sampleEveryMs);
    return samples.length > 0 ? { ok: true, samples } : { ok: false, reason: "no-frame-hashes" };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    return { ok: false, reason: code === "ENOENT" ? "ffmpeg-unavailable" : "frame-hash-failed" };
  }
}

function parseFrameMd5(output: string, fallbackSampleEveryMs: number): StaticFrameSample[] {
  let timebaseNumerator = 1;
  let timebaseDenominator = Math.max(1, Math.round(1000 / fallbackSampleEveryMs));
  const samples: StaticFrameSample[] = [];

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const timebaseMatch = trimmed.match(/^#tb\s+\d+:\s*(\d+)\/(\d+)/);
    if (timebaseMatch) {
      timebaseNumerator = Number(timebaseMatch[1]);
      timebaseDenominator = Number(timebaseMatch[2]);
      continue;
    }

    if (trimmed.startsWith("#")) {
      continue;
    }

    const parts = trimmed.split(",").map((part) => part.trim());
    const pts = Number(parts[2]);
    const hash = parts[5];
    if (!Number.isFinite(pts) || !hash) {
      continue;
    }

    samples.push({
      timeMs: Math.round((pts * timebaseNumerator * 1000) / timebaseDenominator),
      hash,
    });
  }

  return samples;
}

async function getVideoDurationMs(videoPath: string, ffprobePath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFile(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { timeout: 15_000 },
    );
    const seconds = Number(stdout.toString().trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  } catch {
    return undefined;
  }
}

async function renderCondensedVideo(
  inputPath: string,
  outputPath: string,
  keepSegments: StaticFrameSegment[],
  ffmpegPath: string,
): Promise<void> {
  const filterParts = keepSegments.map((segment, index) => {
    const start = formatSeconds(segment.startMs);
    const end = formatSeconds(segment.endMs);
    return `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`;
  });
  const concatInputs = keepSegments.map((_segment, index) => `[v${index}]`).join("");
  const filter = `${filterParts.join(";")};${concatInputs}concat=n=${keepSegments.length}:v=1:a=0[outv]`;

  try {
    await renderCondensedVideoWithCodec(inputPath, outputPath, filter, ffmpegPath, "libvpx-vp9");
  } catch {
    await renderCondensedVideoWithCodec(inputPath, outputPath, filter, ffmpegPath, "libvpx");
  }
}

async function renderCondensedVideoWithCodec(
  inputPath: string,
  outputPath: string,
  filter: string,
  ffmpegPath: string,
  codec: "libvpx-vp9" | "libvpx",
): Promise<void> {
  await execFile(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-filter_complex",
      filter,
      "-map",
      "[outv]",
      "-an",
      "-c:v",
      codec,
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      "-b:v",
      "0",
      "-crf",
      "34",
      outputPath,
    ],
    { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
  );
}

function originalVideoPath(videoPath: string): string {
  const extension = extname(videoPath) || ".webm";
  const stem = basename(videoPath, extension);
  return join(dirname(videoPath), `${stem}.original${extension}`);
}

function skipped(reason: string): CondenseStaticFrameVideoResult {
  return {
    condensed: false,
    removedMs: 0,
    removedSegments: [],
    reason,
  };
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}
