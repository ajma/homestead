import { describe, expect, it, vi } from "vitest";
import { type Closeable, createShutdown } from "./shutdown.js";

// Resolves `name` onto `order` after `ticks` microtask hops rather than on invocation.
// `scheduler.stop`/`retention.stop`/`events.closeAll` are synchronous in the real
// `Closeable` type, but `shutdown.ts` awaits every stage through its `stage`/
// `stageWithTimeout` helper regardless of whether the real implementation is sync or
// async: `await run()` awaits whatever `run()` actually returns at runtime, even though
// the static type says `void`. Returning a promise here is exactly what TS's
// void-returning-function compatibility rule permits.
//
// A single microtask hop is not enough: if stage K's fake and stage K+1's fake both push
// after exactly one hop, a dropped `await` on stage K still leaves the two pushes in
// invocation order, because both hops land in the same microtask "round" and FIFO
// ordering alone preserves the correct sequence — invisible to every assertion below.
// Giving each stage strictly FEWER hops than the one before it means that when a dropped
// `await` lets stage K+1 start in that same round as stage K, K+1's shorter chain
// resolves — and pushes — before K's longer one does, which is exactly the visible
// reordering a missing `await` should produce. When every stage IS properly awaited, the
// tick counts don't matter: stage K+1 never even starts until stage K's promise has
// already resolved, so the order is scheduler, retention, jobs, events, server regardless.
function afterTicks(order: string[], name: string, ticks: number): Promise<void> {
  let settled: Promise<void> = Promise.resolve();
  for (let i = 0; i < ticks; i++) {
    settled = settled.then(() => {});
  }
  return settled.then(() => {
    order.push(name);
  });
}

function parts(overrides: Partial<Closeable> = {}): { parts: Closeable; order: string[] } {
  const order: string[] = [];
  const base: Closeable = {
    scheduler: { stop: () => afterTicks(order, "scheduler", 6) },
    retention: { stop: () => afterTicks(order, "retention", 5) },
    jobs: {
      // `jobs` is the one stage whose whole point is that a cancelled job's terminal
      // write is awaited before the sequence moves on (job-runner.ts:68-79) — this is
      // the original gap the 1H review measured (shutdown.ts:102), now folded into the
      // same decreasing-ticks scheme as every other stage.
      shutdown: () => afterTicks(order, "jobs", 4),
    },
    stepJobs: {
      // Same reasoning as `jobs` above, for `StepJobRunner`: this is the Phase 2B
      // whole-branch review's Important 1 — `stepJobs` was absent from `Closeable`
      // entirely, so nothing ever awaited an in-flight step sequence and `db.close()`
      // ran out from under it. Folded into the same decreasing-ticks scheme.
      shutdown: () => afterTicks(order, "stepJobs", 3),
    },
    events: { closeAll: () => afterTicks(order, "events", 2) },
    server: {
      close: () => afterTicks(order, "server", 1),
    },
    db: { close: () => void order.push("db") },
    ...overrides,
  };
  return { parts: base, order };
}

describe("createShutdown", () => {
  it("stops the timers before it closes the server", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.indexOf("scheduler")).toBeLessThan(order.indexOf("server"));
    expect(order.indexOf("retention")).toBeLessThan(order.indexOf("server"));
  });

  it("ends the SSE streams before closing the server, which cannot close while one is open", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.indexOf("events")).toBeLessThan(order.indexOf("server"));
  });

  it("cancels jobs after the timers stop and before the streams close", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.indexOf("scheduler")).toBeLessThan(order.indexOf("jobs"));
    expect(order.indexOf("jobs")).toBeLessThan(order.indexOf("events"));
  });

  it("waits for an in-flight step sequence after jobs and before the streams close", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.indexOf("jobs")).toBeLessThan(order.indexOf("stepJobs"));
    expect(order.indexOf("stepJobs")).toBeLessThan(order.indexOf("events"));
  });

  it("closes the database last", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.at(-1)).toBe("db");
  });

  it("runs every stage, in the documented order, and waits for each to finish before starting the next", async () => {
    // The pairwise `indexOf` comparisons above are satisfied by `-1` for a stage that
    // never ran at all, which is exactly how deleting `retention.stop()` (shutdown.ts:101)
    // stayed invisible, and they only ever measure when a stage was INVOKED, which is how
    // dropping the `await` on `jobs.shutdown()` (shutdown.ts:102) also stayed invisible.
    // This asserts presence and completion order for every stage in one go.
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order).toEqual(["scheduler", "retention", "jobs", "stepJobs", "events", "server", "db"]);
  });

  it("runs once however many times it is called", async () => {
    const { parts: p, order } = parts();
    const shutdown = createShutdown(p);

    await Promise.all([shutdown(), shutdown(), shutdown()]);

    expect(order.filter((s) => s === "server")).toHaveLength(1);
    expect(order.filter((s) => s === "db")).toHaveLength(1);
  });

  it("still closes the database when the server refuses to close", async () => {
    const onError = vi.fn();
    const { parts: p, order } = parts({
      server: {
        close: async () => {
          throw new Error("still serving");
        },
      },
    });

    await createShutdown(p, { onError })();

    expect(order).toContain("db");
    expect(onError).toHaveBeenCalledWith("server", expect.any(Error));
  });

  it("still closes the database when a timer throws on the way down", async () => {
    const onError = vi.fn();
    const { parts: p, order } = parts({
      scheduler: {
        stop: () => {
          throw new Error("bad timer");
        },
      },
    });

    await createShutdown(p, { onError })();

    expect(order).toContain("db");
    expect(order).toContain("server");
    expect(onError).toHaveBeenCalledWith("scheduler", expect.any(Error));
  });

  it("gives up on a server that never closes, rather than hanging forever", async () => {
    const { parts: p, order } = parts({
      server: { close: () => new Promise<void>(() => {}) },
    });

    await createShutdown(p, { timeoutMs: 100 })();

    expect(order).toContain("db");
  });
});
