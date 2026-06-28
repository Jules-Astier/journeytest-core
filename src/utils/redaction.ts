export const REDACTED = "[redacted]";

export interface RedactionOptions {
  extraKeys?: readonly string[];
  extraValues?: readonly string[];
}

const sensitiveKeyNames = new Set([
  "authorization",
  "cookie",
  "cookies",
  "csrf",
  "xsrf",
  "setcookie",
  "localstorage",
  "sessionstorage",
  "storagestate",
  "browserstate",
  "sessionid",
  "sessiontoken",
]);

const sensitiveKeyPattern =
  /token|secret|password|passphrase|apikey|authorization|credential|oauth|privatekey/i;

const sensitiveTextKeyPattern =
  "(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|apikey|password|passphrase|secret|client[_-]?secret|authorization|cookie|set-cookie|session[_-]?token|session[_-]?id)";

export function redactSensitiveValue(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  const extraKeys = new Set((options.extraKeys ?? []).map(normalizeIdentifier));
  return redactValue(value, extraKeys, options.extraValues ?? []);
}

export function redactSensitiveText(
  value: string,
  options: Pick<RedactionOptions, "extraValues"> = {},
): string {
  let redacted = redactExplicitValues(value, options.extraValues ?? []);

  redacted = redacted.replace(
    /\b(authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n]+/gi,
    (_match, key: string) => `${key}: ${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
    (_match, scheme: string) => `${scheme} ${REDACTED}`,
  );
  redacted = redacted.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    REDACTED,
  );
  redacted = redacted.replace(
    /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
    REDACTED,
  );
  redacted = redacted.replace(
    new RegExp(
      `([?&](?:access_token|refresh_token|id_token|auth|authorization|token|api_key|apikey|key|password|secret|code|state|session|session_id)=)[^&#\\s"']+`,
      "gi",
    ),
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    new RegExp(
      `(["']?\\b${sensitiveTextKeyPattern}\\b["']?\\s*[:=]\\s*)(["'])([^\\r\\n]*?)(\\2)`,
      "gi",
    ),
    (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  );
  redacted = redacted.replace(
    new RegExp(
      `(["']?\\b${sensitiveTextKeyPattern}\\b["']?\\s*[:=]\\s*)(?!["'\\[])[^\\s,;&}\\]]+`,
      "gi",
    ),
    (_match, prefix: string) => `${prefix}${REDACTED}`,
  );

  return redacted;
}

export function redactTextArtifactContent(
  content: string,
  options: RedactionOptions = {},
): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactSensitiveValue(JSON.parse(trimmed), options), null, 2);
    } catch {
      // Fall through to text redaction for non-JSON logs.
    }
  }

  return redactSensitiveText(content, options);
}

function redactValue(
  value: unknown,
  extraKeys: ReadonlySet<string>,
  extraValues: readonly string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, extraKeys, extraValues));
  }
  if (typeof value === "string") {
    return redactSensitiveText(value, { extraValues });
  }
  if (!isRecord(value)) {
    return value;
  }

  const sensitiveNamedValue =
    typeof value.name === "string" && shouldRedactKey(value.name, extraKeys);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (shouldRedactKey(key, extraKeys)) {
        return [key, REDACTED];
      }
      if (key === "value" && sensitiveNamedValue) {
        return [key, REDACTED];
      }
      return [key, redactValue(entry, extraKeys, extraValues)];
    }),
  );
}

function shouldRedactKey(key: string, extraKeys: ReadonlySet<string>): boolean {
  const normalized = normalizeIdentifier(key);
  return (
    extraKeys.has(normalized) ||
    sensitiveKeyNames.has(normalized) ||
    sensitiveKeyPattern.test(normalized)
  );
}

function redactExplicitValues(value: string, extraValues: readonly string[]): string {
  return extraValues
    .filter((redactValue) => redactValue.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (current, redactValue) =>
        current.replace(new RegExp(escapeRegExp(redactValue), "g"), REDACTED),
      value,
    );
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
