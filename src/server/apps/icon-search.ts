/** Search over the dashboard-icons set. Pure: the caller supplies the names. */

const MAX_RESULTS = 25;

/**
 * The png names from a dashboard-icons `tree.json`, as slugs.
 *
 * Anything unreadable yields an empty list rather than throwing. A box with no
 * outbound internet has never fetched the manifest, and the icon field must
 * still work there — the URL escape hatch does not depend on this.
 */
export function parseManifest(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const png = (parsed as { png?: unknown }).png;
  if (!Array.isArray(png)) return [];
  return png
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.replace(/\.png$/i, ""));
}

/**
 * Names matching `query`, best first.
 *
 * Ranked exact, then prefix, then anywhere: typing a whole name and finding it
 * third is the search failing. An empty query returns nothing — 2798 icons is
 * not a useful answer to "".
 */
export function searchIcons(names: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];

  const exact: string[] = [];
  const prefix: string[] = [];
  const anywhere: string[] = [];
  for (const name of names) {
    const n = name.toLowerCase();
    if (n === q) exact.push(name);
    else if (n.startsWith(q)) prefix.push(name);
    else if (n.includes(q)) anywhere.push(name);
  }

  return [...exact, ...prefix, ...anywhere].slice(0, MAX_RESULTS);
}

/**
 * An icon to offer before the operator types, or null.
 *
 * Only an exact match on the project's slug. Most self-hosted projects are
 * named after the app they run, so this is right surprisingly often — and a
 * near miss is worse than nothing, because a wrong icon looks deliberate and
 * nobody goes looking for why.
 */
export function suggestSlug(names: string[], slug: string): string | null {
  const s = slug.trim().toLowerCase();
  if (s === "") return null;
  return names.find((n) => n.toLowerCase() === s) ?? null;
}
