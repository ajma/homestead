import { afterEach, describe, expect, it } from "vitest";
import { readStoredScheme, resolveScheme, storeScheme } from "./theme.js";

const REAL_STORAGE = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

afterEach(() => {
  if (REAL_STORAGE)
    Object.defineProperty(globalThis, "localStorage", REAL_STORAGE);
});

/**
 * Chromium with site data blocked throws on the property *access*, not on the
 * call — which is why an unwrapped `localStorage.getItem` takes the whole app
 * down rather than one read.
 */
function blockSiteData() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      const err = new Error("Access is denied for this document.");
      err.name = "SecurityError";
      throw err;
    },
  });
}

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

describe("a browser with site data blocked", () => {
  it("reads the scheme as 'system' instead of throwing", () => {
    // ThemeToggle calls this from a mount effect inside the shell. An
    // unguarded throw there propagates out of the effect and React 19 unmounts
    // the tree — a blank app on every authenticated page.
    blockSiteData();
    expect(() => readStoredScheme()).not.toThrow();
    expect(readStoredScheme()).toBe("system");
  });

  it("swallows a failed write rather than taking the toggle with it", () => {
    // The scheme is still applied to the document; it just will not survive a
    // reload. That is the whole cost, and it is the right one.
    blockSiteData();
    expect(() => storeScheme("dark")).not.toThrow();
    expect(() => storeScheme("system")).not.toThrow();
  });

  it("still remembers a stored choice when storage does work", () => {
    // The other half: a guard that returned "system" unconditionally would
    // pass the tests above and quietly break the feature.
    localStorage.setItem("homestead.color-scheme", "dark");
    expect(readStoredScheme()).toBe("dark");
    storeScheme("light");
    expect(readStoredScheme()).toBe("light");
    storeScheme("system");
    expect(readStoredScheme()).toBe("system");
  });
});
