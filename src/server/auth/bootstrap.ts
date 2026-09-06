import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

const CLAIM_KEY = "admin_bootstrap_claimed";

export async function claimAdminBootstrap(db: Db): Promise<boolean> {
  const inserted = await db
    .insert(settings)
    .values({ key: CLAIM_KEY, value: new Date().toISOString() })
    .onConflictDoNothing()
    .returning({ key: settings.key });
  return inserted.length === 1;
}

export async function releaseAdminBootstrap(db: Db): Promise<void> {
  await db.delete(settings).where(eq(settings.key, CLAIM_KEY));
}
