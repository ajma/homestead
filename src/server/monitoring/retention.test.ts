import { createDb, runMigrations } from "@server/db/client";
import { apps, checkResults, checkRollups, hosts, probes } from "@server/db/schema";
import { runRetention } from "@server/monitoring/retention";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const HOUR = 3600;
/** A round hour boundary, so the arithmetic in the test is obvious. */
const T0 = 1_800_000_000 - (1_800_000_000 % HOUR);

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
  return { db, probeId };
}

const sample = (probeId: string, checkedAt: number, status: string, latencyMs?: number) => ({
  id: ulid(),
  probeId,
  status: status as never,
  checkedAt,
  latencyMs: latencyMs ?? null,
  faultClass: null,
  detail: null,
});

describe("runRetention", () => {
  it("aggregates a complete hour into one rollup row", async () => {
    const { db, probeId } = await seed();
    await db
      .insert(checkResults)
      .values([
        sample(probeId, T0 + 10, "up", 10),
        sample(probeId, T0 + 20, "up", 30),
        sample(probeId, T0 + 30, "down"),
        sample(probeId, T0 + 40, "degraded"),
      ]);
    const out = await runRetention(db, T0 + HOUR + 60);
    expect(out.hoursRolled).toBe(1);

    const [rollup] = await db.select().from(checkRollups);
    expect(rollup).toMatchObject({
      probeId,
      hourStart: T0,
      upCount: 2,
      downCount: 1,
      degradedCount: 1,
      avgLatencyMs: 20,
      maxLatencyMs: 30,
    });
  });

  it("does not roll up the hour still in progress", async () => {
    const { db, probeId } = await seed();
    await db.insert(checkResults).values([sample(probeId, T0 + 10, "up")]);
    // We are inside T0's hour, so it is incomplete.
    expect((await runRetention(db, T0 + 60)).hoursRolled).toBe(0);
    expect(await db.select().from(checkRollups)).toHaveLength(0);
  });

  it("catches up several hours after downtime", async () => {
    // The job runs hourly, but the machine may have been off. Rolling only the previous
    // hour would silently lose everything older.
    const { db, probeId } = await seed();
    await db
      .insert(checkResults)
      .values([
        sample(probeId, T0 + 10, "up"),
        sample(probeId, T0 + HOUR + 10, "up"),
        sample(probeId, T0 + 2 * HOUR + 10, "down"),
      ]);
    expect((await runRetention(db, T0 + 3 * HOUR + 60)).hoursRolled).toBe(3);
    expect(await db.select().from(checkRollups)).toHaveLength(3);
  });

  it("rolls every hour across separate invocations, not only the probe's first", async () => {
    // C1 regression: `HAVING NOT EXISTS` correlated on the bare alias degrades to
    // "this probe has no rollup row at all" once one exists, so every hour after the
    // first is silently skipped. That only shows up ACROSS separate `runRetention`
    // calls — a single call grouping several un-rolled hours at once (the "catches up"
    // test above) passes either way, because there is no pre-existing rollup row yet.
    const { db, probeId } = await seed();

    await db.insert(checkResults).values([sample(probeId, T0 + 10, "up")]);
    expect((await runRetention(db, T0 + HOUR + 60)).hoursRolled).toBe(1);

    await db.insert(checkResults).values([sample(probeId, T0 + HOUR + 10, "up")]);
    expect((await runRetention(db, T0 + 2 * HOUR + 60)).hoursRolled).toBe(1);

    await db.insert(checkResults).values([sample(probeId, T0 + 2 * HOUR + 10, "up")]);
    expect((await runRetention(db, T0 + 3 * HOUR + 60)).hoursRolled).toBe(1);

    const hours = (await db.select().from(checkRollups))
      .map((r) => r.hourStart)
      .sort((a, b) => a - b);
    expect(hours).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR]);
  });

  it("is idempotent by skipping rolled hours, not by failing on them", async () => {
    // Row counts alone cannot tell the two apart. With `HAVING NOT EXISTS` removed the
    // composite primary key rejects the duplicate and the catch swallows it, leaving
    // exactly the same rows — so this asserts the second run reported NO error, which
    // only holds if the clause did the skipping.
    const { db, probeId } = await seed();
    await db.insert(checkResults).values([sample(probeId, T0 + 10, "up")]);

    const errors: unknown[] = [];
    await runRetention(db, T0 + HOUR + 60, (error) => errors.push(error));
    await runRetention(db, T0 + HOUR + 60, (error) => errors.push(error));

    expect(errors).toEqual([]);
    const rows = await db.select().from(checkRollups);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.upCount).toBe(1);
  });

  it("reports a failure rather than swallowing it", async () => {
    const { db } = await seed();
    const errors: unknown[] = [];
    const original = db.run.bind(db);
    // biome-ignore lint/suspicious/noExplicitAny: narrow double over one method
    (db as any).run = () => {
      throw new Error("SQLITE_IOERR");
    };
    try {
      await expect(runRetention(db, T0 + HOUR + 60, (e) => errors.push(e))).resolves.toBeDefined();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (db as any).run = original;
    }
    expect(String(errors[0])).toContain("SQLITE_IOERR");
  });

  it("prunes raw samples older than 48 hours but keeps newer ones", async () => {
    const { db, probeId } = await seed();
    const now = T0 + 100 * HOUR;
    await db
      .insert(checkResults)
      .values([sample(probeId, now - 49 * HOUR, "up"), sample(probeId, now - 47 * HOUR, "up")]);
    await runRetention(db, now);
    const remaining = await db.select().from(checkResults);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.checkedAt).toBe(now - 47 * HOUR);
  });

  it("prunes rollups older than 90 days", async () => {
    const { db, probeId } = await seed();
    const now = T0 + 200 * 24 * HOUR;
    await db.insert(checkRollups).values([
      { probeId, hourStart: now - 91 * 24 * HOUR, upCount: 1 },
      { probeId, hourStart: now - 89 * 24 * HOUR, upCount: 1 },
    ]);
    await runRetention(db, now);
    const remaining = await db.select().from(checkRollups);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.hourStart).toBe(now - 89 * 24 * HOUR);
  });

  it("rolls up before pruning, so a 49-hour-old sample is not lost unaggregated", async () => {
    // Ordering matters: prune first and the oldest hour vanishes without ever being
    // summarised, leaving a hole in the 30-day timeline.
    const { db, probeId } = await seed();
    const now = T0 + 50 * HOUR;
    await db.insert(checkResults).values([sample(probeId, T0 + 10, "up")]);
    await runRetention(db, now);
    expect(await db.select().from(checkResults)).toHaveLength(0);
    const [rollup] = await db.select().from(checkRollups).where(eq(checkRollups.probeId, probeId));
    expect(rollup?.upCount).toBe(1);
  });

  it("does not throw when the database rejects a write", async () => {
    const { db } = await seed();
    const original = db.insert.bind(db);
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
    (db as any).insert = () => {
      throw new Error("SQLITE_BUSY");
    };
    try {
      await expect(runRetention(db, T0 + HOUR + 60)).resolves.toMatchObject({ hoursRolled: 0 });
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (db as any).insert = original;
    }
  });
});
