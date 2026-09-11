import { relativeTime } from "@web/lib/relative-time";
import { describe, expect, it } from "vitest";

const NOW = 1_800_000_000;

describe("relativeTime", () => {
  it("reads in seconds under a minute", () => {
    expect(relativeTime(NOW - 5, NOW)).toBe("5s");
  });
  it("reads in minutes under an hour", () => {
    expect(relativeTime(NOW - 12 * 60, NOW)).toBe("12m");
  });
  it("reads in hours under a day", () => {
    expect(relativeTime(NOW - 3 * 3600, NOW)).toBe("3h");
  });
  it("reads in days beyond that", () => {
    expect(relativeTime(NOW - 2 * 86400, NOW)).toBe("2d");
  });
  it("clamps a future timestamp to 0s rather than rendering '-4s'", () => {
    // Clock skew between the NAS and a phone is normal and must not produce
    // "Healthy · -4s", which reads as a bug in the product.
    expect(relativeTime(NOW + 4, NOW)).toBe("0s");
  });

  it.each([
    [59, "59s"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h"],
    [86_399, "23h"],
    [86_400, "1d"],
  ])("switches unit exactly at %is", (elapsed, expected) => {
    // Off-by-one at a unit boundary renders "60m" or "24h", which looks like a bug even
    // though nothing is wrong. Each boundary is asserted on both sides.
    expect(relativeTime(NOW - elapsed, NOW)).toBe(expected);
  });

  it("floors a fractional interval instead of rendering '12.4m'", () => {
    expect(relativeTime(NOW - 12.7 * 60, NOW)).toBe("12m");
  });

  it("does not fall over on an implausibly old timestamp", () => {
    // `statusSince` is nullable and defaults are easy to get wrong; a probe row seeded
    // with 0 must render something, not "NaNd" or "Infinityd".
    expect(relativeTime(0, NOW)).toMatch(/^\d+d$/);
  });
});
