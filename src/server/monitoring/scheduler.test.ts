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
    // Exactly 8, not merely bounded: `toBeLessThanOrEqual(8)` passes against an
    // implementation that calls no runner at all (peak 0) or one that runs fully
    // sequentially (peak 1). The true peak with 20 probes and a limit of 8 is 8.
    expect(peak).toBe(8);
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

  it("reports a failed reschedule through onProbeError and lets every worker finish before tick() resolves", async () => {
    // C2 regression. `reschedule` used to sit outside `runOne`'s try, so a rejection from
    // it (SQLITE_BUSY, raised for real by a route holding a transaction open — no fault
    // injection needed in production) escaped the per-probe catch, rejected
    // `Promise.all` in `runAll` without waiting for the other workers, and `tick()`'s own
    // catch swallowed it and returned 0 with zero reports. Six probes, the second
    // `db.update` (i.e. the second probe's reschedule) throws.
    const { db, host, ids } = await seed(6);
    const failures: string[] = [];
    const runCalls: string[] = [];
    const slow: ProbeRunner = {
      kind: "docker",
      async run(probe) {
        runCalls.push(probe.id);
        // Slow enough that if a worker were abandoned rather than awaited, the tick
        // would return well before this resolves.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "up" };
      },
    };
    const originalUpdate = db.update.bind(db);
    let updateCalls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
    (db as any).update = (...args: unknown[]) => {
      updateCalls++;
      if (updateCalls === 2) throw new Error("SQLITE_BUSY");
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real implementation
      return (originalUpdate as any)(...args);
    };

    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: { docker: slow, http_internal: slow, http_external: slow },
      onProbeError: (probeId) => failures.push(probeId),
      now: () => NOW,
      random: () => 0.5,
    });

    let result: number;
    try {
      result = await scheduler.tick();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (db as any).update = originalUpdate;
    }
    const invocationsAtReturn = runCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const invocationsAfterDelay = runCalls.length;

    expect(result).toBe(6);
    expect(failures).toEqual([ids[1]]);
    // The property whose absence let this ship: nothing keeps running after tick()
    // resolves.
    expect(invocationsAfterDelay).toBe(invocationsAtReturn);
    // And it is not vacuous — the other five probes' runners really did get called.
    expect(invocationsAtReturn).toBe(5);
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

  it("refuses an overlapping tick while one is still in flight", async () => {
    // The `ticking` guard had no test at all: deleting it left the whole suite green.
    // `tick()` sets the flag synchronously, before its first `await`, so calling it twice
    // back to back — with no `await` between the calls — deterministically exercises the
    // guard rather than racing it: the second call's synchronous guard check is
    // guaranteed to run before the first call's own first microtask.
    const { db, host } = await seed(1);
    // A box, not a bare `let`: TypeScript's narrowing does not see the reassignment
    // inside the closure below and would otherwise narrow `release` to `null` forever.
    const gate: { release: (() => void) | null } = { release: null };
    const gated: ProbeRunner = {
      kind: "docker",
      async run() {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return { status: "up" };
      },
    };
    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: { docker: gated, http_internal: gated, http_external: gated },
      now: () => NOW,
      random: () => 0.5,
    });

    const first = scheduler.tick();
    expect(await scheduler.tick()).toBe(0);

    // Let the in-flight tick actually finish, so it does not leak into the next test.
    while (gate.release === null) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    gate.release();
    expect(await first).toBe(1);
  });

  it("does not let a hung listContainers call wedge the scheduler forever", async () => {
    // I5: `listContainers()` had no timeout. A wedged Docker socket never resolved this
    // call, `ticking` never reset, and every subsequent tick returned 0 forever with no
    // report — the exact failure class this monitoring exists to catch, happening to
    // monitoring itself.
    const { db, host } = await seed(1);
    host.listContainers = () => new Promise(() => {}); // never resolves
    const failures: string[] = [];
    const log: string[] = [];
    const scheduler = new Scheduler({
      db,
      host,
      composeConfig: new ComposeConfigCache(host),
      runners: {
        docker: stubRunner("docker", { status: "down", faultClass: "network" }, log),
        http_internal: stubRunner("http_internal", { status: "up" }, log),
        http_external: stubRunner("http_external", { status: "up" }, log),
      },
      onProbeError: (id) => failures.push(id),
      now: () => NOW,
      random: () => 0.5,
      listContainersTimeoutMs: 20,
    });

    expect(await scheduler.tick()).toBe(1);
    expect(failures).toEqual(["<containers>"]);
    expect(log).toHaveLength(1);
    // The guard was released: a later tick is not permanently wedged behind this one.
    const [probe] = await db.select().from(probes);
    expect(probe?.nextRunAt).toBeGreaterThan(NOW);
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
