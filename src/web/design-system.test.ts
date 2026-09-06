import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

const ROOT = "src/web";
const ALLOWED = new Set(["src/web/theme.css"]);

/** Tailwind palette utilities — the tokens are semantic, so these must not appear. */
const PALETTE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|decoration|shadow|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;

/**
 * A colour-carrying utility, with any variant prefixes attached. Tailwind
 * silently drops utilities it does not recognise — no build error, no lint
 * error — so `text-text-muted` (there is no `--color-text-muted`) rendered as
 * unstyled text and shipped through two reviews. Comments are stripped before
 * this runs; in TypeScript a hyphenated token elsewhere is inside a string.
 */
const UTILITY =
  /(?<![\w-])((?:[a-z-]+:)*-?(?:bg|text|border|ring|outline|fill|stroke|divide|placeholder|caret|decoration|accent|shadow|from|via|to)-[a-z0-9][a-z0-9./%_-]*)(?![\w-])/g;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

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

const require = createRequire(import.meta.url);

/** Compile the app's real stylesheet against a fixed set of candidates. */
async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(await readFile(`${ROOT}/index.css`, "utf8"), {
    base: resolve(ROOT),
    loadStylesheet: async (id, base) => {
      const path = id.startsWith(".")
        ? resolve(base, id)
        : require.resolve(id.endsWith(".css") ? id : `${id}/index.css`);
      return {
        path,
        base: dirname(path),
        content: await readFile(path, "utf8"),
      };
    },
  });
  return compiler.build(candidates);
}

/** `.` `:` `/` and `%` are escaped inside a Tailwind class selector. */
function selectorFor(candidate: string): string {
  return `.${candidate.replace(/([.:/%])/g, "\\$1")}`;
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

  it("every colour utility a component uses resolves to a real rule", async () => {
    const candidates = new Map<string, string>();
    for (const file of await walk(ROOT)) {
      if (!/\.tsx?$/.test(file)) continue;
      const text = (await readFile(file, "utf8")).replace(COMMENTS, " ");
      for (const match of text.matchAll(UTILITY)) {
        const withVariants = match[1];
        if (!withVariants) continue;
        // Variants are Tailwind's own; only the utility can be misspelled.
        const candidate = withVariants.slice(withVariants.lastIndexOf(":") + 1);
        if (!candidates.has(candidate)) candidates.set(candidate, file);
      }
    }
    expect(candidates.size).toBeGreaterThan(0);

    const css = await buildCss([...candidates.keys()]);
    const unresolved = [...candidates]
      .filter(([candidate]) => !css.includes(selectorFor(candidate)))
      .map(([candidate, file]) => `${file}: ${candidate} emits no CSS`);
    expect(unresolved).toEqual([]);
  });

  it("the resolution check can fail", async () => {
    // Guards the gate above: if compilation ever silently produced nothing, or
    // matched everything, the check would be worthless in either direction.
    const css = await buildCss(["text-muted", "text-text-muted"]);
    expect(css).toContain(selectorFor("text-muted"));
    expect(css).not.toContain(selectorFor("text-text-muted"));
  });
});
