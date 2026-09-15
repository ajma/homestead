/**
 * The parsed, validated app catalog.
 *
 * Deliberately its own module rather than re-exported from `@shared` barrel files: the
 * catalog is meant to stay out of the client's initial chunk (task brief) until whatever
 * later task wires a picker up to it, and that only holds if nothing imports this module
 * from client code today. Grep for `catalog` under `src/web` before adding such an
 * import — if it is not there, the chunk-size gate this task recorded is still valid.
 *
 * Parsing eagerly, at import time, rather than lazily on first use: a malformed
 * `catalog.json` is a build-time defect, and failing the moment anything imports this
 * module surfaces that immediately rather than on whichever request happens to touch the
 * catalog first.
 */
import raw from "./catalog.json";
import { type CatalogEntry, catalogSchema } from "./schema.js";

export const CATALOG: readonly CatalogEntry[] = catalogSchema.parse(raw);

export type { CatalogCategory, CatalogEntry } from "./schema.js";
export { CATALOG_CATEGORIES, catalogEntrySchema, catalogSchema } from "./schema.js";
