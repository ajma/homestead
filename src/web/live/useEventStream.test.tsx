// @vitest-environment jsdom

import type { LauncherApp, ProbeSnapshot } from "@shared/launcher";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { adminAppKey } from "@web/api/admin";
import { launcherKey } from "@web/api/launcher";
import { useEventStream } from "@web/live/useEventStream";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. This double records every instance so a test can both
// dispatch events into the app and assert the connection was closed on unmount. It also
// tracks `readyState`, since a fatal (CLOSED) error and a retryable (CONNECTING) one must
// be tell-able apart for the hook's own reconnect logic to be tested at all.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;
  readyState: number = FakeEventSource.CONNECTING;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
  // `data` is omitted for `open`/`error`, which carry none on a real EventSource.
  emit(type: string, data?: unknown) {
    const init = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, init));
    }
  }
}

const probe = (over: Partial<ProbeSnapshot> = {}): ProbeSnapshot => ({
  probeId: "docker1",
  kind: "docker",
  label: null,
  status: "up",
  faultClass: null,
  statusSince: 1000,
  lastCheckedAt: 1000,
  ...over,
});

const tile = (over: Partial<LauncherApp> = {}): LauncherApp => ({
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: null,
  iconRef: null,
  category: "Media",
  launchUrl: null,
  sortOrder: 0,
  status: "up",
  reason: "Healthy",
  since: 100,
  probes: [],
  ...over,
});

function Harness() {
  useEventStream();
  return null;
}

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("useEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("opens exactly one connection no matter how many renders happen", async () => {
    const client = new QueryClient();
    const { rerender } = mount(client);
    rerender(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0]?.url).toBe("/api/events");
  });

  it("patches the cached tile in place instead of refetching", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [
      tile({ probes: [probe({ probeId: "p1", kind: "docker", status: "up" })] }),
    ]);
    let fetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetches++;
        return new Response("{}", { status: 200 });
      }),
    );

    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("status", {
        appId: "a1",
        probeId: "p1",
        status: "down",
        faultClass: "app",
      });
    });

    const patched = client.getQueryData<LauncherApp[]>(launcherKey);
    expect(patched?.[0]?.status).toBe("down");
    expect(patched?.[0]?.reason).toBe("Containers not running");
    // The assertion the spec's rationale is actually about.
    expect(fetches).toBe(0);
  });

  it("ignores an event for an app not in the cache", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [tile()]);
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("status", {
        appId: "not-mine",
        probeId: "p9",
        status: "down",
        faultClass: "app",
      });
    });
    expect(client.getQueryData<LauncherApp[]>(launcherKey)).toEqual([tile()]);
  });

  it("survives a malformed payload without tearing down the stream", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [tile()]);
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      for (const fn of source?.listeners.get("status") ?? []) {
        fn(new MessageEvent("status", { data: "{not json" }));
      }
    });
    expect(client.getQueryData<LauncherApp[]>(launcherKey)).toEqual([tile()]);
    expect(source?.closed).toBe(false);
  });

  it("closes the connection on unmount, so navigating away leaks nothing", async () => {
    const client = new QueryClient();
    const { unmount } = mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  it("does not let one recovering probe paint the tile up while a sibling is still down (Critical 1)", async () => {
    // The old code wrote `payload.status` straight onto the tile. That made this exact
    // sequence — the HTTP probe recovering while Docker was still down — jump the tile to
    // `up` / "Healthy" and stay there, since `EventBus.publish` never re-announces an
    // unchanged failure.
    const client = new QueryClient();
    client.setQueryData(launcherKey, [
      tile({
        status: "down",
        reason: "Containers not running",
        probes: [
          probe({ probeId: "docker1", kind: "docker", status: "down", faultClass: "app" }),
          probe({ probeId: "http1", kind: "http_internal", status: "down", faultClass: "app" }),
        ],
      }),
    ]);
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("status", {
        appId: "a1",
        probeId: "http1",
        status: "up",
        faultClass: null,
      });
    });
    const [after] = client.getQueryData<LauncherApp[]>(launcherKey) ?? [];
    expect(after?.status).toBe("down");
    expect(after?.reason).toBe("Containers not running");
  });

  it("reaches up/Healthy once every probe has actually recovered", async () => {
    // Without this, the Critical 1 test above would be satisfied by a tile that simply
    // never updates at all.
    const client = new QueryClient();
    client.setQueryData(launcherKey, [
      tile({
        status: "down",
        reason: "Containers not running",
        probes: [
          probe({ probeId: "docker1", kind: "docker", status: "down", faultClass: "app" }),
          probe({ probeId: "http1", kind: "http_internal", status: "down", faultClass: "app" }),
        ],
      }),
    ]);
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("status", {
        appId: "a1",
        probeId: "docker1",
        status: "up",
        faultClass: null,
      });
      FakeEventSource.instances[0]?.emit("status", {
        appId: "a1",
        probeId: "http1",
        status: "up",
        faultClass: null,
      });
    });
    const [after] = client.getQueryData<LauncherApp[]>(launcherKey) ?? [];
    expect(after?.status).toBe("up");
    expect(after?.reason).toBe("Healthy");
  });

  it("matches the server's phrase for a failing tunnel over an otherwise healthy app", async () => {
    // The pair the review named: the old client's local `reasonFor` had no way to produce
    // this phrase and instead reported `down` / "Containers not running".
    const client = new QueryClient();
    client.setQueryData(launcherKey, [
      tile({
        probes: [
          probe({ probeId: "docker1", kind: "docker", status: "up" }),
          probe({ probeId: "ext1", kind: "http_external", status: "up" }),
        ],
      }),
    ]);
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("status", {
        appId: "a1",
        probeId: "ext1",
        status: "down",
        faultClass: "network",
      });
    });
    const [after] = client.getQueryData<LauncherApp[]>(launcherKey) ?? [];
    expect(after?.status).toBe("degraded");
    expect(after?.reason).toBe("Tunnel unreachable — app is fine");
  });

  it("does not move `since` when a non-worst probe reports", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [
      tile({
        status: "down",
        reason: "Containers not running",
        since: 1000,
        probes: [
          probe({
            probeId: "docker1",
            kind: "docker",
            status: "down",
            faultClass: "app",
            statusSince: 1000,
          }),
          probe({
            probeId: "http1",
            kind: "http_internal",
            status: "up",
            statusSince: 900,
          }),
        ],
      }),
    ]);
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("status", {
        appId: "a1",
        probeId: "http1",
        status: "degraded",
        faultClass: "app",
      });
    });
    const [after] = client.getQueryData<LauncherApp[]>(launcherKey) ?? [];
    expect(after?.status).toBe("down");
    expect(after?.since).toBe(1000);
  });

  it("invalidates the launcher query on a reconnect, but not on the very first open", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [tile()]);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];

    const invalidatedLauncher = () =>
      invalidateSpy.mock.calls.some(([opts]) => opts?.queryKey === launcherKey);

    act(() => {
      source?.emit("open");
    });
    expect(invalidatedLauncher()).toBe(false);

    act(() => {
      source?.emit("open");
    });
    expect(invalidatedLauncher()).toBe(true);
  });

  it("opens a new EventSource after a fatal (CLOSED) error, once the backoff elapses", () => {
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      mount(client);
      expect(FakeEventSource.instances.length).toBe(1);
      const first = FakeEventSource.instances[0];
      if (!first) throw new Error("no instance was created");

      first.readyState = FakeEventSource.CLOSED;
      act(() => {
        first.emit("error");
      });
      // A retry that ignored the backoff entirely would show up here already.
      expect(FakeEventSource.instances.length).toBe(1);

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(FakeEventSource.instances.length).toBe(2);
      expect(FakeEventSource.instances[1]?.url).toBe("/api/events");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the pending reconnect timer on unmount, leaking no Timeout handle", () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    const client = new QueryClient();
    const { unmount } = mount(client);
    const first = FakeEventSource.instances[0];
    if (!first) throw new Error("no instance was created");

    first.readyState = FakeEventSource.CLOSED;
    act(() => {
      first.emit("error");
    });
    unmount();

    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(after).toBe(before);
  });

  it("invalidates the launcher and the admin app query on an app-changed frame", async () => {
    // The probe-editing UI's server half (Task 11): a probe create/delete/enabled-PATCH
    // publishes this frame so every open tab's stale `ProbeSnapshot[]` gets refetched
    // rather than silently going on trusting a probe set that no longer exists.
    const client = new QueryClient();
    client.setQueryData(launcherKey, [tile()]);
    client.setQueryData(adminAppKey("a1"), { id: "a1" });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    act(() => {
      FakeEventSource.instances[0]?.emit("app-changed", { appId: "a1" });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: launcherKey });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: adminAppKey("a1") });
  });

  it("survives a malformed app-changed frame without tearing down the stream", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [tile()]);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];

    act(() => {
      for (const fn of source?.listeners.get("app-changed") ?? []) {
        fn(new MessageEvent("app-changed", { data: "{not json" }));
      }
    });

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: launcherKey });
    expect(source?.closed).toBe(false);
  });

  it("keeps exactly one live connection when StrictMode double-invokes the effect", () => {
    const client = new QueryClient();
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>
      </StrictMode>,
    );
    const live = FakeEventSource.instances.filter((s) => !s.closed);
    expect(live.length).toBe(1);
  });
});
