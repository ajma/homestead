import { randomUUID } from "node:crypto";
import type { MonitorType } from "@shared/monitoring.js";
import { and, eq, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checks, devices, monitors } from "../db/schema.js";
import { type CheckExecutor, executors as defaultExecutors } from "./checks.js";
import { rollUpAndPrune } from "./rollup.js";

export type RunnerDeps = {
  db: Db;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { cancel: () => void };
  executors?: Partial<Record<MonitorType, CheckExecutor>>;
  /** Defaults to `rollUpAndPrune`; injected so tests spy without touching rows. */
  maintain?: (
    db: Db,
    now: number,
  ) => Promise<{ rolled: number; pruned: number }>;
  /** Syncs Cloudflare Access allow policy to Homestead users every 5 minutes. */
  syncUsers?: (now: number) => Promise<void>;
};

const TICK_INTERVAL_MS = 10_000;
const ROLLUP_INTERVAL_MS = 3_600_000; // 1 hour
const SYNC_USERS_INTERVAL_MS = 300_000; // 5 minutes
const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes
const POOL_SIZE = 8;

export function createRunner(deps: RunnerDeps): {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
} {
  const {
    db,
    now,
    setTimer,
    executors = defaultExecutors,
    maintain = rollUpAndPrune,
    syncUsers,
  } = deps;
  let timer: { cancel: () => void } | null = null;
  let lastRollupAt = 0;
  let lastSyncUsersAt = 0;
  let tickInFlight = false;

  function computeNextDue(
    monitor: typeof monitors.$inferSelect,
    at: number,
    consecutiveFailures: number,
  ): { nextDueAt: number; consecutiveFailures: number } {
    const backoffMultiplier = 2 ** Math.min(consecutiveFailures, 5);
    const backoffMs = Math.min(
      monitor.intervalSeconds * 1000 * backoffMultiplier,
      MAX_BACKOFF_MS,
    );
    return {
      nextDueAt: at + backoffMs,
      consecutiveFailures,
    };
  }

  async function tick(): Promise<void> {
    // Re-entrancy guard
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;

    try {
      const currentTime = now();

      // Select due monitors
      const due = await db
        .select()
        .from(monitors)
        .where(
          and(eq(monitors.enabled, true), lte(monitors.nextDueAt, currentTime)),
        );

      // Fetch device connection map once per tick if any tailscale monitors are due
      let deviceConnectionMap: Map<string, boolean | null> | null = null;
      if (due.some((m) => m.type === "tailscale")) {
        deviceConnectionMap = new Map();
        const allDevices = await db.select().from(devices);
        for (const device of allDevices) {
          deviceConnectionMap.set(device.id, device.connectedToControl ?? null);
        }
      }

      // Execute monitors concurrently with bounded pool
      await executeWithPool(due, POOL_SIZE, async (monitor) => {
        try {
          await executeMonitor(monitor, currentTime, deviceConnectionMap);
        } catch (err) {
          // One monitor's failure must not affect others - record as failed check
          await recordFailedCheck(monitor, currentTime, err);
        }
      });

      // Run maintenance at most once per hour
      if (currentTime - lastRollupAt >= ROLLUP_INTERVAL_MS) {
        try {
          await maintain(db, currentTime);
          lastRollupAt = currentTime;
        } catch (err) {
          console.error("Maintenance failed:", err);
        }
      }

      // Sync Cloudflare Access users at most once per 5 minutes
      if (
        syncUsers &&
        currentTime - lastSyncUsersAt >= SYNC_USERS_INTERVAL_MS
      ) {
        try {
          await syncUsers(currentTime);
          lastSyncUsersAt = currentTime;
        } catch (err) {
          console.error("User sync failed:", err);
        }
      }
    } finally {
      tickInFlight = false;
    }
  }

  async function executeMonitor(
    monitor: typeof monitors.$inferSelect,
    currentTime: number,
    deviceConnectionMap: Map<string, boolean | null> | null,
  ): Promise<void> {
    const executor = executors[monitor.type as MonitorType];
    if (!executor) {
      await recordFailedCheck(
        monitor,
        currentTime,
        new Error(`No executor for type ${monitor.type}`),
      );
      return;
    }

    // Parse config
    let config: unknown;
    try {
      config = JSON.parse(monitor.config);
    } catch (_err) {
      await recordFailedCheck(
        monitor,
        currentTime,
        new Error("Invalid JSON config"),
      );
      return;
    }

    // Build CheckContext per monitor
    const ctx = {
      now,
      lastPushAt: () => monitor.lastPushAt ?? null,
      deviceConnected: (deviceId: string) =>
        deviceConnectionMap?.get(deviceId) ?? null,
    };

    // Execute with retries (N retries = N+1 total attempts)
    const maxAttempts = monitor.retries + 1;
    let lastResult = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      lastResult = await executor(config, monitor.timeoutMs, ctx);
      if (lastResult.up) {
        break; // Stop early on success
      }
    }

    if (!lastResult) {
      await recordFailedCheck(
        monitor,
        currentTime,
        new Error("No result from executor"),
      );
      return;
    }

    // Record the check
    await db.insert(checks).values({
      id: randomUUID(),
      monitorId: monitor.id,
      at: currentTime,
      up: lastResult.up,
      durationMs: lastResult.durationMs,
      error: lastResult.error,
    });

    // Update monitor state
    const newConsecutiveFailures = lastResult.up
      ? 0
      : monitor.consecutiveFailures + 1;
    const { nextDueAt, consecutiveFailures } = computeNextDue(
      monitor,
      currentTime,
      newConsecutiveFailures,
    );

    await db
      .update(monitors)
      .set({
        consecutiveFailures,
        nextDueAt,
      })
      .where(eq(monitors.id, monitor.id));
  }

  async function recordFailedCheck(
    monitor: typeof monitors.$inferSelect,
    at: number,
    err: unknown,
  ): Promise<void> {
    const error = err instanceof Error ? err.message : String(err);
    await db.insert(checks).values({
      id: randomUUID(),
      monitorId: monitor.id,
      at,
      up: false,
      durationMs: 0,
      error,
    });

    // Update consecutiveFailures and nextDueAt for thrown errors too
    const newConsecutiveFailures = monitor.consecutiveFailures + 1;
    const { nextDueAt, consecutiveFailures } = computeNextDue(
      monitor,
      at,
      newConsecutiveFailures,
    );

    await db
      .update(monitors)
      .set({
        consecutiveFailures,
        nextDueAt,
      })
      .where(eq(monitors.id, monitor.id));
  }

  async function executeWithPool<T>(
    items: T[],
    poolSize: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    const queue = [...items];
    const workers: Promise<void>[] = [];

    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) {
          await fn(item);
        }
      }
    }

    for (let i = 0; i < Math.min(poolSize, items.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
  }

  function start(): void {
    // Must not run tick synchronously - only schedule it
    timer = setTimer(() => {
      tick().catch((err) => {
        console.error("Tick failed:", err);
      });
    }, TICK_INTERVAL_MS);
  }

  function stop(): void {
    if (timer) {
      timer.cancel();
      timer = null;
    }
  }

  return { start, stop, tick };
}
