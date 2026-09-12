import { describe, expect, it } from "vitest";
import { completionsEnabled } from "./desktop-only";

function windowWith(
  pointer: "fine" | "coarse",
  innerWidth: number,
): Pick<Window, "matchMedia" | "innerWidth"> {
  return {
    matchMedia: (query: string) => ({ matches: query.includes(pointer) }) as MediaQueryList,
    innerWidth,
  };
}

describe("completionsEnabled", () => {
  it("is true for a fine pointer on a wide window", () => {
    expect(completionsEnabled(windowWith("fine", 1024))).toBe(true);
  });

  it("is false for a coarse pointer even when wide", () => {
    expect(completionsEnabled(windowWith("coarse", 1024))).toBe(false);
  });

  it("is false for a fine pointer on a narrow window", () => {
    expect(completionsEnabled(windowWith("fine", 500))).toBe(false);
  });

  it("is false when matchMedia is missing entirely", () => {
    const win = { innerWidth: 1024 } as unknown as Pick<Window, "matchMedia" | "innerWidth">;
    expect(completionsEnabled(win)).toBe(false);
  });

  it("is false when matchMedia throws rather than propagating", () => {
    const win: Pick<Window, "matchMedia" | "innerWidth"> = {
      matchMedia: () => {
        throw new Error("no media queries here");
      },
      innerWidth: 1024,
    };
    expect(completionsEnabled(win)).toBe(false);
  });
});
