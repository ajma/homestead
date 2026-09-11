import { createDb, runMigrations } from "@server/db/client";
import { apps, checkRollups, hosts, probes } from "@server/db/schema";
import { appHealth } from "@server/launcher/health";
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

  it("aggregates hourly rollups into 30 daily buckets", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    // Two hours on the same day must land in one bucket.
    await db.insert(checkRollups).values([
      { probeId: "p1", hourStart: NOW - DAY, upCount: 50, downCount: 10 },
      { probeId: "p1", hourStart: NOW - DAY + HOUR, upCount: 30, downCount: 0 },
    ]);
    const { history } = await appHealth(db, appId, NOW);
    expect(history).toHaveLength(30);
    const yesterday = history.find((d) => d.dayStart === NOW - DAY);
    expect(yesterday).toEqual({ dayStart: NOW - DAY, up: 80, degraded: 0, down: 10 });
  });

  it("returns a zeroed bucket for a day with no data rather than a gap", async () => {
    // A sparkline with holes in it is unreadable; a flat zero day is honest and renders.
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    const { history } = await appHealth(db, appId, NOW);
    expect(history).toHaveLength(30);
    expect(history.every((d) => d.up === 0 && d.degraded === 0 && d.down === 0)).toBe(true);
    expect(history[0]?.dayStart).toBe(NOW - 29 * DAY);
    expect(history[29]?.dayStart).toBe(NOW);
  });

  it("ignores rollups older than 30 days", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    await db.insert(checkRollups).values({ probeId: "p1", hourStart: NOW - 40 * DAY, upCount: 99 });
    const { history } = await appHealth(db, appId, NOW);
    expect(history.reduce((sum, d) => sum + d.up, 0)).toBe(0);
  });

  it("sums every probe on the app into one timeline", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values([
      { id: "p1", appId, kind: "docker" },
      { id: "p2", appId, kind: "http_internal" },
    ]);
    await db.insert(checkRollups).values([
      { probeId: "p1", hourStart: NOW - DAY, upCount: 5 },
      { probeId: "p2", hourStart: NOW - DAY, upCount: 7 },
    ]);
    const { history } = await appHealth(db, appId, NOW);
    expect(history.find((d) => d.dayStart === NOW - DAY)?.up).toBe(12);
  });
});
