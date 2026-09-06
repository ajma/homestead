import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.js";
import {
  POLL_MS,
  projectsPollInterval,
  queryKeys,
  refetchProjectsOnFocus,
  useProject,
  useProjects,
} from "./queries.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Undo any focus the test forced; focusManager is module-level state.
  focusManager.setFocused(undefined);
});

/** Alt-tab away and back. */
async function refocusWindow() {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** No retry delay: a failing query should finish inside a test, not a backoff. */
function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
}

describe("queryKeys", () => {
  it("keys the list under the key sign-out clears", () => {
    // AppShell's sign-out calls queryClient.clear(), and its test seeds
    // ["projects"]. A key change here silently orphans that guarantee.
    expect(queryKeys.projects).toEqual(["projects"]);
    expect(queryKeys.project("jellyfin")).toEqual(["project", "jellyfin"]);
  });
});

describe("projectsPollInterval", () => {
  it("polls every 15 seconds while the list is healthy", () => {
    expect(POLL_MS).toBe(15_000);
    expect(projectsPollInterval(null)).toBe(POLL_MS);
    expect(projectsPollInterval(new ApiError(500, "boom"))).toBe(POLL_MS);
  });

  it("stops polling once the server has refused", () => {
    // A viewer holds only app:read, so the 403 will not change on its own.
    // Polling it every 15s for as long as the tab is open is a wasted request
    // every 15s, forever.
    expect(projectsPollInterval(new ApiError(403, "forbidden"))).toBe(false);
    expect(projectsPollInterval(new ApiError(401, "unauthenticated"))).toBe(
      false,
    );
  });
});

describe("refetchProjectsOnFocus", () => {
  it("refetches on focus while healthy but not after a refusal", () => {
    expect(refetchProjectsOnFocus(null)).toBe(true);
    expect(refetchProjectsOnFocus(new ApiError(500, "boom"))).toBe(true);
    expect(refetchProjectsOnFocus(new ApiError(403, "forbidden"))).toBe(false);
    expect(refetchProjectsOnFocus(new ApiError(401, "unauthenticated"))).toBe(
      false,
    );
  });
});

describe("useProjects", () => {
  it("unwraps the response envelope into the list of entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { projects: [{ slug: "jellyfin" }] })),
    );
    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ slug: "jellyfin" }]);
  });

  it("surfaces a refusal as an ApiError without retrying it", async () => {
    const fetchMock = vi.fn(async () => json(403, { error: "forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refetches when the window regains focus", async () => {
    const fetchMock = vi.fn(async () => json(200, { projects: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledOnce();

    await refocusWindow();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("does not refetch on focus once the server has refused", async () => {
    // Focus refetching is a separate switch from the poll interval, and an
    // errored query has no dataUpdatedAt so it always counts as stale. A
    // viewer who leaves this tab open and alt-tabs 200 times would otherwise
    // issue 200 requests that are all guaranteed to 403.
    const fetchMock = vi.fn(async () => json(403, { error: "forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledOnce();

    await refocusWindow();
    await refocusWindow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refetches on the poll interval", async () => {
    // Fake timers must be installed before the query mounts: react-query
    // schedules the interval as the query settles.
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json(200, { projects: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(testClient()),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.isSuccess).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS - 1000);
    });
    expect(fetchMock, "must not fire early").toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("useProject", () => {
  it("requests the slug's detail endpoint", async () => {
    const fetchMock = vi.fn(async (_path: string) =>
      json(200, { slug: "jellyfin" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProject("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/jellyfin");
  });

  it("does not fire without a slug", () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    // A bare /projects/ would otherwise request /api/projects/ and 404.
    renderHook(() => useProject(""), { wrapper: wrapper(testClient()) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
