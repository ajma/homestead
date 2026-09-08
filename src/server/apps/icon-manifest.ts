import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "./icon-search.js";

export const MANIFEST_FILE = "tree.json";

/**
 * The dashboard-icons index.
 *
 * Pinned to `homarr-labs`, the repository's current owner. The resolver in
 * `icons.ts` still names `walkxcode`, which resolves only because jsDelivr
 * follows the rename — a dependency on a redirect.
 */
const MANIFEST_URL =
  "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/tree.json";

/** A week. The set grows steadily and never urgently. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every icon slug, from cache when it is fresh and from the network when it is
 * not.
 *
 * Never throws. The picker this feeds is a convenience over a URL field that
 * works regardless, so a box with no outbound internet gets an empty list
 * rather than a broken form. A failed refresh keeps the cache it has: throwing
 * away known-good data because a refresh failed is the worse outcome.
 */
export async function loadIconNames(opts: {
  cacheDir: string;
  fetch?: typeof fetch;
  now?: number;
}): Promise<string[]> {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  const path = join(opts.cacheDir, MANIFEST_FILE);

  let cached: string | null = null;
  let fresh = false;
  try {
    const info = await stat(path);
    cached = await readFile(path, "utf8");
    fresh = now - info.mtimeMs < MAX_AGE_MS;
  } catch {
    // No cache yet.
  }

  if (cached !== null && fresh) return parseManifest(cached);

  try {
    const response = await fetchFn(MANIFEST_URL);
    // A 404 body cached would poison the picker for a week.
    if (!response.ok) return cached === null ? [] : parseManifest(cached);
    const body = await response.text();
    const names = parseManifest(body);
    // Only cache something that parsed: an empty result from a mangled body
    // should be retried, not remembered.
    if (names.length > 0) {
      await mkdir(opts.cacheDir, { recursive: true });
      await writeFile(path, body, "utf8");
    }
    return names;
  } catch {
    return cached === null ? [] : parseManifest(cached);
  }
}
