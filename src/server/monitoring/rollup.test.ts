import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { checkRollups, checks, devices, monitors } from "../db/schema.js";
import { RAW_RETENTION_MS, rollUpAndPrune } from "./rollup.js";

const HOUR = 3_600_000;

async function seed(): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db);
  await db.insert(devices).values({ id: "d", name: "nas", kind: "nas" });
  await db.insert(monitors).values({
    id: "m",
    targetType: "device",
    targetId: "d",
    type: "tcp",
    config: "{}",
    intervalSeconds: 60,
    timeoutMs: 1000,
    retries: 0,
    required: true,
    enabled: true,
    nextDueAt: 0,
  });
  return db;
}

const check = (id: string, at: number, up: boolean) => ({
  id,
  monitorId: "m",
  at,
  up,
});

describe("rollUpAndPrune", () => {
  it("aggregates old raw checks into hourly buckets", async () => {
    const db = await seed();
    const old = 0;
    await db
      .insert(checks)
      .values([
        check("a", old + 1, true),
        check("b", old + 2, true),
        check("c", old + 3, false),
      ]);
    const now = RAW_RETENTION_MS + 10 * HOUR;
    await rollUpAndPrune(db, now);
    const rows = await db
      .select()
      .from(checkRollups)
      .where(
        and(eq(checkRollups.monitorId, "m"), eq(checkRollups.hourStartedAt, 0)),
      );
    expect(rows[0]).toMatchObject({ upCount: 2, downCount: 1 });
  });

  it("prunes the raw rows it rolled up, and keeps the recent ones", async () => {
    const db = await seed();
    const now = RAW_RETENTION_MS + 10 * HOUR;
    await db
      .insert(checks)
      .values([check("old", 1, true), check("fresh", now - 1000, true)]);
    const { pruned } = await rollUpAndPrune(db, now);
    expect(pruned).toBe(1);
    const left = await db.select().from(checks);
    expect(left.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("a rerun over rows that were rolled but not pruned does not double the bucket", async () => {
    // Simulates a crash between the upsert and the prune: the hourly bucket is
    // written, but the raw rows survive, and the next run finds them again. An
    // additive upsert would double every historical figure, permanently, with no
    // error and no way to detect it from the data.
    const db = await seed();
    const rawChecks = [check("a", 1, true), check("b", 2, false)];
    await db.insert(checks).values(rawChecks);
    const now = RAW_RETENTION_MS + 10 * HOUR;
    await rollUpAndPrune(db, now);

    // Simulate crash: re-insert the same raw rows that should have been pruned
    await db.insert(checks).values(rawChecks);
    await rollUpAndPrune(db, now);

    const rows = await db.select().from(checkRollups);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ upCount: 1, downCount: 1 });
  });

  it("leaves everything alone when nothing is old enough", async () => {
    const db = await seed();
    const now = 10 * HOUR;
    await db.insert(checks).values([check("fresh", now - 1000, true)]);
    const result = await rollUpAndPrune(db, now);
    expect(result).toEqual({ rolled: 0, pruned: 0 });
    expect(await db.select().from(checks)).toHaveLength(1);
  });

  it("does not lose the first part of an hour the cutoff falls inside", async () => {
    // The cutoff is `now - 7 days`, so it is essentially never on an hour
    // boundary. Run 1 must not roll a half-hour and prune it, because run 2
    // would then find only the remainder and replace the bucket with it.
    const db = await seed();
    await db
      .insert(checks)
      .values([
        check("a", 100, true),
        check("b", 200, true),
        check("c", 300, true),
        check("d", 0.6 * HOUR, false),
        check("e", 0.7 * HOUR, false),
      ]);
    await rollUpAndPrune(db, RAW_RETENTION_MS + 0.5 * HOUR);
    await rollUpAndPrune(db, RAW_RETENTION_MS + 1.5 * HOUR);
    const rows = await db
      .select()
      .from(checkRollups)
      .where(
        and(eq(checkRollups.monitorId, "m"), eq(checkRollups.hourStartedAt, 0)),
      );
    expect(rows[0]).toMatchObject({ upCount: 3, downCount: 2 });
  });

  it("keeps monitors separate when checks fall in the same hour", async () => {
    // Without monitorId in the grouping key, a NAS that was up and a VM that
    // was down would merge into one shared bucket, making every historical
    // uptime figure fiction — permanently, with no error, and unrecoverable.
    const db = await seed();
    await db.insert(monitors).values({
      id: "m2",
      targetType: "device",
      targetId: "d",
      type: "tcp",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 1000,
      retries: 0,
      required: true,
      enabled: true,
      nextDueAt: 0,
    });

    const sameHour = 1000;
    await db.insert(checks).values([
      { id: "a1", monitorId: "m", at: sameHour, up: true },
      { id: "a2", monitorId: "m", at: sameHour + 1, up: true },
      { id: "b1", monitorId: "m2", at: sameHour, up: false },
      { id: "b2", monitorId: "m2", at: sameHour + 1, up: false },
    ]);

    const now = RAW_RETENTION_MS + 10 * HOUR;
    await rollUpAndPrune(db, now);

    const rows = await db.select().from(checkRollups);
    expect(rows).toHaveLength(2);

    const m1Bucket = rows.find((r) => r.monitorId === "m");
    const m2Bucket = rows.find((r) => r.monitorId === "m2");
    expect(m1Bucket).toMatchObject({ upCount: 2, downCount: 0 });
    expect(m2Bucket).toMatchObject({ upCount: 0, downCount: 2 });
  });
});
