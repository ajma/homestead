import { ComposeConfigCache } from "@server/apps/compose-config";
import { createDb, runMigrations } from "@server/db/client";
import { apps, checkResults, hosts, probes } from "@server/db/schema";
import { Scheduler } from "@server/monitoring/scheduler";
import type { ProbeResult, ProbeRunner } from "@server/monitoring/types";
import { FakeHost } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const NOW = 1_800_000_000;

function stubRunner(kind: ProbeRunner["kind"], result: ProbeResult, log: string[]): ProbeRunner {
  return {
    kind,
    async run(probe) {
      log.push(probe.id);
      return result;
    },
  };
}

async function seed(probeCount: number, over: Record<string, unknown> = {}) {
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
  const ids: string[] = [];
  for (let i = 0; i < probeCount; i++) {
    const id = ulid();
    ids.push(id);
    await db.insert(probes).values({ id, appId, kind: "docker", nextRunAt: 0, ...over });
  }
  const host = new FakeHost();
  host.files.set("jellyfin/compose.yaml", "services: {}\n");
  return { db, host, appId, ids };
}

function build(db: Awaited<ReturnType<typeof seed>>["db"], host: FakeHost, log: string[]) {
  return new Scheduler({
    db,
    host,
    composeConfig: new ComposeConfigCache(host),
    runners: {
      docker: stubRunner("docker", { status: "up" }, log),
      http_internal: stubRunner("http_internal", { status: "up" }, log),
      http_external: stubRunner("http_external", { status: "up" }, log),
    },
    now: () => NOW,
    random: () => 0.5, // no jitter offset
  });
}

describe("Scheduler.tick", () => {
  it("runs due probes and reschedules them with the interval", async () => {
    const { db, host, ids } = await seed(1, { intervalSeconds: 60 });
    const log: string[] = [];
    expect(await build(db, host, log).tick()).toBe(1);
    expect(log).toEqual(ids);
    const [probe] = await db
      .select()
      .from(probes)
      .where(eq(probes.id, ids[0] ?? ""));
    expect(probe?.nextRunAt).toBe(NOW + 60);
    expect(await db.select().from(checkResults)).toHaveLength(1);
  });

  it("skips probes that are not due yet", async () => {
    const { db, host } = await seed(1, { nextRunAt: NOW + 30 });
    const log: string[] = [];
    expect(await build(db, host, log).tick()).toBe(0);
    expect(log).toEqual([]);
  });

  it("skips disabled probes", async () => {
    const { db, host } = await seed(1, { enabled: false });
    const log: string[] = [];
    expect(await build(db, host, log).tick()).toBe(0);
  });

  it("applies jitter within ±10% of the interval", async () => {
    const { db, host, ids } = await seed(1, { intervalSeconds: 100 });
    const log: string[] = [];
    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: {
        docker: stubRunner("docker", { status: "up" }, log),
        http_internal: stubRunner("http_internal", { status: "up" }, log),
        http_external: stubRunner("http_external", { status: "up" }, log),
      },
      now: () => NOW,
      random: () => 1, // maximum positive jitter
    });
    await scheduler.tick();
    const [probe] = await db
      .select()
      .from(probes)
      .where(eq(probes.id, ids[0] ?? ""));
    expect(probe?.nextRunAt).toBe(NOW + 110);
  });

  it("takes ONE container snapshot for the whole tick", async () => {
    // Sixty apps must not mean sixty Engine API calls every minute.
    const { db, host } = await seed(5);
    const log: string[] = [];
    host.listContainersCalls = 0;
    await build(db, host, log).tick();
    expect(log).toHaveLength(5);
    expect(host.listContainersCalls).toBe(1);
  });

  it("never runs more than the concurrency limit at once", async () => {
    const { db, host } = await seed(20);
    let inFlight = 0;
    let peak = 0;
    const slow: ProbeRunner = {
      kind: "docker",
      async run() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { status: "up" };
      },
    };
    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: { docker: slow, http_internal: slow, http_external: slow },
      now: () => NOW,
      random: () => 0.5,
    });
    await scheduler.tick();
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("writes one sample per probe when many run at once", async () => {
    // The assertion the concurrency test does not make, and the one that matters.
    // libSQL has a single connection, so overlapping `db.transaction()` calls fail with
    // TRANSACTION_ACTIVE. Measured before persistence was serialised: three probes ran,
    // the runner was called three times, and exactly ONE sample was written — the rest
    // rejected into the per-probe catch while the tick reported success.
    const { db, host } = await seed(12);
    const failures: string[] = [];
    const runner: ProbeRunner = {
      kind: "docker",
      async run() {
        return { status: "up" };
      },
    };
    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: { docker: runner, http_internal: runner, http_external: runner },
      onProbeError: (probeId) => failures.push(probeId),
      now: () => NOW,
      random: () => 0.5,
    });

    expect(await scheduler.tick()).toBe(12);
    expect(failures).toEqual([]);
    expect(await db.select().from(checkResults)).toHaveLength(12);
    const rows = await db.select().from(probes);
    expect(rows.every((probe) => probe.lastStatus === "up")).toBe(true);
  });

  it("reports a probe failure rather than swallowing it", async () => {
    const { db, host, ids } = await seed(1);
    const failures: Array<[string, string]> = [];
    const runner: ProbeRunner = {
      kind: "docker",
      async run() {
        throw new Error("runner exploded");
      },
    };
    await new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: { docker: runner, http_internal: runner, http_external: runner },
      onProbeError: (probeId, error) =>
        failures.push([probeId, error instanceof Error ? error.message : String(error)]),
      now: () => NOW,
      random: () => 0.5,
    }).tick();
    expect(failures).toEqual([[ids[0], "runner exploded"]]);
  });

  it("survives an onProbeError callback that throws", async () => {
    // Third time in this project that a reporting channel took down the thing it
    // reports on. Measured before the guard: six due probes with a throwing hook left
    // `tick()` resolving at 0 after one runner call, with the other five still running
    // and rescheduling after `ticking` had reset — re-opening the concurrent-tick race.
    const { db, host, ids } = await seed(6);
    const runner: ProbeRunner = {
      kind: "docker",
      async run() {
        throw new Error("runner exploded");
      },
    };
    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: { docker: runner, http_internal: runner, http_external: runner },
      onProbeError: () => {
        throw new Error("logger is misconfigured");
      },
      now: () => NOW,
      random: () => 0.5,
    });

    expect(await scheduler.tick()).toBe(6);
    // Every probe was reached and rescheduled before `tick()` returned — nothing is
    // still running in the background.
    const rows = await db.select().from(probes);
    expect(rows).toHaveLength(6);
    expect(rows.every((probe) => probe.nextRunAt > NOW)).toBe(true);
    expect(ids).toHaveLength(6);
  });

  it("reschedules a probe whose runner throws, and keeps going", async () => {
    // One broken probe must not stop the tick or wedge itself into running every 5s
    // forever.
    const { db, host, ids } = await seed(2);
    const exploding: ProbeRunner = {
      kind: "docker",
      async run(probe) {
        if (probe.id === ids[0]) throw new Error("runner exploded");
        return { status: "up" };
      },
    };
    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: { docker: exploding, http_internal: exploding, http_external: exploding },
      now: () => NOW,
      random: () => 0.5,
    });
    await expect(scheduler.tick()).resolves.toBe(2);
    const [broken] = await db
      .select()
      .from(probes)
      .where(eq(probes.id, ids[0] ?? ""));
    expect(broken?.nextRunAt).toBeGreaterThan(NOW);
    expect(broken?.lastStatus).toBe("unknown");
  });

  it("passes null for the snapshot when Docker is unreachable", async () => {
    const { db, host } = await seed(1);
    host.listContainers = async () => {
      throw new Error("connect ENOENT");
    };
    let seen: unknown = "not called";
    const capturing: ProbeRunner = {
      kind: "docker",
      async run(_probe, ctx) {
        seen = ctx.containers;
        return { status: "down", faultClass: "network" };
      },
    };
    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: { docker: capturing, http_internal: capturing, http_external: capturing },
      now: () => NOW,
      random: () => 0.5,
    });
    await scheduler.tick();
    expect(seen).toBeNull();
  });

  it("stop() clears its timer", async () => {
    const { db, host } = await seed(0);
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const scheduler = build(db, host, []);
    scheduler.start();
    expect(timers()).toBeGreaterThan(before);
    scheduler.stop();
    expect(timers()).toBe(before);
  });
});
