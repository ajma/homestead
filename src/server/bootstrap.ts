import type { Db } from "./db/client.js";
import { hosts } from "./db/schema.js";

/** Matches the id `index.ts` passes to `new LocalHost(...)`. They must not drift. */
export const LOCAL_HOST_ID = "local";

/**
 * Ensures the row `apps.hostId` points at exists.
 *
 * Upserts rather than insert-if-absent so that changing HOMESTEAD_COMPOSE_ROOT is
 * reflected instead of silently ignored — the row is configuration, not history.
 */
export async function ensureLocalHost(
  db: Db,
  config: { composeRoot: string; dockerSocket: string },
): Promise<string> {
  await db
    .insert(hosts)
    .values({
      id: LOCAL_HOST_ID,
      name: "local",
      kind: "local",
      composeRoot: config.composeRoot,
      dockerSocket: config.dockerSocket,
    })
    .onConflictDoUpdate({
      target: hosts.id,
      set: { composeRoot: config.composeRoot, dockerSocket: config.dockerSocket },
    });

  return LOCAL_HOST_ID;
}
