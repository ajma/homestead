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

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: "./drizzle" });
}
