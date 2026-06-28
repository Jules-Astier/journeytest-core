import { describe, expect, it } from "vitest";
import { detectStaticFrameSegments } from "../src/video/static.js";
import { isSolidRgbFrame } from "../src/video/trim.js";

describe("video trimming helpers", () => {
  it("detects frames where every RGB pixel is the same exact color", () => {
    expect(isSolidRgbFrame(Uint8Array.from([12, 34, 56, 12, 34, 56]))).toBe(true);
    expect(isSolidRgbFrame(Uint8Array.from([12, 34, 56, 12, 34, 57]))).toBe(false);
  });

  it("detects removable static frame spans with padding", () => {
    const segments = detectStaticFrameSegments(
      [
        { timeMs: 0, hash: "a" },
        { timeMs: 500, hash: "b" },
        { timeMs: 1000, hash: "b" },
        { timeMs: 1500, hash: "b" },
        { timeMs: 2000, hash: "b" },
        { timeMs: 2500, hash: "c" },
      ],
      {
        minStaticMs: 1500,
        keepPaddingMs: 250,
        minRemovedMs: 500,
        videoDurationMs: 3000,
      },
    );

    expect(segments).toEqual([{ startMs: 750, endMs: 1750, durationMs: 1000 }]);
  });

  it("keeps protected action windows inside static frame spans", () => {
    const segments = detectStaticFrameSegments(
      [
        { timeMs: 0, hash: "a" },
        { timeMs: 500, hash: "b" },
        { timeMs: 1000, hash: "b" },
        { timeMs: 1500, hash: "b" },
        { timeMs: 2000, hash: "b" },
        { timeMs: 2500, hash: "b" },
        { timeMs: 3000, hash: "b" },
        { timeMs: 3500, hash: "b" },
        { timeMs: 4000, hash: "b" },
        { timeMs: 4500, hash: "b" },
        { timeMs: 5000, hash: "c" },
      ],
      {
        minStaticMs: 1500,
        keepPaddingMs: 500,
        minRemovedMs: 500,
        videoDurationMs: 5500,
        protectedTimesMs: [2500],
        protectedPaddingMs: 500,
      },
    );

    expect(segments).toEqual([
      { startMs: 1000, endMs: 2000, durationMs: 1000 },
      { startMs: 3000, endMs: 4000, durationMs: 1000 },
    ]);
  });
});
