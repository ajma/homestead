import { ApiError, apiFetch } from "@web/api/client";
import { describe, expect, it, vi } from "vitest";

describe("apiFetch", () => {
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
});
