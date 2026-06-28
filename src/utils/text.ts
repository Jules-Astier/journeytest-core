export function truncateText(value: string, maxLength = 12_000): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed) as unknown;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]) as unknown;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }

  throw new Error("No JSON object found in text.");
}
