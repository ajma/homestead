import { ensureLocalHost, LOCAL_HOST_ID } from "@server/bootstrap";
import { createDb, runMigrations } from "@server/db/client";
import { hosts } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const config = {
  composeRoot: "/volume2/docker",
  dockerSocket: "/var/run/docker.sock",
};

async function freshDb() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  return db;
}

describe("ensureLocalHost", () => {
  it("creates the row on first run", async () => {
    const db = await freshDb();
    const id = await ensureLocalHost(db, config);
    expect(id).toBe(LOCAL_HOST_ID);
    const [row] = await db.select().from(hosts).where(eq(hosts.id, LOCAL_HOST_ID));
    expect(row?.composeRoot).toBe("/volume2/docker");
  });

  it("is idempotent across restarts", async () => {
    const db = await freshDb();
    await ensureLocalHost(db, config);
    await ensureLocalHost(db, config);
    expect(await db.select().from(hosts)).toHaveLength(1);
  });

  it("updates the paths when configuration changes", async () => {
    const db = await freshDb();
    await ensureLocalHost(db, config);
    await ensureLocalHost(db, {
      ...config,
      composeRoot: "/mnt/pool/docker",
    });
    const [row] = await db.select().from(hosts);
    expect(row?.composeRoot).toBe("/mnt/pool/docker");
    expect(await db.select().from(hosts)).toHaveLength(1);
  });
});
