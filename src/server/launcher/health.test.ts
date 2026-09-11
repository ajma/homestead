import { createDb, runMigrations } from "@server/db/client";
import { apps, checkRollups, hosts, probes } from "@server/db/schema";
import { appHealth, fetchRollupsInWindow } from "@server/launcher/health";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const HOUR = 3600;
const DAY = 86_400;
const NOW = 40 * DAY; // a round number of days, so bucket edges are unambiguous

async function fixture() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({ id: "l", name: "l", composeRoot: "/v", dockerSocket: "/s" });
  const appId = ulid();
  await db.insert(apps).values({
    id: appId,
    hostId: "l",
    slug: "j",
    displayName: "J",
    directory: "d",
    composeFile: "compose.yaml",
    projectName: "j",
  });
  return { db, appId };
}

describe("appHealth", () => {
  it("returns one signal per enabled probe, with a phrase and no raw detail", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({
      id: "p1",
      appId,
      kind: "docker",
      lastStatus: "down",
      lastFaultClass: "app",
      statusSince: 100,
      lastCheckedAt: 200,
      lastLatencyMs: 7,
      lastDetail: { body: "a secret response fragment" },
    });
    const { signals } = await appHealth(db, appId, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      probeId: "p1",
      kind: "docker",
      label: null,
      status: "down",
      reason: "Containers not running",
      since: 100,
      lastCheckedAt: 200,
      latencyMs: 7,
    });
    // The security property, asserted on the serialised shape rather than by eye.
    expect(JSON.stringify(signals)).not.toContain("secret response fragment");
  });

  it("omits disabled probes, which are not evidence of anything", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker", enabled: false });
    expect((await appHealth(db, appId, NOW)).signals).toEqual([]);
  });

  it("aggregates hourly rollups for one probe into that day's ratio", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    // Two hours on the same day must land in one bucket, combined before the ratio is taken.
    await db.insert(checkRollups).values([
      { probeId: "p1", hourStart: NOW - DAY, upCount: 50, downCount: 10 },
      { probeId: "p1", hourStart: NOW - DAY + HOUR, upCount: 30, downCount: 0 },
    ]);
    const { history } = await appHealth(db, appId, NOW);
    expect(history).toHaveLength(30);
    const yesterday = history.find((d) => d.dayStart === NOW - DAY);
    // up=80, down=10, total=90 samples. One probe, so its own ratio is also the day's ratio.
    expect(yesterday?.upRatio).toBeCloseTo(80 / 90);
    expect(yesterday?.downRatio).toBeCloseTo(10 / 90);
    expect(yesterday?.degradedRatio).toBe(0);
    expect(yesterday?.probeCount).toBe(1);
  });

  it("returns a zeroed, no-data bucket for a day with no rollups rather than a gap", async () => {
    // A sparkline with holes in it is unreadable; a flat zero day is honest and renders.
    // probeCount 0 is what lets a renderer tell "no data" apart from "fully down", which
    // is also all-zero-but-one ratio.
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    const { history } = await appHealth(db, appId, NOW);
    expect(history).toHaveLength(30);
    expect(
      history.every(
        (d) => d.upRatio === 0 && d.degradedRatio === 0 && d.downRatio === 0 && d.probeCount === 0,
      ),
    ).toBe(true);
    expect(history[0]?.dayStart).toBe(NOW - 29 * DAY);
    expect(history[29]?.dayStart).toBe(NOW);
  });

  it("does not let a probe polled 5x faster outvote a probe that was down all day", async () => {
    // docker at the 60s default, up all day: 1440 samples. http_internal set to 300s,
    // down all day: 288 samples. Pooling raw counts (the old behaviour) summed these to
    // up=1440, down=288 → 1440/1728 ≈ 0.83 healthy, for an app whose web interface was
    // unreachable the entire day. Averaging each probe's own ratio gives 0.5/0.5 instead,
    // because a probe that reported nothing but "down" all day is exactly half as healthy
    // as one that reported nothing but "up", regardless of how many times each fired.
    const { db, appId } = await fixture();
    await db.insert(probes).values([
      { id: "p1", appId, kind: "docker" },
      { id: "p2", appId, kind: "http_internal" },
    ]);
    await db.insert(checkRollups).values([
      { probeId: "p1", hourStart: NOW - DAY, upCount: 1440 },
      { probeId: "p2", hourStart: NOW - DAY, downCount: 288 },
    ]);
    const { history } = await appHealth(db, appId, NOW);
    const day = history.find((d) => d.dayStart === NOW - DAY);
    expect(day?.upRatio).toBeCloseTo(0.5);
    expect(day?.downRatio).toBeCloseTo(0.5);
    expect(day?.degradedRatio).toBe(0);
    expect(day?.probeCount).toBe(2);
  });

  it("does not count a silent probe as healthy when only one of two probes reported", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values([
      { id: "p1", appId, kind: "docker" },
      { id: "p2", appId, kind: "http_internal" },
    ]);
    // p2 has no rollup at all for this day.
    await db.insert(checkRollups).values([{ probeId: "p1", hourStart: NOW - DAY, upCount: 10 }]);
    const { history } = await appHealth(db, appId, NOW);
    const day = history.find((d) => d.dayStart === NOW - DAY);
    // p1's ratio stands alone, unaveraged against a silent p2.
    expect(day?.upRatio).toBe(1);
    expect(day?.downRatio).toBe(0);
    expect(day?.probeCount).toBe(1);
  });

  it("sums each day's ratios to 1 whenever at least one probe contributed", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values([
      { id: "p1", appId, kind: "docker" },
      { id: "p2", appId, kind: "http_internal" },
    ]);
    await db.insert(checkRollups).values([
      { probeId: "p1", hourStart: NOW - DAY, upCount: 3, degradedCount: 1, downCount: 2 },
      { probeId: "p2", hourStart: NOW - DAY, upCount: 100 },
    ]);
    const { history } = await appHealth(db, appId, NOW);
    for (const bucket of history) {
      if (bucket.probeCount > 0) {
        expect(bucket.upRatio + bucket.degradedRatio + bucket.downRatio).toBeCloseTo(1);
      }
    }
  });

  it("does not let an ancient rollup contribute to any bucket", async () => {
    // This is a sanity check on appHealth's output, not a binding test for the database
    // query's `gte` clause — see fetchRollupsInWindow's own test below for that. A row
    // this old is dropped by the pre-seeded bucket map regardless of whether the query
    // filtered it out first, so this test alone cannot tell the two apart.
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    await db.insert(checkRollups).values({ probeId: "p1", hourStart: NOW - 40 * DAY, upCount: 99 });
    const { history } = await appHealth(db, appId, NOW);
    expect(history.every((d) => d.probeCount === 0)).toBe(true);
  });

  it("ignores a future-dated rollup instead of throwing", async () => {
    // Passes the `gte` lower bound and finds no bucket, which is what makes
    // `if (!buckets.has(day)) continue` live defensive code rather than dead.
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    await db.insert(checkRollups).values({ probeId: "p1", hourStart: NOW + 10 * DAY, upCount: 99 });
    const { history } = await appHealth(db, appId, NOW);
    expect(history).toHaveLength(30);
    expect(history.every((d) => d.probeCount === 0)).toBe(true);
  });
});

describe("fetchRollupsInWindow", () => {
  it("scopes the query to rows at or after `oldest`, not just whatever the caller keeps", async () => {
    // Unlike an assertion on appHealth's output, this binds the `gte` clause itself: an
    // ancient row that the clause fails to exclude shows up directly in the row count,
    // with no bucket-map guard downstream to hide the difference.
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    const oldest = NOW - 29 * DAY;
    await db.insert(checkRollups).values([
      { probeId: "p1", hourStart: NOW - 40 * DAY, upCount: 99 }, // before the window
      { probeId: "p1", hourStart: oldest, upCount: 1 }, // exactly at the boundary
      { probeId: "p1", hourStart: NOW - DAY, upCount: 1 }, // inside the window
    ]);
    const rows = await fetchRollupsInWindow(db, ["p1"], oldest);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.hourStart).sort((a, b) => a - b)).toEqual([oldest, NOW - DAY]);
  });
});
