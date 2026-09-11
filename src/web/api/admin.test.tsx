// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { adminAppsKey, containersKey, useAdminApps, useContainers, useScan } from "@web/api/admin";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

describe("admin query hooks", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(url.includes("scan") ? { discovered: [], orphans: [] } : []),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
  });

  it("keys the app list distinctly from the launcher's list", () => {
    // Sharing a key would make an admin's expensive rollup overwrite the launcher's
    // cheap one, and the launcher would start depending on Docker by accident.
    expect(adminAppsKey).not.toEqual(["launcher"]);
  });

  it("keys per-app collections under that app's id", () => {
    expect(containersKey("a1")).not.toEqual(containersKey("a2"));
  });

  it("does not fetch a per-app collection while the id is null", async () => {
    const { Wrapper } = wrapper();
    renderHook(() => useContainers(null), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not scan until asked", async () => {
    // The scan walks the whole compose root and lists every container. Firing it on
    // mount would make opening the inventory pay for a dialog nobody opened.
    const { Wrapper } = wrapper();
    renderHook(() => useScan(false), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches the app list from /api/apps", async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useAdminApps(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/apps");
  });
});
