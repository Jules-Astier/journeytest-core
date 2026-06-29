import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface ActionVideoClip {
  id: string;
  path: string;
  actionKind: string;
  target?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  stitchedStartMs: number;
  stitchedEndMs: number;
}

export interface StitchVideoClipsResult {
  stitched: boolean;
  outputPath?: string;
  reason?: string;
}

export async function stitchVideoClips(
  clips: ActionVideoClip[],
  outputPath: string,
  options: { ffmpegPath?: string } = {},
): Promise<StitchVideoClipsResult> {
  if (clips.length === 0) {
    return { stitched: false, reason: "no-clips" };
  }

  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const listPath = `${outputPath}.clips.txt`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    listPath,
    clips.map((clip) => `file '${escapeConcatPath(clip.path)}'`).join("\n") + "\n",
    "utf8",
  );

  try {
    await execFile(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        outputPath,
      ],
      { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
    );
    return { stitched: true, outputPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      stitched: false,
      reason: code === "ENOENT" ? "ffmpeg-unavailable" : "clip-stitch-failed",
    };
  }
}

function escapeConcatPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}
