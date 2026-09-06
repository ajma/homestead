import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { settings } from "./schema.js";

export async function getSetting(
  db: Db,
  key: string,
): Promise<string | undefined> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return rows[0]?.value;
}

export async function setSetting(
  db: Db,
  key: string,
  value: string,
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}
