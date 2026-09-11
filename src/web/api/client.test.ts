import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Stands in for the browser's real `fetch`: it settles only when the `signal` it was
 * given aborts, the same way a real in-flight request does. Anything that never aborts
 * that signal — a bug that dropped the timeout, or one that ignored the caller's own
 * signal — leaves the returned promise pending forever, which is exactly the behaviour
 * these tests need to distinguish from a timeout actually firing.
 */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
}

describe("apiFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(apiFetch("/api/health")).resolves.toEqual({ ok: 1 });
  });

  it("throws ApiError carrying the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(apiFetch("/api/users")).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch("/api/users")).rejects.toMatchObject({ status: 403 });
  });

  it("returns null for 204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(apiFetch("/api/users/x")).resolves.toBeNull();
  });

  it("rejects with a distinguishable ApiTimeoutError once the default timeout elapses", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());

    const pending = apiFetch("/api/slow");
    const assertion = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
  });

  it("does not time out a request that resolves well within the default", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const pending = apiFetch("/api/health");
    // Advancing past the point where a hung request would time out proves a fast one
    // already settled on its own rather than merely not having failed yet.
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toEqual({ ok: 1 });
  });

  it("still aborts for a caller-supplied signal instead of overriding it", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();

    const pending = apiFetch("/api/slow", { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();

    await assertion;
  });

  it("honours a per-call timeoutMs override instead of the 30s default", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());

    const pending = apiFetch("/api/slow", undefined, { timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
  });
});
