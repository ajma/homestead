import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The bug this guards against: `` `lg:${PAGE_MAX_WIDTH}` `` reads exactly like a real
 * Tailwind class to a human, but Tailwind's scanner only recognises class names it can
 * see as a complete literal string in the source. A variant prefix (`lg:`, `dark:`,
 * `hover:`, ...) glued onto an interpolated value at build time never appears as a whole
 * word anywhere in the source text, so the scanner never emits a rule for it — the class
 * lands in the DOM and does nothing, silently. `EditApp.tsx`'s content row shipped
 * exactly this (`` lg:${PAGE_MAX_WIDTH} ``) and every test of it still passed, because
 * jsdom has no CSS engine and can't tell a live class from a dead one; only reading the
 * source text for the shape of the mistake catches it.
 *
 * This is a source scan, not a build-output check: it is cheap, needs no build step, and
 * catches the mistake at the moment it's typed rather than after a `pnpm build`. What it
 * cannot catch:
 *  - a class assembled by interpolation that has NO variant prefix (e.g. `` `${cls}` ``
 *    used wholesale as an unprefixed class) — that shape is normal, working Tailwind
 *    (see `PAGE_SHELL`, `${PAGE_MAX_WIDTH}` used bare throughout this codebase) and is
 *    indistinguishable by source shape alone from a broken one; only cross-referencing
 *    against Tailwind's generated CSS could tell those apart, which this does not do.
 *  - a fully dynamic class string built with no adjacent variant colon at all (e.g.
 *    picking one of several complete class names from a lookup table) — a different,
 *    already-known Tailwind footgun this file doesn't attempt to cover.
 *  - any Tailwind class typo or omission that doesn't involve interpolation.
 */
describe("Tailwind class construction", () => {
  const offenders: Array<{ file: string; match: string }> = [];
  const pattern = /[A-Za-z][A-Za-z0-9_-]*:\$\{/g;

  function walk(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (/\.(tsx?|jsx?)$/.test(entry.name)) return [path];
      return [];
    });
  }

  // Excludes itself: the doc comment above quotes the offending shape verbatim as an
  // example, which would otherwise flag this file against its own pattern.
  const self = "src/web/tailwind-class-construction.test.ts";
  for (const file of walk("src/web")) {
    if (file === self) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      offenders.push({ file, match: match[0] });
    }
  }

  it("never glues a variant prefix onto an interpolated value inside a template literal", () => {
    // A real failure here names the offending file(s) directly rather than just
    // asserting `offenders` is empty, so a future hit doesn't require re-running the
    // scan by hand to find what tripped it.
    expect(offenders).toEqual([]);
  });
});
