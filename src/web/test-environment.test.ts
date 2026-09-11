import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOCBLOCK = "// @vitest-environment jsdom";

function tsxTests(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tsxTests(path));
    else if (entry.name.endsWith(".test.tsx")) found.push(path);
  }
  return found;
}

/**
 * Vitest 5 removed `environmentMatchGlobs`, so the jsdom environment is opted into per
 * file with a docblock. Forgetting it is only a loud failure for a test that renders:
 * measured, a `.tsx` test asserting `expect(1 + 1).toBe(2)` and nothing else passes
 * silently in the node environment, having tested nothing about the browser it claims
 * to be testing.
 *
 * This is the guard for that. It is a lint rule wearing a test's clothes, and it lives
 * here rather than in Biome because Biome has no rule for "this file must start with
 * this comment".
 */
describe("every .tsx test opts into jsdom", () => {
  const files = tsxTests("src/web");

  it("finds the .tsx tests at all, so an empty sweep cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s declares the jsdom environment", (file) => {
    expect(readFileSync(file, "utf8").startsWith(DOCBLOCK)).toBe(true);
  });
});
