import { readFile } from "node:fs/promises";
import { ZodError, type ZodType } from "zod";

export async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

export async function readAndParseJsonFile<T>(
  path: string,
  schema: ZodType<T>,
): Promise<T> {
  try {
    return schema.parse(await readJsonFile(path));
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("\n");
      throw new Error(`${path} is invalid:\n${details}`);
    }
    throw error;
  }
}
