import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventRecorder } from "../src/runner/events.js";
import {
  redactSensitiveText,
  redactSensitiveValue,
  redactTextArtifactContent,
} from "../src/utils/redaction.js";

describe("secret redaction", () => {
  it("redacts secret-looking object keys, named header values, explicit values, and URL params", () => {
    const explicitSecret = "explicit-secret-value";
    const redacted = redactSensitiveValue(
      {
        apiKey: "sk-ant-1234567890abcdef",
        nested: {
          refreshToken: explicitSecret,
          url: "https://example.test/callback?access_token=query-token-123&next=/ok",
        },
        headers: [
          { name: "Authorization", value: "Bearer header-token-123456" },
          { name: "Accept", value: "application/json" },
        ],
      },
      { extraValues: [explicitSecret] },
    );

    const json = JSON.stringify(redacted);
    expect(json).not.toContain("sk-ant-1234567890abcdef");
    expect(json).not.toContain(explicitSecret);
    expect(json).not.toContain("header-token-123456");
    expect(json).not.toContain("query-token-123");
    expect(json).toContain("application/json");
  });

  it("redacts common secret patterns in plain text", () => {
    const redacted = redactSensitiveText(
      [
        "Authorization: Bearer bearer-token-123456",
        '{"password":"hunter2","api_key":"sk-ant-abcdef1234567890"}',
        "https://example.test/api?token=query-token-456&safe=true",
      ].join("\n"),
    );

    expect(redacted).not.toContain("bearer-token-123456");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("sk-ant-abcdef1234567890");
    expect(redacted).not.toContain("query-token-456");
    expect(redacted).toContain("safe=true");
  });

  it("redacts JSON text artifacts such as HAR and browser state shaped content", () => {
    const redacted = JSON.parse(
      redactTextArtifactContent(
        JSON.stringify({
          log: {
            entries: [
              {
                request: {
                  url: "https://example.test/api?access_token=query-token-789",
                  headers: [
                    { name: "Authorization", value: "Bearer har-token-123456" },
                    { name: "Accept", value: "application/json" },
                  ],
                  cookies: [{ name: "session", value: "cookie-secret" }],
                },
              },
            ],
          },
          origins: [
            {
              origin: "https://example.test",
              localStorage: [{ name: "auth", value: "local-storage-token" }],
            },
          ],
        }),
      ),
    );

    const request = redacted.log.entries[0].request;
    expect(request.url).toContain("access_token=[redacted]");
    expect(request.headers[0].value).toBe("[redacted]");
    expect(request.headers[1].value).toBe("application/json");
    expect(request.cookies).toBe("[redacted]");
    expect(redacted.origins[0].localStorage).toBe("[redacted]");
  });

  it("redacts EventRecorder summaries and data before writing events", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "journeytest-redaction-"));
    const eventsPath = join(outputDir, "events.ndjson");
    const recorder = new EventRecorder({
      eventsPath,
      startedAt: new Date(),
    });

    await recorder.record("agent.tool.start", "Authorization: Bearer event-token-123456", {
      args: {
        password: "event-password",
        url: "https://example.test?access_token=event-query-token",
        headers: [{ name: "Authorization", value: "Bearer event-header-token" }],
      },
    });

    const written = await readFile(eventsPath, "utf8");
    expect(written).not.toContain("event-token-123456");
    expect(written).not.toContain("event-password");
    expect(written).not.toContain("event-query-token");
    expect(written).not.toContain("event-header-token");
    expect(recorder.timeline[0]?.summary).toBe("Authorization: [redacted]");
  });
});
