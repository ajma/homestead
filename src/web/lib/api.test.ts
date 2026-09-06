import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./api.js";

const mockFetch = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );

afterEach(() => vi.unstubAllGlobals());

/** The last `fetch(input, init)` call the stub recorded. */
function lastCall(): [string, RequestInit] {
  const mock = vi.mocked(globalThis.fetch);
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was never called");
  return [call[0] as string, (call[1] ?? {}) as RequestInit];
}

describe("apiFetch", () => {
  it("returns parsed JSON on success", async () => {
    mockFetch(200, { projects: [] });
    expect(await apiFetch("/api/projects")).toEqual({ projects: [] });
  });

  it("throws ApiError carrying the status and server code", async () => {
    mockFetch(409, { error: "operation_in_progress" });
    await expect(
      apiFetch("/api/projects/a/up", { method: "POST" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "operation_in_progress",
    });
  });

  it("throws ApiError for a 403 rather than resolving", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(ApiError);
  });

  it("tolerates an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    expect(await apiFetch("/api/whatever")).toBeNull();
  });

  it("sends the session cookie", async () => {
    mockFetch(200, {});
    await apiFetch("/api/projects");
    expect(lastCall()[1].credentials).toBe("same-origin");
  });

  it("declares JSON when it sends a body, and not when it does not", async () => {
    mockFetch(200, {});
    await apiFetch("/api/projects/a/file/env", {
      method: "PUT",
      body: JSON.stringify({ content: "" }),
    });
    expect(new Headers(lastCall()[1].headers).get("content-type")).toBe(
      "application/json",
    );

    await apiFetch("/api/projects");
    expect(new Headers(lastCall()[1].headers).get("content-type")).toBeNull();
  });

  it("leaves an explicit Content-Type alone", async () => {
    mockFetch(200, {});
    await apiFetch("/api/projects/a/file/compose", {
      method: "PUT",
      body: "services: {}",
      headers: { "Content-Type": "text/plain" },
    });
    expect(new Headers(lastCall()[1].headers).get("content-type")).toBe(
      "text/plain",
    );
  });

  it("redirects to the login screen on 401 and still throws", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mockFetch(401, { error: "unauthenticated" });

    // It must throw as well as redirect: navigation is asynchronous, so a
    // caller that carried on would render with data it never received.
    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("does not redirect on a 403", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mockFetch(403, { error: "forbidden" });

    // A viewer lacking project:read is signed in. Bouncing them to /login
    // would loop: they authenticate, land back here, and get 403 again.
    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(ApiError);
    expect(assign).not.toHaveBeenCalled();
  });

  it("still throws when the failure body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>502 Bad Gateway</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    await expect(apiFetch("/api/projects")).rejects.toMatchObject({
      status: 502,
      code: undefined,
    });
  });
});
