import type { CatalogueEntry } from "@shared/catalogue/schema.js";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

export type { CatalogueEntry } from "@shared/catalogue/schema.js";

/**
 * `GET /api/catalogue`, fetched lazily rather than on mount — this is a plain type-only
 * import from `@shared/catalogue/schema.js` (never `@shared/catalogue/index.js`, which
 * eagerly parses the 50-entry `catalogue.json`), so nothing here pulls the catalogue's
 * data into the client bundle. `useCatalogueBrowser`'s `enabled` flag is what actually
 * keeps the request itself from firing until `CreateAppDialog`'s browse panel opens —
 * same reasoning as `useScan` in `admin.ts`: opening the create dialog must never pay for
 * a browse nobody asked for.
 */
export function useCatalogue(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "catalogue"],
    enabled,
    queryFn: () => apiFetch<CatalogueEntry[]>("/api/catalogue"),
    // The catalogue only changes when Homestead itself ships a new version — never
    // during a session — so there is no reason to ever call it stale while cached.
    staleTime: Number.POSITIVE_INFINITY,
  });
}
