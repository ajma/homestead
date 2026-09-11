import type { LauncherApp } from "@shared/launcher";
import { QueryClient } from "@tanstack/react-query";
import { launcherKey, launcherQueryOptions } from "@web/api/launcher";
import { clearPendingPatchesForTest, recordPatch } from "@web/live/sse-patch-store";
import { afterEach, describe, expect, it, vi } from "vitest";

const tile = (over: Partial<LauncherApp> = {}): LauncherApp => ({
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: null,
  iconRef: null,
  category: null,
  launchUrl: null,
  sortOrder: 0,
  status: "up",
  reason: "Healthy",
  since: 100,
  probes: [
    {
      probeId: "p1",
      kind: "docker",
      label: null,
      status: "up",
      faultClass: null,
      statusSince: 100,
      lastCheckedAt: 100,
    },
  ],
  ...over,
});

describe("useLauncherApps' patch survival (Important 2)", () => {
  afterEach(() => {
    clearPendingPatchesForTest();
    vi.unstubAllGlobals();
  });

  it("keeps an SSE patch that lands while a launcher refetch is already in flight", async () => {
    // Exactly the measured race: a fetch starts, reads the pre-transition row from the
    // server, an SSE event patches the cache while that fetch is still in the air, and
    // the fetch's stale response must not be allowed to overwrite the patch when it
    // finally resolves.
    let resolveFetch: (response: Response) => void = () => {};
    const inFlight = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => inFlight),
    );

    const client = new QueryClient();
    const fetchPromise = client.fetchQuery(launcherQueryOptions());

    // The event lands mid-flight — after the fetch started, before it resolves.
    recordPatch("p1", {
      appId: "a1",
      status: "down",
      faultClass: "app",
      statusSince: 900,
      patchedAt: Date.now(),
    });

    // The response the in-flight fetch actually reads: the server row from before the
    // transition landed.
    resolveFetch(
      new Response(JSON.stringify({ apps: [tile()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await fetchPromise;
    expect(result[0]).toMatchObject({ status: "down", reason: "Containers not running" });
    expect(result[0]?.probes[0]).toMatchObject({ status: "down", faultClass: "app" });
    expect(client.getQueryData(launcherKey)).toEqual(result);
  });

  it("does not touch a fetch's result when no patch is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ apps: [tile()] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new QueryClient();
    const result = await client.fetchQuery(launcherQueryOptions());
    expect(result[0]).toMatchObject({ status: "up", reason: "Healthy" });
  });
});
