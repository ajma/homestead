import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { checks, devices, monitors } from "../db/schema.js";
import { createRunner } from "./runner.js";

async function seed(
  nextDueAt: number,
  over: Record<string, unknown> = {},
): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db);
  await db.insert(devices).values({ id: "d", name: "nas", kind: "nas" });
  await db.insert(monitors).values({
    id: "m",
    targetType: "device",
    targetId: "d",
    type: "tcp",
    config: JSON.stringify({ host: "h", port: 1 }),
    intervalSeconds: 60,
    timeoutMs: 1000,
    retries: 0,
    required: true,
    enabled: true,
    nextDueAt,
    ...over,
  });
  return db;
}

const noTimer = () => ({ cancel: () => {} });

describe("runner tick", () => {
  it("checks a monitor that is due", async () => {
    const db = await seed(0);
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    expect(tcp).toHaveBeenCalledTimes(1);
    expect(await db.select().from(checks)).toHaveLength(1);
  });

  it("does NOT check a monitor that is not yet due", async () => {
    const db = await seed(9_999_999);
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    expect(tcp).not.toHaveBeenCalled();
    expect(await db.select().from(checks)).toHaveLength(0);
  });

  it("skips a disabled monitor even when due", async () => {
    const db = await seed(0, { enabled: false });
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    expect(tcp).not.toHaveBeenCalled();
  });

  it("advances nextDueAt by the interval", async () => {
    const db = await seed(0);
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    const [m] = await db.select().from(monitors).where(eq(monitors.id, "m"));
    expect(m?.nextDueAt).toBe(1000 + 60_000);
  });

  it("backs off by 2x after 1 consecutive failure", async () => {
    const db = await seed(0, { consecutiveFailures: 0 });
    const tcp = vi.fn(async () => ({
      up: false,
      durationMs: 5,
      error: "down",
    }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    const [m] = await db.select().from(monitors).where(eq(monitors.id, "m"));
    expect(m?.consecutiveFailures).toBe(1);
    expect(m?.nextDueAt).toBe(1000 + 60_000 * 2);
  });

  it("backs off by 8x after 3 consecutive failures", async () => {
    const db = await seed(0, { consecutiveFailures: 2 });
    const tcp = vi.fn(async () => ({
      up: false,
      durationMs: 5,
      error: "down",
    }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    const [m] = await db.select().from(monitors).where(eq(monitors.id, "m"));
    expect(m?.consecutiveFailures).toBe(3);
    expect(m?.nextDueAt).toBe(1000 + 60_000 * 8);
  });

  it("saturates backoff at exactly 30 minutes", async () => {
    const db = await seed(0, { consecutiveFailures: 49, intervalSeconds: 60 });
    const tcp = vi.fn(async () => ({
      up: false,
      durationMs: 5,
      error: "down",
    }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    const [m] = await db.select().from(monitors).where(eq(monitors.id, "m"));
    expect(m?.nextDueAt).toBe(1000 + 30 * 60 * 1000);
  });

  it("backs off when executor throws", async () => {
    const db = await seed(0, { consecutiveFailures: 1 });
    const tcp = vi.fn(async () => {
      throw new Error("network timeout");
    });
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    const [m] = await db.select().from(monitors).where(eq(monitors.id, "m"));
    expect(m?.consecutiveFailures).toBe(2);
    expect(m?.nextDueAt).toBe(1000 + 60_000 * 4); // 2^2 = 4
  });

  it("retries before recording a down, and records one row not three", async () => {
    const db = await seed(0, { retries: 2 });
    const tcp = vi.fn(async () => ({
      up: false,
      durationMs: 5,
      error: "refused",
    }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    }).tick();
    expect(tcp).toHaveBeenCalledTimes(3);
    const rows = await db.select().from(checks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.up).toBe(false);
  });

  it("does not let one failing executor stop the others in the same tick", async () => {
    const db = await seed(0);
    await db.insert(monitors).values({
      id: "m2",
      targetType: "device",
      targetId: "d",
      type: "dns",
      config: JSON.stringify({ hostname: "x" }),
      intervalSeconds: 60,
      timeoutMs: 1000,
      retries: 0,
      required: true,
      enabled: true,
      nextDueAt: 0,
    });
    const tcp = vi.fn(async () => {
      throw new Error("boom");
    });
    const dns = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp, dns },
    }).tick();
    expect(dns).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(checks);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.monitorId === "m")?.up).toBe(false);
  });

  it("runs maintenance at most once an hour", async () => {
    const db = await seed(9_999_999);
    const maintain = vi.fn(async () => ({ rolled: 0, pruned: 0 }));
    const r = createRunner({
      db,
      now: () => 3_600_001,
      setTimer: noTimer,
      maintain,
    });
    await r.tick();
    await r.tick();
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("completes tick and checks monitors even when maintenance throws", async () => {
    const db = await seed(0);
    const maintain = vi.fn(async () => {
      throw new Error("maintenance failed");
    });
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({
      db,
      now: () => 3_600_001,
      setTimer: noTimer,
      maintain,
      executors: { tcp },
    }).tick();
    expect(tcp).toHaveBeenCalledTimes(1);
    expect(await db.select().from(checks)).toHaveLength(1);
  });

  it("tailscale monitor reports down when device is present but disconnected", async () => {
    const db = createDb(":memory:");
    await runMigrations(db);
    await db.insert(devices).values({
      id: "dev1",
      name: "nas",
      kind: "nas",
      connectedToControl: false,
    });
    await db.insert(monitors).values({
      id: "m1",
      targetType: "device",
      targetId: "dev1",
      type: "tailscale",
      config: JSON.stringify({ deviceId: "dev1" }),
      intervalSeconds: 60,
      timeoutMs: 1000,
      retries: 0,
      required: true,
      enabled: true,
      nextDueAt: 0,
    });
    await createRunner({ db, now: () => 1000, setTimer: noTimer }).tick();
    const [check] = await db.select().from(checks);
    expect(check?.up).toBe(false);
    expect(check?.error).toBe("Device is disconnected from control plane");
  });

  it("tailscale monitor reports down when device is absent from table", async () => {
    const db = createDb(":memory:");
    await runMigrations(db);
    await db.insert(devices).values({
      id: "other",
      name: "other",
      kind: "nas",
    });
    await db.insert(monitors).values({
      id: "m1",
      targetType: "device",
      targetId: "missing",
      type: "tailscale",
      config: JSON.stringify({ deviceId: "missing" }),
      intervalSeconds: 60,
      timeoutMs: 1000,
      retries: 0,
      required: true,
      enabled: true,
      nextDueAt: 0,
    });
    await createRunner({ db, now: () => 1000, setTimer: noTimer }).tick();
    const [check] = await db.select().from(checks);
    expect(check?.up).toBe(false);
    expect(check?.error).toBe("Device has not synced yet");
  });
});

describe("runner lifecycle", () => {
  it("does nothing until started, and stops cleanly", () => {
    const cancel = vi.fn();
    const setTimer = vi.fn(() => ({ cancel }));
    const r = createRunner({ db: {} as Db, now: () => 0, setTimer });
    expect(setTimer).not.toHaveBeenCalled();
    r.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    r.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not re-enter when a tick is already in flight", async () => {
    const db = await seed(0);
    let resolveExecutor: (() => void) | undefined;
    const executorPromise = new Promise<void>((resolve) => {
      resolveExecutor = resolve;
    });
    const tcp = vi.fn(async () => {
      await executorPromise;
      return { up: true, durationMs: 5, error: null };
    });
    const r = createRunner({
      db,
      now: () => 1000,
      setTimer: noTimer,
      executors: { tcp },
    });
    const tick1 = r.tick();
    const tick2 = r.tick();
    resolveExecutor?.();
    await Promise.all([tick1, tick2]);
    expect(tcp).toHaveBeenCalledTimes(1);
  });
});
