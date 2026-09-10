import { matchesStatusPattern } from "@server/monitoring/status-pattern";
import { describe, expect, it } from "vitest";

describe("matchesStatusPattern", () => {
  it.each([
    ["2xx,3xx", 200, true],
    ["2xx,3xx", 204, true],
    ["2xx,3xx", 301, true],
    ["2xx,3xx", 404, false],
    ["2xx,3xx", 500, false],
    ["200,204,301", 200, true],
    ["200,204,301", 201, false],
    ["4xx", 418, true],
    ["5xx", 503, true],
  ])("%s vs %i -> %s", (pattern, status, expected) => {
    expect(matchesStatusPattern(pattern, status)).toBe(expected);
  });

  it("tolerates whitespace and case in the pattern", () => {
    expect(matchesStatusPattern(" 2XX , 301 ", 204)).toBe(true);
    expect(matchesStatusPattern(" 2XX , 301 ", 301)).toBe(true);
  });

  it("rejects everything when the pattern is empty or nonsense", () => {
    // Failing CLOSED matters: a pattern that matches nothing shows the app as down, which
    // the user investigates. One that matches everything shows a dead app as healthy
    // forever, which they never find out about.
    for (const pattern of ["", "   ", "banana", ",,,"]) {
      expect(matchesStatusPattern(pattern, 200)).toBe(false);
    }
  });

  it("ignores an unparseable term but honours the rest", () => {
    expect(matchesStatusPattern("banana,2xx", 200)).toBe(true);
    expect(matchesStatusPattern("banana,2xx", 404)).toBe(false);
  });

  it("does not treat a class as a prefix match", () => {
    // `2xx` must not match 2, 20, or 2000.
    for (const status of [2, 20, 2000]) {
      expect(matchesStatusPattern("2xx", status)).toBe(false);
    }
  });
});
