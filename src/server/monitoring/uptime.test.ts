import { describe, expect, it } from "vitest";
import { historyBuckets, uptimeRatio } from "./uptime.js";

const HOUR = 3_600_000;

describe("uptimeRatio", () => {
  it("is null when nothing was observed — not zero", () => {
    // Zero would render as "0% uptime", which claims an outage that was never
    // observed. Absence of data is not evidence of downtime.
    expect(uptimeRatio([], [], 0, HOUR)).toBeNull();
  });

  it("counts only checks inside the window", () => {
    const rows = [
      { at: -10, up: false }, // before
      { at: 10, up: true },
      { at: 20, up: true },
      { at: HOUR + 10, up: false }, // after
    ];
    expect(uptimeRatio(rows, [], 0, HOUR)).toBe(1);
  });

  it("treats the window as half-open [from, to)", () => {
    expect(uptimeRatio([{ at: 0, up: true }], [], 0, HOUR)).toBe(1);
    expect(uptimeRatio([{ at: HOUR, up: false }], [], 0, HOUR)).toBeNull();
  });

  it("combines raw checks with rollups without double counting the seam", () => {
    // The raw window starts at HOUR; the rollup covers the hour before it.
    const rollups = [{ hourStartedAt: 0, upCount: 9, downCount: 1 }];
    const raw = [
      { at: HOUR, up: true },
      { at: HOUR + 1, up: true },
    ];
    // 9 up + 1 down + 2 up = 11/12
    expect(uptimeRatio(raw, rollups, 0, 2 * HOUR)).toBeCloseTo(11 / 12, 10);
  });

  it("ignores a rollup bucket that starts outside the window", () => {
    const rollups = [
      { hourStartedAt: -HOUR, upCount: 100, downCount: 0 },
      { hourStartedAt: 0, upCount: 1, downCount: 1 },
    ];
    expect(uptimeRatio([], rollups, 0, HOUR)).toBe(0.5);
  });

  it("returns 0 when every observation is down", () => {
    expect(uptimeRatio([{ at: 1, up: false }], [], 0, HOUR)).toBe(0);
  });

  it("includes a rollup bucket straddling the start of the window", () => {
    // Window [500, 2*HOUR). Bucket at 0 covers [0, HOUR), which overlaps the window.
    // An outage in that hour must not vanish from the figure.
    const rollups = [
      { hourStartedAt: 0, upCount: 99, downCount: 1 },
      { hourStartedAt: HOUR, upCount: 100, downCount: 0 },
    ];
    expect(uptimeRatio([], rollups, 500, 2 * HOUR)).toBe(199 / 200);
  });

  it("includes a rollup bucket straddling the end of the window", () => {
    // Window [0, HOUR + 1). Bucket at HOUR covers [HOUR, 2*HOUR), which overlaps.
    const rollups = [
      { hourStartedAt: 0, upCount: 100, downCount: 0 },
      { hourStartedAt: HOUR, upCount: 99, downCount: 1 },
    ];
    expect(uptimeRatio([], rollups, 0, HOUR + 1)).toBe(199 / 200);
  });
});

describe("historyBuckets", () => {
  it("returns the requested number of buckets, oldest first", () => {
    const b = historyBuckets([], 0, 4 * HOUR, 4);
    expect(b).toHaveLength(4);
    expect(b.map((x) => x.startedAt)).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR]);
  });

  it("gives a bucket with no checks a null ratio, not zero", () => {
    // A gap where the runner was stopped must render as "no data", not as an
    // outage. This is the bar's most common wrong answer.
    const b = historyBuckets([{ at: 10, up: true }], 0, 2 * HOUR, 2);
    expect(b[0]?.ratio).toBe(1);
    expect(b[1]?.ratio).toBeNull();
  });

  it("places a check in the bucket containing its timestamp", () => {
    const rows = [
      { at: 0, up: true },
      { at: HOUR - 1, up: false },
      { at: HOUR, up: false },
    ];
    const b = historyBuckets(rows, 0, 2 * HOUR, 2);
    expect(b[0]?.ratio).toBe(0.5);
    expect(b[1]?.ratio).toBe(0);
  });

  it("returns an empty array for non-positive bucketCount", () => {
    expect(historyBuckets([], 0, HOUR, 0)).toEqual([]);
    expect(historyBuckets([], 0, HOUR, -1)).toEqual([]);
  });
});
