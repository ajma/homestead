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
