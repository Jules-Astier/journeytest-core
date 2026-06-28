import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function isoTimestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function createRunDirectory(
  outputDir: string,
  journeyId: string,
  startedAt = new Date(),
): Promise<{ runId: string; runDir: string }> {
  const runId = `${isoTimestampForPath(startedAt)}-${sanitizePathSegment(journeyId)}`;
  const runDir = join(outputDir, runId);
  await mkdir(join(runDir, "screenshots"), { recursive: true });
  await mkdir(join(runDir, "snapshots"), { recursive: true });
  await mkdir(join(runDir, "console"), { recursive: true });
  await mkdir(join(runDir, "network"), { recursive: true });
  await mkdir(join(runDir, "ui-changes"), { recursive: true });
  return { runId, runDir };
}
