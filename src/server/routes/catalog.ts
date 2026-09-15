import { CATALOG } from "@shared/catalog/index.js";
import type { FastifyInstance } from "fastify";
import { requireCapability } from "../auth/context.js";

/**
 * Task 4's one route: the fifty-entry app catalog Tasks 1-3 built and verified, served
 * whole rather than paginated or searched server-side — fifty entries with compose bodies
 * is real weight (`catalog.json` is ~30KB) but not enough to justify anything beyond a
 * single GET, and the task brief is explicit that server-side search is out of scope.
 * `CreateAppDialog`'s browse panel filters the response client-side once it has it.
 *
 * `app:config` — the same capability `POST /api/apps` requires — not `app:read`. Browsing
 * the catalog only matters to whoever can act on it, and this project proves the
 * viewer/admin boundary by route, not by hiding a button: a viewer hitting this endpoint
 * directly gets a 403, the same as if they tried to create an app.
 *
 * Deliberately its own route file (not folded into `apps.ts`) so the import boundary is
 * visible at a glance: `@shared/catalog` is loaded here, in server code, and nowhere
 * under `src/web` — see `src/shared/catalog/index.ts`'s own doc comment for why that
 * boundary is what keeps fifty compose bodies out of the client's initial chunk.
 */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/catalog", async (request) => {
    requireCapability(request, "app:config");
    return CATALOG;
  });
}
