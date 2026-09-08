import {
  focusManager,
  type QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./api.js";
import {
  createQueryClient,
  isRefusal,
  lifecycleErrorMessage,
  POLL_MS,
  projectsPollInterval,
  queryKeys,
  refetchUnlessRefused,
  useCreateProject,
  useDeleteProject,
  useLifecycle,
  useProject,
  useProjectFile,
  useProjectOperations,
  useProjects,
  useSaveProjectFile,
} from "./queries.js";

afterEach(() => {
  // Unmount first. focusManager is module-level state, and handing focus back
  // is a false→true transition that refetches every mounted query — after the
  // stub is gone, so it would go to the real network.
  cleanup();
  // Undo any focus the test forced.
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Render a hook with the app's query client.
 */
function renderHookWithClient<T>(hook: () => T) {
  return renderHook(hook, { wrapper: wrapper(testClient()) });
}

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

/**
 * The app's own client, with no retry delay so a failing query finishes inside
 * the test rather than inside a backoff.
 *
 * Built through `createQueryClient` deliberately: the refusal rules now live on
 * the client, and a test that constructed a bare `QueryClient` would be proving
 * things about a client the app never uses.
 */
function testClient() {
  return createQueryClient({ retryDelay: 0 });
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

describe("isRefusal", () => {
  it("names a 401 or a 403 and nothing else", () => {
    expect(isRefusal(new ApiError(401, "unauthenticated"))).toBe(true);
    expect(isRefusal(new ApiError(403, "forbidden"))).toBe(true);
    expect(isRefusal(new ApiError(500, "boom"))).toBe(false);
    expect(isRefusal(new ApiError(404, "not_found"))).toBe(false);
    expect(isRefusal(new Error("network down"))).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});

describe("refetchUnlessRefused", () => {
  const query = (error: unknown) => ({ state: { error } });

  it("refetches on focus while healthy but not after a refusal", () => {
    expect(refetchUnlessRefused(query(null))).toBe(true);
    expect(refetchUnlessRefused(query(new ApiError(500, "boom")))).toBe(true);
    expect(refetchUnlessRefused(query(new ApiError(403, "forbidden")))).toBe(
      false,
    );
    expect(
      refetchUnlessRefused(query(new ApiError(401, "unauthenticated"))),
    ).toBe(false);
  });
});

/**
 * The rule, not the call sites.
 *
 * P3-R16 made `useProjects` refusal-aware on window focus; the next task added
 * two hooks and neither inherited it, because inheriting it meant remembering
 * it. These two tests use a query that **no hook in this file owns** and that
 * sets no options at all — the shape a hook added next month will have. They
 * fail if the defaults are ever taken off the client, which is the only way
 * the regression can happen again.
 */
describe("the client every hook inherits from", () => {
  function useFutureHook() {
    return useQuery({
      queryKey: ["a-hook-nobody-has-written-yet"],
      queryFn: () => apiFetch<{ ok: boolean }>("/api/anything"),
    });
  }

  it("gives a hook that asks for nothing refusal-aware retry and focus", async () => {
    const fetchMock = vi.fn(async () => json(403, { error: "forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(useFutureHook, {
      wrapper: wrapper(testClient()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock, "a refusal is not retried").toHaveBeenCalledOnce();

    await refocusWindow();
    await refocusWindow();
    expect(
      fetchMock,
      "a refusal is not refetched on focus",
    ).toHaveBeenCalledOnce();
  });

  it("still retries and still refetches on focus when the failure is transient", async () => {
    // The other half: a default that refused everything would pass the test
    // above while breaking the app.
    const fetchMock = vi.fn(async () => json(500, { error: "boom" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(useFutureHook, {
      wrapper: wrapper(testClient()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await refocusWindow();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(3));
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

  it("does not refetch on focus once the server has refused", async () => {
    // A viewer following a project link an admin sent them lands here. Left at
    // the default this issued a guaranteed 403 on every single alt-tab, for as
    // long as the tab stayed open.
    const fetchMock = vi.fn(async () => json(403, { error: "forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProject("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    await refocusWindow();
    await refocusWindow();
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

  it("does not refetch on focus once the server has refused", async () => {
    // The second of the two requests a viewer's alt-tab used to cost.
    const fetchMock = vi.fn(async () => json(403, { error: "forbidden" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useProjectOperations("jellyfin"), {
      wrapper: wrapper(testClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    await refocusWindow();
    await refocusWindow();
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

  it("says which operation is already running, when the server said", () => {
    // The 409 body's `detail` is the only thing that names it. Without it the
    // message can say "an operation" and nothing more, which answers none of
    // the question the user actually has.
    const message = lifecycleErrorMessage(
      new ApiError(
        409,
        "operation_in_progress",
        'an operation is already running for project "jellyfin"',
      ),
    );
    expect(message).toContain('project "jellyfin"');
    // Still a sentence: the server's detail is a fragment.
    expect(message).toMatch(/^An operation/);
    expect(message).toMatch(/wait for it to finish/i);
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

describe("useProjectFile", () => {
  it("returns null rather than throwing when the file does not exist", async () => {
    // A project with no .env is normal, and the route renders it as 404.
    // Throwing would make the editor show an error for an ordinary state.
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(404, { error: "not_found" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHookWithClient(() =>
      useProjectFile("media", "env"),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/media/file/env");
    expect(result.current.data).toBeNull();
  });

  it("returns the content on success", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(200, { content: "A=1\n" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHookWithClient(() =>
      useProjectFile("media", "env"),
    );
    await waitFor(() =>
      expect(result.current.data).toEqual({ content: "A=1\n" }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/media/file/env");
  });

  it("still surfaces a 403 as an error", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(403, { error: "forbidden" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHookWithClient(() =>
      useProjectFile("media", "compose"),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/projects/media/file/compose",
    );
  });
});

describe("useSaveProjectFile", () => {
  it("PUTs the content to the file route", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHookWithClient(() =>
      useSaveProjectFile("media", "compose"),
    );
    await act(async () => {
      await result.current.mutateAsync("services: {}\n");
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/projects/media/file/compose",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(body as string)).toEqual({ content: "services: {}\n" });
  });

  it("invalidates the file cache and the project detail", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = testClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(
      () => useSaveProjectFile("media", "compose"),
      {
        wrapper: wrapper(client),
      },
    );
    await act(async () => {
      await result.current.mutateAsync("services: {}\n");
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.file("media", "compose"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.project("media"),
    });
  });
});

describe("useCreateProject", () => {
  it("reports an invalid paste as data, not as a failure", async () => {
    // 201 with valid:false — the project exists and the user must reach its
    // editor, so this must not land in the error branch.
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(201, {
        slug: "broken",
        valid: false,
        error: "services must be a mapping",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHookWithClient(() => useCreateProject());
    let out: unknown;
    await act(async () => {
      out = await result.current.mutateAsync({
        slug: "broken",
        source: "paste",
        content: "x",
      });
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(body as string)).toEqual({
      slug: "broken",
      source: "paste",
      content: "x",
    });
    expect(out).toMatchObject({ slug: "broken", valid: false });
  });

  it("surfaces a 409 as an ApiError carrying the code", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(409, { error: "project_exists" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHookWithClient(() => useCreateProject());
    await expect(
      result.current.mutateAsync({ slug: "media", source: "blank" }),
    ).rejects.toMatchObject({ status: 409, code: "project_exists" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(body as string)).toEqual({
      slug: "media",
      source: "blank",
    });
  });

  it("invalidates the projects list on success", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(201, { slug: "media", valid: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = testClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCreateProject(), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ slug: "media", source: "blank" });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.projects,
    });
  });
});

describe("useDeleteProject", () => {
  it("DELETEs the project", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHookWithClient(() => useDeleteProject());
    await act(async () => {
      await result.current.mutateAsync("media");
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/media");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("invalidates the projects list on success", async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      json(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = testClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useDeleteProject(), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync("media");
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.projects,
    });
  });
});
