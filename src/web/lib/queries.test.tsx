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
  lifecycleErrorMessage,
  POLL_MS,
  projectsPollInterval,
  queryKeys,
  refetchProjectsOnFocus,
  useLifecycle,
  useProject,
  useProjectOperations,
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
    expect(queryKeys.projectOperations("jellyfin")).toEqual([
      "project",
      "jellyfin",
      "operations",
    ]);
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

  it("carries the container states the detail view renders", async () => {
    const states = [
      {
        service: "web",
        name: "jellyfin-web-1",
        state: "running",
        health: null,
        exitCode: 0,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(200, { slug: "jellyfin", states, statesError: null }),
      ),
    );
    const { result } = renderHook(() => useProject("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.states).toEqual(states);
  });

  it("does not retry a refusal", async () => {
    // The whole detail page needs project:read, which is admin-only, so a
    // viewer gets one 403 and an explanation — not a retry storm.
    const fetchMock = vi.fn(async () => json(403, { error: "forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProject("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("useProjectOperations", () => {
  it("unwraps the operations envelope", async () => {
    const fetchMock = vi.fn(async (_path: string) =>
      json(200, { operations: [{ id: "op-1", kind: "up" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProjectOperations("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/projects/jellyfin/operations",
    );
    expect(result.current.data).toEqual([{ id: "op-1", kind: "up" }]);
  });

  it("does not retry a refusal", async () => {
    const fetchMock = vi.fn(async () => json(403, { error: "forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProjectOperations("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("useLifecycle", () => {
  it("posts the verb and returns the operation id", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(202, { operationId: "op-7" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLifecycle("jellyfin"), {
      wrapper: wrapper(testClient()),
    });

    let id: string | null = null;
    await act(async () => {
      id = await result.current.mutateAsync("restart");
    });
    expect(id).toBe("op-7");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/jellyfin/restart");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("escapes a slug into the path rather than concatenating it", async () => {
    const fetchMock = vi.fn(async (_path: string) =>
      json(202, { operationId: "op-7" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLifecycle("a b"), {
      wrapper: wrapper(testClient()),
    });
    await act(async () => {
      await result.current.mutateAsync("up");
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/a%20b/up");
  });

  it("surfaces a 409 as an ApiError the caller can name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(409, { error: "operation_in_progress" })),
    );
    const { result } = renderHook(() => useLifecycle("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await act(async () => {
      await expect(result.current.mutateAsync("up")).rejects.toBeInstanceOf(
        ApiError,
      );
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).status).toBe(409);
  });

  it("does not retry a lifecycle post", async () => {
    // A retried `up` is a second `docker compose up` against the same stack.
    const fetchMock = vi.fn(async () => json(500, { error: "boom" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLifecycle("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await act(async () => {
      await expect(result.current.mutateAsync("up")).rejects.toThrow();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("lifecycleErrorMessage", () => {
  it("explains a 409 in the user's terms", () => {
    expect(
      lifecycleErrorMessage(new ApiError(409, "operation_in_progress")),
    ).toMatch(/already running/i);
  });

  it("names a refusal as a permission problem", () => {
    // Controlling a stack needs project:control — a viewer never has it.
    expect(lifecycleErrorMessage(new ApiError(403, "forbidden"))).toMatch(
      /administrator/i,
    );
  });

  it("says the project is gone on a 404", () => {
    expect(lifecycleErrorMessage(new ApiError(404, "not_found"))).toMatch(
      /no longer/i,
    );
  });

  it("falls back to the error's own message", () => {
    expect(lifecycleErrorMessage(new Error("network down"))).toMatch(
      /network down/,
    );
  });
});
