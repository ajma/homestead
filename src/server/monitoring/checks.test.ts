import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock network modules before they're imported by checks.js
vi.mock("node:net");
vi.mock("node:dns/promises");

import { executors } from "./checks.js";

const ctx = (over: Partial<Parameters<typeof executors.push>[2]> = {}) => ({
  now: () => 10_000,
  lastPushAt: () => null,
  deviceConnected: () => null,
  ...over,
});

describe("push executor", () => {
  it("is down when no call has ever arrived", async () => {
    const r = await executors.push({ graceSeconds: 30 }, 1000, ctx());
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/never/i);
  });

  it("is up when a call arrived inside the window", async () => {
    const r = await executors.push(
      { graceSeconds: 30, intervalSeconds: 60 },
      1000,
      ctx({ lastPushAt: () => 10_000 - 20_000 }),
    );
    expect(r.up).toBe(true);
  });

  it("is down once interval + grace has elapsed", async () => {
    const r = await executors.push(
      { graceSeconds: 30, intervalSeconds: 60 },
      1000,
      ctx({ lastPushAt: () => 10_000 - 95_000 }),
    );
    expect(r.up).toBe(false);
  });

  it("is up when exactly at the deadline", async () => {
    // deadline = (60 + 30) * 1000 = 90_000 ms
    const r = await executors.push(
      { graceSeconds: 30, intervalSeconds: 60 },
      1000,
      ctx({ lastPushAt: () => 10_000 - 90_000 }),
    );
    expect(r.up).toBe(true);
  });

  it("is down when one millisecond past the deadline", async () => {
    // deadline = (60 + 30) * 1000 = 90_000 ms
    const r = await executors.push(
      { graceSeconds: 30, intervalSeconds: 60 },
      1000,
      ctx({ lastPushAt: () => 10_000 - 90_001 }),
    );
    expect(r.up).toBe(false);
  });

  it("uses only graceSeconds as deadline when intervalSeconds is absent", async () => {
    // deadline = 30 * 1000 = 30_000 ms (intervalSeconds defaults to 0)
    const upResult = await executors.push(
      { graceSeconds: 30 },
      1000,
      ctx({ lastPushAt: () => 10_000 - 29_000 }),
    );
    expect(upResult.up).toBe(true);

    const downResult = await executors.push(
      { graceSeconds: 30 },
      1000,
      ctx({ lastPushAt: () => 10_000 - 31_000 }),
    );
    expect(downResult.up).toBe(false);
  });

  it("uses monotonic clock for durationMs (not affected by Date.now jumping backwards)", async () => {
    // Stub Date.now to jump backwards during execution to verify performance.now is used
    let dateNowCallCount = 0;
    const originalDateNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => {
      dateNowCallCount += 1;
      // Jump backwards on second call
      return dateNowCallCount === 1 ? 1000000 : 500000;
    });

    const r = await executors.push(
      { graceSeconds: 30 },
      1000,
      ctx({ lastPushAt: () => 10_000 }),
    );

    // durationMs must be non-negative even though Date.now jumped backwards
    expect(r.durationMs).toBeGreaterThanOrEqual(0);

    Date.now = originalDateNow;
  });
});

describe("tailscale executor", () => {
  it("is up when the sync last saw the device connected", async () => {
    const r = await executors.tailscale(
      { deviceId: "d" },
      1000,
      ctx({ deviceConnected: () => true }),
    );
    expect(r.up).toBe(true);
  });

  it("is down when the sync last saw it disconnected", async () => {
    const r = await executors.tailscale(
      { deviceId: "d" },
      1000,
      ctx({ deviceConnected: () => false }),
    );
    expect(r.up).toBe(false);
  });

  it("is down with a clear error when the device has never synced", async () => {
    const r = await executors.tailscale(
      { deviceId: "d" },
      1000,
      ctx({ deviceConnected: () => null }),
    );
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/sync/i);
  });

  it("opens no connection — it reads state the sync already fetched", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await executors.tailscale(
      { deviceId: "d" },
      1000,
      ctx({ deviceConnected: () => true }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("config validation", () => {
  it("reports a bad config as a failed check, not a thrown error", async () => {
    // A malformed config must not kill the runner's tick. Every other monitor
    // in that pass would stop being checked.
    const r = await executors.tcp({ host: 123 }, 1000, ctx());
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/config/i);
  });
});

describe("tcp executor", () => {
  let mockSocket: Partial<Socket>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is up when the connection succeeds", async () => {
    mockSocket = {
      connect: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "connect") {
          setTimeout(() => handler(), 0);
        }
        return mockSocket as Socket;
      }),
      setTimeout: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    const net = await import("node:net");
    vi.mocked(net.Socket).mockImplementation(function (this: Socket) {
      return mockSocket as Socket;
    } as unknown as typeof net.Socket);

    const r = await executors.tcp({ host: "localhost", port: 22 }, 1000, ctx());
    expect(r.up).toBe(true);
    expect(r.error).toBe(null);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("is down when the connection fails", async () => {
    mockSocket = {
      connect: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "error") {
          setTimeout(() => handler(new Error("ECONNREFUSED")), 0);
        }
        return mockSocket as Socket;
      }),
      setTimeout: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    const net = await import("node:net");
    vi.mocked(net.Socket).mockImplementation(function (this: Socket) {
      return mockSocket as Socket;
    } as unknown as typeof net.Socket);

    const r = await executors.tcp(
      { host: "localhost", port: 9999 },
      1000,
      ctx(),
    );
    expect(r.up).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("is down when the connection times out", async () => {
    vi.useFakeTimers();

    let timeoutHandler: (() => void) | null = null;

    mockSocket = {
      connect: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "timeout") {
          timeoutHandler = handler;
        }
        return mockSocket as Socket;
      }),
      setTimeout: vi.fn((ms: number) => {
        // Real Node.js: setTimeout(0) disables the timeout (never fires)
        if (ms > 0) {
          setTimeout(() => {
            // Handler is registered after setTimeout is called, so check at fire time
            if (timeoutHandler) timeoutHandler();
          }, ms);
        }
        return mockSocket as Socket;
      }),
      removeAllListeners: vi.fn(),
    };

    const net = await import("node:net");
    vi.mocked(net.Socket).mockImplementation(function (this: Socket) {
      return mockSocket as Socket;
    } as unknown as typeof net.Socket);

    const promise = executors.tcp({ host: "1.2.3.4", port: 22 }, 500, ctx());
    await vi.advanceTimersByTimeAsync(500);
    const r = await promise;

    expect(r.up).toBe(false);
    expect(r.error).toMatch(/timeout/i);
    expect(mockSocket.setTimeout).toHaveBeenCalledWith(500);

    vi.useRealTimers();
  });
});

describe("http executor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is up when the request succeeds with a 2xx status", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
    }));
    vi.stubGlobal("fetch", mockFetch);

    const r = await executors.http({ url: "https://example.com" }, 1000, ctx());
    expect(r.up).toBe(true);
    expect(r.error).toBe(null);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("is down when the request fails with a non-2xx status", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
    }));
    vi.stubGlobal("fetch", mockFetch);

    const r = await executors.http(
      { url: "https://example.com/error" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/500/);
  });

  it("is down when the request fails due to network error", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("Network error");
    });
    vi.stubGlobal("fetch", mockFetch);

    const r = await executors.http(
      { url: "https://unreachable.test" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("is down when the request times out", async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn(
      async (_url: string, options?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("TimeoutError"));
          });
          // Never resolve to simulate slow server
        });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const promise = executors.http({ url: "https://slow.test" }, 500, ctx());
    await vi.advanceTimersByTimeAsync(500);
    const r = await promise;

    expect(r.up).toBe(false);
    expect(r.error).toMatch(/timeout/i);

    vi.useRealTimers();
  });

  it("uses monotonic clock for durationMs (not affected by Date.now jumping backwards)", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
    }));
    vi.stubGlobal("fetch", mockFetch);

    // Stub Date.now to jump backwards during execution
    let dateNowCallCount = 0;
    const originalDateNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => {
      dateNowCallCount += 1;
      return dateNowCallCount === 1 ? 1000000 : 500000;
    });

    const r = await executors.http({ url: "https://example.com" }, 1000, ctx());

    // durationMs must be non-negative even though Date.now jumped backwards
    expect(r.durationMs).toBeGreaterThanOrEqual(0);

    Date.now = originalDateNow;
  });
});

describe("dns executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is up when the DNS lookup succeeds", async () => {
    const { resolve: mockResolve } = await import("node:dns/promises");
    vi.mocked(mockResolve).mockResolvedValue(["1.2.3.4"]);

    const r = await executors.dns({ hostname: "example.com" }, 1000, ctx());
    expect(r.up).toBe(true);
    expect(r.error).toBe(null);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("is down when the DNS lookup fails (NXDOMAIN)", async () => {
    const { resolve: mockResolve } = await import("node:dns/promises");
    const err = new Error("NXDOMAIN") as NodeJS.ErrnoException;
    err.code = "ENOTFOUND";
    vi.mocked(mockResolve).mockRejectedValue(err);

    const r = await executors.dns(
      { hostname: "nonexistent.invalid" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("is down when the DNS lookup times out", async () => {
    vi.useFakeTimers();

    const { resolve: mockResolve } = await import("node:dns/promises");
    vi.mocked(mockResolve).mockImplementation(
      () =>
        new Promise((resolve) => {
          // Never resolve to simulate timeout
          setTimeout(resolve, 10_000);
        }),
    );

    const promise = executors.dns({ hostname: "slow.dns.test" }, 500, ctx());
    await vi.advanceTimersByTimeAsync(500);
    const r = await promise;

    expect(r.up).toBe(false);
    expect(r.error).toMatch(/timeout/i);

    vi.useRealTimers();
  });
});

describe("reachability executor", () => {
  it("sends the Access service-token headers", async () => {
    const f = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await executors.reachability(
      {
        url: "https://app.example.com",
        clientId: "cid",
        clientSecret: "csecret",
      },
      1000,
      ctx(),
    );
    expect(f).toHaveBeenCalledTimes(1);
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    const firstCall = calls[0];
    if (!firstCall) throw new Error("Expected fetch to be called");
    const init = firstCall[1];
    const h = init.headers as Record<string, string>;
    expect(h["CF-Access-Client-Id"]).toBe("cid");
    expect(h["CF-Access-Client-Secret"]).toBe("csecret");
    vi.unstubAllGlobals();
  });

  it("uses redirect: manual to prevent false-UP on Access redirects", async () => {
    const f = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "s" },
      1000,
      ctx(),
    );
    expect(f).toHaveBeenCalledTimes(1);
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    const firstCall = calls[0];
    if (!firstCall) throw new Error("Expected fetch to be called");
    const init = firstCall[1];
    expect(init.redirect).toBe("manual");
    vi.unstubAllGlobals();
  });

  it("is down when Access bounces the probe to a login page", async () => {
    // Without the service token this is what every probe would see, and calling
    // it up would report a crashed app behind a working tunnel as healthy.
    const f = vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://x.cloudflareaccess.com/login" },
        }),
    );
    vi.stubGlobal("fetch", f);
    const r = await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "s" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/access/i);
    vi.unstubAllGlobals();
  });

  it("rejects a lookalike domain (notcloudflareaccess.com) as a plain redirect", async () => {
    const f = vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://notcloudflareaccess.com/phishing" },
        }),
    );
    vi.stubGlobal("fetch", f);
    const r = await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "s" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(false);
    expect(r.error).toBe("HTTP 302");
    expect(r.error).not.toMatch(/access/i);
    vi.unstubAllGlobals();
  });

  it("detects Access failure on a subdomain (foo.cloudflareaccess.com)", async () => {
    const f = vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: {
            location: "https://foo.cloudflareaccess.com/cdn-cgi/access/login",
          },
        }),
    );
    vi.stubGlobal("fetch", f);
    const r = await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "s" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/access/i);
    vi.unstubAllGlobals();
  });

  it("is up on a 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    const r = await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "s" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(true);
    vi.unstubAllGlobals();
  });

  it("reports a bad config as a failed check, not a thrown error", async () => {
    const r = await executors.reachability({ url: 123 }, 1000, ctx());
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/config/i);
  });

  it("never puts the client secret in the error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Connection failed with SEKRIT credentials");
      }),
    );
    const r = await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "SEKRIT" },
      1000,
      ctx(),
    );
    expect(r.error ?? "").not.toContain("SEKRIT");
    vi.unstubAllGlobals();
  });
});
