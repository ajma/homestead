import { describe, expect, it, vi } from "vitest";
import { PreflightError } from "./host/preflight.js";
import { type RuntimeParts, type StartupDeps, startServer } from "./startup.js";

type FakeDb = { id: "fake-db" };

function deps(overrides: Partial<StartupDeps<FakeDb>> = {}): {
  deps: StartupDeps<FakeDb>;
  order: string[];
  signalHandlers: Map<NodeJS.Signals, () => void>;
  exit: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const exit = vi.fn();

  const runtimeParts: RuntimeParts = {
    closeable: {
      scheduler: { stop: () => void order.push("scheduler") },
      retention: { stop: () => void order.push("retention") },
      jobs: {
        shutdown: async () => {
          await Promise.resolve();
          order.push("jobs");
        },
      },
      events: { closeAll: () => void order.push("events") },
      server: {
        close: async () => {
          order.push("server");
        },
      },
    },
    startTimers: () => order.push("startTimers"),
    listen: async () => {
      order.push("listen");
    },
  };

  const base: StartupDeps<FakeDb> = {
    skipPreflight: false,
    runPreflight: async () => {
      order.push("preflight");
      return { ok: true };
    },
    createDb: async () => {
      order.push("createDb");
      return { db: { id: "fake-db" }, closeDb: () => order.push("closeDb") };
    },
    runMigrations: async () => {
      order.push("runMigrations");
    },
    sweepStrandedJobs: async () => {
      order.push("sweep");
      return 0;
    },
    now: () => 0,
    buildRuntime: async () => {
      order.push("buildRuntime");
      return runtimeParts;
    },
    listenOptions: { port: 0, host: "0.0.0.0" },
    signals: ["SIGTERM", "SIGINT"],
    onSignal: (signal, handler) => signalHandlers.set(signal, handler),
    onUncaughtException: () => order.push("onUncaughtException"),
    onUnhandledRejection: () => order.push("onUnhandledRejection"),
    exit,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };

  return { deps: base, order, signalHandlers, exit };
}

describe("startServer", () => {
  it("rejects before opening the database when the preflight fails, and never opens one", async () => {
    const { deps: d, order } = deps({
      runPreflight: async () => {
        order.push("preflight");
        return { ok: false, reason: "mismatched mount" };
      },
    });

    await expect(startServer(d)).rejects.toThrow(PreflightError);
    expect(order).toEqual(["preflight"]);
  });

  it("skips the preflight entirely when told to, and still boots", async () => {
    const { deps: d, order } = deps({ skipPreflight: true });

    await startServer(d);

    expect(order).not.toContain("preflight");
    expect(order[0]).toBe("createDb");
  });

  it("runs migrations and the startup sweep before assembling the runtime, and the runtime before listen", async () => {
    const { deps: d, order } = deps();

    await startServer(d);

    expect(order).toEqual([
      "preflight",
      "createDb",
      "runMigrations",
      "sweep",
      "buildRuntime",
      "startTimers",
      "listen",
      "onUnhandledRejection",
      "onUncaughtException",
    ]);
  });

  it("installs a signal handler for every configured signal before the preflight even runs", async () => {
    let resolvePreflight: ((result: { ok: true }) => void) | undefined;
    const preflightPromise = new Promise<{ ok: true }>((resolve) => {
      resolvePreflight = resolve;
    });
    const { deps: d, signalHandlers } = deps({
      runPreflight: () => preflightPromise,
    });

    const pending = startServer(d);

    // The `for` loop that installs signal handlers runs synchronously, before the first
    // `await` — so both handlers exist even though `runPreflight` has not resolved yet.
    expect(signalHandlers.has("SIGTERM")).toBe(true);
    expect(signalHandlers.has("SIGINT")).toBe(true);

    resolvePreflight?.({ ok: true });
    await pending;
  });

  it("exits immediately on a signal received during startup, without attempting shutdown", async () => {
    let resolvePreflight: ((result: { ok: true }) => void) | undefined;
    const preflightPromise = new Promise<{ ok: true }>((resolve) => {
      resolvePreflight = resolve;
    });
    const {
      deps: d,
      signalHandlers,
      exit,
      order,
    } = deps({
      runPreflight: () => preflightPromise,
    });

    const pending = startServer(d);
    signalHandlers.get("SIGTERM")?.();

    expect(exit).toHaveBeenCalledWith(143);
    expect(order).not.toContain("server");
    expect(order).not.toContain("db");

    resolvePreflight?.({ ok: true });
    await pending;
  });

  it("runs the real graceful shutdown when a signal arrives after boot has completed", async () => {
    const { deps: d, signalHandlers, exit, order } = deps();

    await startServer(d);
    const handler = signalHandlers.get("SIGTERM");
    expect(handler).toBeDefined();

    handler?.();
    // `shutdown()` is async; wait for it to actually finish rather than guessing a
    // number of microtask hops.
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(order).toContain("jobs");
    expect(order).toContain("server");
    expect(order).toContain("closeDb");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not install uncaughtException/unhandledRejection handlers, and propagates the failure, when listen fails", async () => {
    const { deps: d, order } = deps({
      buildRuntime: async () => {
        order.push("buildRuntime");
        return {
          closeable: {
            scheduler: { stop: () => {} },
            retention: { stop: () => {} },
            jobs: { shutdown: async () => {} },
            events: { closeAll: () => {} },
            server: { close: async () => {} },
          },
          startTimers: () => {},
          listen: async () => {
            throw new Error("listen EADDRINUSE: address already in use 0.0.0.0:3000");
          },
        };
      },
    });

    await expect(startServer(d)).rejects.toThrow(/EADDRINUSE/);
    expect(order).not.toContain("onUncaughtException");
    expect(order).not.toContain("onUnhandledRejection");
  });
});
