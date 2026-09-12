import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { schema } from "./schema.js";

export async function createDb(dbPath: string) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const client = createClient({ url: dbPath === ":memory:" ? ":memory:" : `file:${dbPath}` });
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });
  return { client, db };
}

export type Db = Awaited<ReturnType<typeof createDb>>["db"];

/** The handle `Db["transaction"]`'s callback receives — extracted rather than imported
 * from drizzle directly, so callers that fold a second store's writes into one
 * transaction (`CloudflareCredentialStore.save`, `SecretStore.withDb`) can type against
 * exactly what `db.transaction()` actually hands them. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: "./drizzle" });
}
