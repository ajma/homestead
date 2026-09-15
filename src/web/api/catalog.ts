import type { CatalogEntry } from "@shared/catalog/schema.js";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

export type { CatalogEntry } from "@shared/catalog/schema.js";

/**
 * `GET /api/catalog`, fetched lazily rather than on mount — this is a plain type-only
 * import from `@shared/catalog/schema.js` (never `@shared/catalog/index.js`, which
 * eagerly parses the 50-entry `catalog.json`), so nothing here pulls the catalog's
 * data into the client bundle. `useCatalogBrowser`'s `enabled` flag is what actually
 * keeps the request itself from firing until `CreateAppDialog`'s browse panel opens —
 * same reasoning as `useScan` in `admin.ts`: opening the create dialog must never pay for
 * a browse nobody asked for.
 */
export function useCatalog(enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "catalog"],
    enabled,
    queryFn: () => apiFetch<CatalogEntry[]>("/api/catalog"),
    // The catalog only changes when Homestead itself ships a new version — never
    // during a session — so there is no reason to ever call it stale while cached.
    staleTime: Number.POSITIVE_INFINITY,
  });
}
