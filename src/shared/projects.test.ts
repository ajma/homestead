import { describe, expect, it } from "vitest";
import { isReservedSlug, isValidSlug, RESERVED_SLUGS } from "./projects.js";

describe("isReservedSlug", () => {
  it("names only the segments the router would permanently shadow", () => {
    expect(RESERVED_SLUGS).toContain("new");
    for (const s of RESERVED_SLUGS) {
      expect(isReservedSlug(s), s).toBe(true);
      expect(isReservedSlug(s.toUpperCase()), s).toBe(true);
    }
    // Only the exact segment: `newsroom` is a perfectly good project name.
    expect(isReservedSlug("newsroom")).toBe(false);
    expect(isReservedSlug("new-stack")).toBe(false);
  });
});

describe("isValidSlug", () => {
  it("accepts ordinary project directory names", () => {
    for (const s of [
      "media",
      "immich",
      "home-assistant",
      "a1",
      "my.stack",
      "A_B",
    ])
      expect(isValidSlug(s), s).toBe(true);
  });

  it("rejects anything that could escape the projects root", () => {
    for (const s of [
      "..",
      "../etc",
      "a/b",
      ".hidden",
      "",
      "-leading",
      "a..b",
      "foo..bar",
    ])
      expect(isValidSlug(s), s).toBe(false);
  });

  /**
   * The separation that matters: a reserved name is a create-time policy, not
   * a path-safety failure. Folding it in here would also gate `GET` and
   * `DELETE`, so an adopted directory named `new` — already on the NAS —
   * would become unmanageable through the API instead of merely unopenable in
   * the UI. A rule about names we are about to mint must not be applied
   * retroactively to data that already exists.
   */
  it("still accepts a reserved name, because it is a safe path segment", () => {
    for (const s of RESERVED_SLUGS) expect(isValidSlug(s), s).toBe(true);
  });

  it("accepts slugs at the 64-character limit", () => {
    const atLimit = "a".repeat(64);
    expect(isValidSlug(atLimit)).toBe(true);
  });

  it("rejects slugs exceeding the 64-character limit", () => {
    const overLimit = "a".repeat(65);
    expect(isValidSlug(overLimit)).toBe(false);
  });
});
