import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const normalised = url === ":memory:" ? ":memory:" : `file:${url}`;
  return drizzle(createClient({ url: normalised }), { schema });
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: "./drizzle" });
}
