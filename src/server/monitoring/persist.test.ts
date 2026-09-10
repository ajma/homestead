import { createDb, runMigrations } from "@server/db/client";
import { apps, checkResults, hosts, probes } from "@server/db/schema";
import { persistResult } from "@server/monitoring/persist";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

async function seed() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({ id: "local", name: "l", composeRoot: "/v", dockerSocket: "/s" });
  const appId = ulid();
  await db.insert(apps).values({
    id: appId,
    hostId: "local",
    slug: "j",
    displayName: "J",
    directory: "jellyfin",
    composeFile: "compose.yaml",
    projectName: "jellyfin",
  });
  const probeId = ulid();
  await db.insert(probes).values({ id: probeId, appId, kind: "docker" });
  const [probe] = await db.select().from(probes).where(eq(probes.id, probeId));
  if (!probe) throw new Error("seed failed");
  return { db, probe, appId };
}

const NOW = 1_800_000_000;
const opts = { now: NOW, graceUntil: null, failureThreshold: 2 };

describe("persistResult", () => {
  it("writes a sample and the denormalised state together", async () => {
    const { db, probe } = await seed();
    const out = await persistResult(db, probe, { status: "up", latencyMs: 12 }, opts);
    expect(out).toMatchObject({ status: "up", changed: true });

    const [sample] = await db.select().from(checkResults);
    expect(sample).toMatchObject({ probeId: probe.id, status: "up", latencyMs: 12 });

    const [updated] = await db.select().from(probes).where(eq(probes.id, probe.id));
    expect(updated).toMatchObject({
      lastStatus: "up",
      lastLatencyMs: 12,
      consecutiveFailures: 0,
      lastCheckedAt: NOW,
      statusSince: NOW,
    });
  });

  it("reports changed only on a confirmed transition", async () => {
    const { db, probe } = await seed();
    await persistResult(db, probe, { status: "up" }, opts);
    const [afterFirst] = await db.select().from(probes).where(eq(probes.id, probe.id));
    const second = await persistResult(db, afterFirst as never, { status: "up" }, opts);
    expect(second.changed).toBe(false);
  });

  it("holds the previous status until the failure threshold is met", async () => {
    const { db, probe } = await seed();
    await persistResult(db, probe, { status: "up" }, opts);
    const [up] = await db.select().from(probes).where(eq(probes.id, probe.id));
    const first = await persistResult(db, up as never, { status: "down" }, opts);
    expect(first).toMatchObject({ status: "up", changed: false });

    const [held] = await db.select().from(probes).where(eq(probes.id, probe.id));
    expect(held?.consecutiveFailures).toBe(1);
    const second = await persistResult(db, held as never, { status: "down" }, opts);
    expect(second).toMatchObject({ status: "down", changed: true });
  });

  it("stores the fault class and detail on both rows", async () => {
    const { db, probe } = await seed();
    await persistResult(
      db,
      probe,
      { status: "down", faultClass: "network", detail: { error: "timed out" } },
      { ...opts, failureThreshold: 1 },
    );
    const [sample] = await db.select().from(checkResults);
    expect(sample).toMatchObject({ faultClass: "network" });
    expect(sample?.detail).toEqual({ error: "timed out" });
    const [updated] = await db.select().from(probes).where(eq(probes.id, probe.id));
    expect(updated?.lastFaultClass).toBe("network");
  });

  it("writes nothing at all when the transaction fails", async () => {
    // The denormalised copy is only trustworthy because it cannot separate from its
    // sample. A half-write would leave the launcher showing a status no sample supports.
    const { db, probe } = await seed();
    const originalTransaction = db.transaction.bind(db);
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over transaction
    (db as any).transaction = async (fn: any) => {
      // biome-ignore lint/suspicious/noExplicitAny: patch tx.update to throw
      return originalTransaction(async (tx: any) => {
        tx.update = () => {
          throw new Error("SQLITE_BUSY");
        };
        return fn(tx);
      });
    };
    try {
      await expect(persistResult(db, probe, { status: "up" }, opts)).rejects.toThrow("SQLITE_BUSY");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (db as any).transaction = originalTransaction;
    }
    expect(await db.select().from(checkResults)).toHaveLength(0);
  });
});
