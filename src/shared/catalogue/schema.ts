/**
 * The shape of one app-catalogue entry, and everything that can be checked about it
 * without a network call.
 *
 * What this schema does NOT and cannot verify: that the image tag actually exists in its
 * registry, or that the icon slug exists in `homarr-labs/dashboard-icons`. Both require a
 * network round trip, which a schema parse (run inside `vitest run`, which must make no
 * network calls) must never do. Those two checks live in `scripts/verify-catalogue.ts`,
 * run by hand. A green `vitest run` here means "well-formed"; a green
 * `verify-catalogue.ts` means "well-formed AND resolvable" — see that script's own header
 * for what neither of them means.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The catalogue's controlled vocabulary for browsing. Deliberately short: a category list
 * that grows to match every app's own marketing copy stops being useful for narrowing a
 * list of fifty. Add a value here only when an entry genuinely fits none of the existing
 * ones — not as a synonym for one that already covers it.
 */
export const CATALOGUE_CATEGORIES = [
  "media",
  "photos",
  "productivity",
  "monitoring",
  "networking",
  "development",
  "home-automation",
  "documents",
  "finance",
  "utilities",
] as const;

export type CatalogueCategory = (typeof CATALOGUE_CATEGORIES)[number];

/**
 * Kebab-case, no path separators, no leading/trailing/doubled hyphen. `slug` doubles as
 * the app's default directory name once an app is created FROM a catalogue entry (task
 * brief), so it inherits `PathGuard`'s constraints (`src/server/host/paths.ts`) — a slug
 * with a `/` in it must fail HERE, at catalogue-authoring time, rather than surfacing as a
 * `PathEscapeError` at create time.
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One sentence, rendered in a browsing list — long enough to say what the app is and,
 * when relevant, what it needs to start; short enough that fifty of them don't each wrap
 * onto three lines. */
const MAX_DESCRIPTION_LENGTH = 160;

/**
 * http(s) only — mirrors `src/server/routes/apps.ts`'s `launchUrlSchema` reasoning.
 * `z.string().url()` (or `z.url()`) accepts `javascript:`, `data:`, and scheme-relative
 * values, none of which are meaningful as a homepage link. Duplicated rather than
 * imported: that schema lives under `src/server`, and this module is shared with the
 * client bundle.
 */
const httpUrl = z.string().refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "homepage must be an http: or https: URL" },
);

/**
 * True when a parsed compose document has a non-empty `services` map — the one structural
 * property every entry's `compose` string must have, checked here (not just in a test) so
 * every consumer of `catalogueEntrySchema` gets it, not only whoever remembered to test for
 * it separately. This is NOT `docker compose config`: it does not resolve `image` syntax,
 * `depends_on` targets, interpolation, or anything else compose itself validates. That
 * stays with the real `docker compose config` in `scripts/verify-catalogue.ts`.
 */
function hasAtLeastOneService(compose: string): boolean {
  let doc: unknown;
  try {
    doc = parseYaml(compose);
  } catch {
    return false;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
  const services = (doc as Record<string, unknown>).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) {
    return false;
  }
  return Object.keys(services).length > 0;
}

export const catalogueEntrySchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(SLUG_PATTERN, "slug must be kebab-case: lowercase letters, digits, single hyphens"),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
  iconRef: z.string().min(1).max(64),
  homepage: httpUrl,
  categories: z
    .array(z.enum(CATALOGUE_CATEGORIES))
    .min(1, "an entry must be browsable under at least one category"),
  compose: z
    .string()
    .min(1)
    .refine(hasAtLeastOneService, "compose must parse as YAML with a non-empty services map"),
});

export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>;

export const catalogueSchema = z.array(catalogueEntrySchema);
