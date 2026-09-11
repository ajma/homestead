// @vitest-environment jsdom
import type { LauncherApp } from "@shared/launcher";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { launcherKey } from "@web/api/launcher";
import { useEventStream } from "@web/live/useEventStream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. This double records every instance so a test can both
// dispatch events into the app and assert the connection was closed on unmount.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;
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
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

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
    client.setQueryData(launcherKey, [tile()]);
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
});
