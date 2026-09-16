import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { exposures } from "../db/schema.js";

/**
 * The exposure hostname for each of `appIds` that has one, in one grouped query — same
 * reasoning as `deployTimestamps`/`runningJobs` beside it: the per-row alternative is
 * one query per app on the screen that lists every app. `exposures.appId` is `.unique()`
 * (`db/schema.ts`), so there is at most one row per app; a `Map` is the shape of the
 * data, not a simplification of it.
 *
 * Any state counts — `provisioning`, `ready`, `error`, `drifted` all mean a row exists
 * and a hostname is recorded, which is all the inventory column needs (the exposure
 * tab, not this column, is where an admin goes to see or act on the state itself).
 */
export async function exposureHostnames(db: Db, appIds: string[]): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();

  const rows = await db
    .select({ appId: exposures.appId, hostname: exposures.hostname })
    .from(exposures)
    .where(inArray(exposures.appId, appIds));

  const map = new Map<string, string>();
  for (const row of rows) map.set(row.appId, row.hostname);
  return map;
}

/**
 * The same grouped query as `exposureHostnames` above, but narrowed to states where the
 * hostname is actually a live, routed destination — unlike that function (deliberately
 * "any state counts", per its own doc comment, because it only ever feeds a display
 * column), this one excludes `provisioning` (the sequence hasn't finished yet, there is
 * nothing live to open) and `error` (the last attempt failed). `ready` and `drifted` both
 * mean Cloudflare is actually routing the hostname right now — `drifted` only means some
 * RECORDED fact about it (the Access app's id, say) no longer matches what Cloudflare
 * reports, not that the hostname stopped resolving.
 *
 * Used by the launcher (`launcher/query.ts`) to decide whether a tile should link at the
 * public hostname: a tile that opens a 404 for a still-provisioning app is worse than one
 * that falls back to the app's own internal URL, or stays unclickable.
 */
export async function exposureLaunchTargets(db: Db, appIds: string[]): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();

  const rows = await db
    .select({ appId: exposures.appId, hostname: exposures.hostname, state: exposures.state })
    .from(exposures)
    .where(inArray(exposures.appId, appIds));

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.state === "ready" || row.state === "drifted") map.set(row.appId, row.hostname);
  }
  return map;
}
