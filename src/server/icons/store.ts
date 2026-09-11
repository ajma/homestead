import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readBounded } from "./bounded-read.js";
import type { IconMetadata } from "./metadata.js";

const CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/svg";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ICON_BYTES = 512 * 1024;

/** Belt and braces beside the index check: shape, then membership. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Fetches an icon from the CDN once and serves it from disk thereafter.
 *
 * Two guards, both load-bearing:
 *
 * - A slug only becomes a URL if it is present in the metadata index. Without that, a
 *   caller chooses what the server fetches, which is an SSRF primitive on a machine
 *   sitting inside a home network.
 * - The resolved cache path must stay inside the cache directory. Without that, a slug
 *   containing `..` is an arbitrary-write primitive.
 *
 * The regex alone would be enough for both today; the index check is what keeps it true
 * if the regex is ever loosened.
 */
export class IconStore {
  private readonly cacheDir: string;
  private readonly metadata: IconMetadata;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { cacheDir: string; metadata: IconMetadata; fetchImpl?: typeof fetch }) {
    this.cacheDir = resolve(opts.cacheDir);
    this.metadata = opts.metadata;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchIcon(slug: string, variant: "light" | "dark" | null): Promise<Buffer | null> {
    if (!SAFE_SLUG.test(slug)) return null;
    if (!this.metadata.has(slug)) return null;

    const name = variant ? `${slug}-${variant}.svg` : `${slug}.svg`;
    const path = join(this.cacheDir, name);
    // The path check cannot fail given the regex above, and stays because the regex is
    // the kind of thing a later change loosens without thinking about this.
    if (resolve(path) !== path || !resolve(path).startsWith(`${this.cacheDir}/`)) return null;

    try {
      return await readFile(path);
    } catch {
      // Not cached yet.
    }

    const body = await this.download(`${CDN}/${name}`);
    if (!body) return null;

    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(path, body);
    } catch {
      // Serve it anyway; a failed cache write is not a failed request.
    }
    return body;
  }

  private async download(url: string): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) return null;
      // An icon is a few KB. Anything past MAX_ICON_BYTES is not an icon — a hostile or
      // broken CDN response — and `readBounded` stops pulling the stream the moment the
      // cap is crossed, rather than buffering the whole thing first and checking after.
      return await readBounded(response, MAX_ICON_BYTES);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
