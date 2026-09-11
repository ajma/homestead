import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Pinned so an upstream restructure cannot change behaviour without a code change. */
const METADATA_URL = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/metadata.json";

const FETCH_TIMEOUT_MS = 10_000;

export type IconMeta = {
  slug: string;
  aliases: string[];
  categories: string[];
  variants: string[];
};

type UpstreamEntry = { base?: string[]; aliases?: string[]; categories?: string[] };

/**
 * The dashboard-icons index: 3,238 icons, 1.15 MB, far too large to ship to a browser.
 *
 * Every failure path degrades to an empty index rather than throwing. A NAS that boots
 * without internet must still serve the launcher — letter tiles are the fallback — and
 * an icon service that rejects on boot would take the whole process with it.
 */
export class IconMetadata {
  private readonly cacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private index: IconMeta[] = [];
  private slugs = new Set<string>();

  constructor(opts: { cacheDir: string; fetchImpl?: typeof fetch }) {
    this.cacheDir = opts.cacheDir;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get size(): number {
    return this.index.length;
  }

  async load(): Promise<void> {
    const cachePath = join(this.cacheDir, "metadata.json");

    const fromNetwork = await this.fetchUpstream();
    if (fromNetwork) {
      this.build(fromNetwork);
      try {
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(cachePath, JSON.stringify(fromNetwork), "utf8");
      } catch {
        // A read-only or full disk costs us the cache, not the running index.
      }
      return;
    }

    try {
      this.build(JSON.parse(await readFile(cachePath, "utf8")));
    } catch {
      // No network and no usable cache. An empty index is a working launcher with
      // letter tiles; a throw here is a server that will not start.
      this.index = [];
      this.slugs = new Set();
    }
  }

  private async fetchUpstream(): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(METADATA_URL, { signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private build(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) {
      this.index = [];
      this.slugs = new Set();
      return;
    }
    this.index = Object.entries(raw as Record<string, UpstreamEntry>).map(([slug, entry]) => ({
      slug,
      aliases: Array.isArray(entry?.aliases) ? entry.aliases : [],
      categories: Array.isArray(entry?.categories) ? entry.categories : [],
      variants: Array.isArray(entry?.base) ? entry.base : ["svg"],
    }));
    this.slugs = new Set(this.index.map((i) => i.slug));
  }

  /** The SSRF guard: only a slug present in the index may ever become a fetch URL. */
  has(slug: string): boolean {
    return this.slugs.has(slug);
  }

  search(q: string, limit = 20): IconMeta[] {
    const needle = q.trim().toLowerCase();
    if (needle === "") return this.index.slice(0, limit);

    const scored: Array<{ icon: IconMeta; score: number }> = [];
    for (const icon of this.index) {
      const names = [icon.slug, ...icon.aliases];
      let best = 0;
      for (const name of names) {
        const lower = name.toLowerCase();
        if (lower === needle) best = Math.max(best, 3);
        else if (lower.startsWith(needle)) best = Math.max(best, 2);
        else if (lower.includes(needle)) best = Math.max(best, 1);
      }
      if (best > 0) scored.push({ icon, score: best });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.icon.slug.localeCompare(b.icon.slug))
      .slice(0, limit)
      .map((s) => s.icon);
  }
}
