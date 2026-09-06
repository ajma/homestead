import { describe, expect, it } from "vitest";
import { resolveScheme } from "./theme.js";

describe("resolveScheme", () => {
  it("follows the OS when nothing is stored", () => {
    expect(resolveScheme(null, true)).toBe("dark");
    expect(resolveScheme(null, false)).toBe("light");
  });

  it("follows the OS when the stored value is 'system'", () => {
    expect(resolveScheme("system", true)).toBe("dark");
  });

  it("honours an explicit stored choice over the OS", () => {
    expect(resolveScheme("light", true)).toBe("light");
    expect(resolveScheme("dark", false)).toBe("dark");
  });

  it("falls back to the OS for an unrecognised stored value", () => {
    expect(resolveScheme("chartreuse", true)).toBe("dark");
  });
});
