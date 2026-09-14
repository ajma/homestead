/**
 * The parsed, validated app catalogue.
 *
 * Deliberately its own module rather than re-exported from `@shared` barrel files: the
 * catalogue is meant to stay out of the client's initial chunk (task brief) until whatever
 * later task wires a picker up to it, and that only holds if nothing imports this module
 * from client code today. Grep for `catalogue` under `src/web` before adding such an
 * import — if it is not there, the chunk-size gate this task recorded is still valid.
 *
 * Parsing eagerly, at import time, rather than lazily on first use: a malformed
 * `catalogue.json` is a build-time defect, and failing the moment anything imports this
 * module surfaces that immediately rather than on whichever request happens to touch the
 * catalogue first.
 */
import raw from "./catalogue.json";
import { type CatalogueEntry, catalogueSchema } from "./schema.js";

export const CATALOGUE: readonly CatalogueEntry[] = catalogueSchema.parse(raw);

export type { CatalogueCategory, CatalogueEntry } from "./schema.js";
export { CATALOGUE_CATEGORIES, catalogueEntrySchema, catalogueSchema } from "./schema.js";
