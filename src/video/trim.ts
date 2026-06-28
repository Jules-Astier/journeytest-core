import { execFile as execFileCallback } from "node:child_process";
import { access, rename } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface TrimLeadingSolidColorStartOptions {
  maxScanMs?: number;
  sampleEveryMs?: number;
  minTrimMs?: number;
  tolerance?: number;
  ffmpegPath?: string;
  maxFrameBytes?: number;
}

export interface TrimLeadingSolidColorStartResult {
  trimmed: boolean;
  offsetMs: number;
  originalPath?: string;
  reason: string;
}

export async function trimLeadingSolidColorStart(
  videoPath: string,
  options: TrimLeadingSolidColorStartOptions = {},
): Promise<TrimLeadingSolidColorStartResult> {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const maxScanMs = options.maxScanMs ?? 30_000;
  const sampleEveryMs = options.sampleEveryMs ?? 500;
  const minTrimMs = options.minTrimMs ?? 250;
  const tolerance = options.tolerance ?? 0;

  if (sampleEveryMs <= 0 || maxScanMs <= 0) {
    return { trimmed: false, offsetMs: 0, reason: "invalid-scan-options" };
  }

  try {
    await access(videoPath);
  } catch {
    return { trimmed: false, offsetMs: 0, reason: "video-missing" };
  }

  const firstFrame = await sampleRgbFrame(videoPath, 0, ffmpegPath, options.maxFrameBytes);
  if (!firstFrame.ok) {
    return { trimmed: false, offsetMs: 0, reason: firstFrame.reason };
  }

  if (!isSolidRgbFrame(firstFrame.frame, tolerance)) {
    return { trimmed: false, offsetMs: 0, reason: "first-frame-not-solid" };
  }

  let firstNonSolidMs: number | undefined;
  for (let sampleMs = sampleEveryMs; sampleMs <= maxScanMs; sampleMs += sampleEveryMs) {
    const sampledFrame = await sampleRgbFrame(videoPath, sampleMs, ffmpegPath, options.maxFrameBytes);
    if (!sampledFrame.ok) {
      break;
    }

    if (!isSolidRgbFrame(sampledFrame.frame, tolerance)) {
      firstNonSolidMs = sampleMs;
      break;
    }
  }

  if (firstNonSolidMs === undefined) {
    return { trimmed: false, offsetMs: 0, reason: "no-non-solid-frame-found" };
  }

  if (firstNonSolidMs < minTrimMs) {
    return { trimmed: false, offsetMs: 0, reason: "below-min-trim" };
  }

  const originalPath = originalVideoPath(videoPath);
  try {
    await rename(videoPath, originalPath);
  } catch {
    return { trimmed: false, offsetMs: 0, reason: "could-not-save-original" };
  }

  try {
    await trimVideo(originalPath, videoPath, firstNonSolidMs, ffmpegPath);
  } catch {
    await rename(originalPath, videoPath).catch(() => {});
    return { trimmed: false, offsetMs: 0, reason: "trim-failed" };
  }

  return {
    trimmed: true,
    offsetMs: firstNonSolidMs,
    originalPath,
    reason: "trimmed-leading-solid-color",
  };
}

export function isSolidRgbFrame(frame: Uint8Array, tolerance = 0): boolean {
  if (frame.length < 3 || frame.length % 3 !== 0) {
    return false;
  }

  const r = frame[0] ?? 0;
  const g = frame[1] ?? 0;
  const b = frame[2] ?? 0;
  for (let index = 3; index < frame.length; index += 3) {
    if (
      Math.abs((frame[index] ?? 0) - r) > tolerance ||
      Math.abs((frame[index + 1] ?? 0) - g) > tolerance ||
      Math.abs((frame[index + 2] ?? 0) - b) > tolerance
    ) {
      return false;
    }
  }

  return true;
}

function originalVideoPath(videoPath: string): string {
  const extension = extname(videoPath) || ".webm";
  const stem = basename(videoPath, extension);
  return join(dirname(videoPath), `${stem}.original${extension}`);
}

async function sampleRgbFrame(
  videoPath: string,
  timeMs: number,
  ffmpegPath: string,
  maxFrameBytes = 96 * 1024 * 1024,
): Promise<{ ok: true; frame: Uint8Array } | { ok: false; reason: string }> {
  try {
    const { stdout } = await execFile(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        formatSeconds(timeMs),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      {
        encoding: "buffer",
        maxBuffer: maxFrameBytes,
        timeout: 15_000,
      },
    );

    const frame = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    return frame.length > 0 ? { ok: true, frame } : { ok: false, reason: "empty-frame" };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    return { ok: false, reason: code === "ENOENT" ? "ffmpeg-unavailable" : "frame-sample-failed" };
  }
}

async function trimVideo(
  inputPath: string,
  outputPath: string,
  offsetMs: number,
  ffmpegPath: string,
): Promise<void> {
  await execFile(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      formatSeconds(offsetMs),
      "-i",
      inputPath,
      "-map",
      "0",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      outputPath,
    ],
    { timeout: 30_000 },
  );
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}
