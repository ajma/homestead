import { describe, expect, it, vi } from "vitest";
import { type Closeable, createShutdown } from "./shutdown.js";

function parts(overrides: Partial<Closeable> = {}): { parts: Closeable; order: string[] } {
  const order: string[] = [];
  const base: Closeable = {
    scheduler: { stop: () => void order.push("scheduler") },
    retention: { stop: () => void order.push("retention") },
    jobs: {
      shutdown: async () => {
        order.push("jobs");
      },
    },
    events: { closeAll: () => void order.push("events") },
    server: {
      close: async () => {
        order.push("server");
      },
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

  it("closes the database last", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.at(-1)).toBe("db");
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
