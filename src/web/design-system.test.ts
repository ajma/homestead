import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "src/web";
const ALLOWED = new Set(["src/web/theme.css"]);

/** Tailwind palette utilities — the tokens are semantic, so these must not appear. */
const PALETTE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|decoration|shadow|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (
      /\.(tsx|ts|css)$/.test(e.name) &&
      !/\.test\.(tsx|ts)$/.test(e.name)
    )
      out.push(p);
  }
  return out;
}

describe("design system conformance", () => {
  it("no component uses a Tailwind palette utility or a raw hex colour", async () => {
    const offenders: string[] = [];
    for (const file of await walk(ROOT)) {
      if (ALLOWED.has(file)) continue;
      const text = await readFile(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (PALETTE.test(line))
          offenders.push(`${file}:${i + 1} palette utility: ${line.trim()}`);
        if (HEX.test(line))
          offenders.push(`${file}:${i + 1} hex colour: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
