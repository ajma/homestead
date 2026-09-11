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

  it("records what was observed in the sample and the debounced status on the probe", async () => {
    // These deliberately differ. A probe flapping below the threshold never confirms a
    // transition, so samples holding the debounced status would record uninterrupted
    // `up` and uptime would read 100% for an app failing every other minute.
    const { db, probe } = await seed();
    await persistResult(db, probe, { status: "up" }, opts);
    const [up] = await db.select().from(probes).where(eq(probes.id, probe.id));

    const transition = await persistResult(db, up as never, { status: "down" }, opts);
    expect(transition.status).toBe("up"); // held: one failure is not a confirmed outage

    const samples = await db.select().from(checkResults).orderBy(checkResults.checkedAt);
    expect(samples.map((s) => s.status)).toEqual(["up", "down"]);

    const [after] = await db.select().from(probes).where(eq(probes.id, probe.id));
    expect(after?.lastStatus).toBe("up");
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

  it("publishes when only the fault class moves, even though status stays down", async () => {
    // Containers already stopped (down/app), then the Docker socket wedges (down/network).
    // The status never changes, but the tile is now naming the wrong machine to fix, so
    // this has to be treated as a change for publication purposes.
    const { db, probe } = await seed();
    await persistResult(
      db,
      probe,
      { status: "down", faultClass: "app" },
      { ...opts, failureThreshold: 1 },
    );
    const [afterFirst] = await db.select().from(probes).where(eq(probes.id, probe.id));
    const second = await persistResult(
      db,
      afterFirst as never,
      { status: "down", faultClass: "network" },
      { ...opts, failureThreshold: 1 },
    );
    expect(second).toMatchObject({ status: "down", faultClass: "network", changed: true });
  });

  it("still reports no change for an identical re-observation of the same fault class", async () => {
    const { db, probe } = await seed();
    await persistResult(
      db,
      probe,
      { status: "down", faultClass: "app" },
      { ...opts, failureThreshold: 1 },
    );
    const [afterFirst] = await db.select().from(probes).where(eq(probes.id, probe.id));
    const second = await persistResult(
      db,
      afterFirst as never,
      { status: "down", faultClass: "app" },
      { ...opts, failureThreshold: 1 },
    );
    expect(second).toMatchObject({ status: "down", faultClass: "app", changed: false });
  });

  it("never publishes a fault-class move that only ever lived in an unconfirmed failure (up -> down(unconfirmed) -> up)", async () => {
    // The raw observation's fault class can flicker while the debounced status never
    // leaves `up` — that flicker is exactly the spam `changed` exists to suppress, since
    // the launcher never showed anything but `up` to explain.
    const { db, probe } = await seed();
    const threshold2 = { ...opts, failureThreshold: 2 };
    const first = await persistResult(db, probe, { status: "up" }, threshold2);
    expect(first).toMatchObject({ status: "up" });

    const [afterFirst] = await db.select().from(probes).where(eq(probes.id, probe.id));
    const second = await persistResult(
      db,
      afterFirst as never,
      { status: "down", faultClass: "network" },
      threshold2,
    );
    expect(second).toMatchObject({ status: "up", changed: false });

    const [afterSecond] = await db.select().from(probes).where(eq(probes.id, probe.id));
    const third = await persistResult(db, afterSecond as never, { status: "up" }, threshold2);
    expect(third).toMatchObject({ status: "up", changed: false });
  });

  it("publishes nothing for a fault class attached to a first failure held at unknown", async () => {
    const { db, probe } = await seed();
    const result = await persistResult(
      db,
      probe,
      { status: "down", faultClass: "config" },
      { ...opts, failureThreshold: 2 },
    );
    expect(result).toMatchObject({ status: "unknown", changed: false });
  });

  it("publishes nothing for a fault class that moves inside the grace window", async () => {
    // `starting` is the grace window a deliberate restart opens: flapping — including a
    // flapping fault class — is expected there and is the reason the window exists.
    const { db, probe } = await seed();
    const graceOpts = { now: NOW, graceUntil: NOW + 60_000, failureThreshold: 2 };
    const first = await persistResult(db, probe, { status: "down", faultClass: "app" }, graceOpts);
    expect(first).toMatchObject({ status: "starting" });

    const [afterFirst] = await db.select().from(probes).where(eq(probes.id, probe.id));
    const second = await persistResult(
      db,
      afterFirst as never,
      { status: "down", faultClass: "network" },
      graceOpts,
    );
    expect(second).toMatchObject({ status: "starting", changed: false });
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
