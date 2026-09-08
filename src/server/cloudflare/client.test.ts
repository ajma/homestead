import { describe, expect, it, vi } from "vitest";
import { createCloudflareClient } from "./client.js";

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, result, errors: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("createCloudflareClient", () => {
  it("sends the token as a bearer header", async () => {
    const f = vi.fn<typeof fetch>(async () => ok([]));
    await createCloudflareClient({ token: "sekrit", fetch: f }).listAccounts();
    const init = f.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sekrit",
    );
  });

  it("lists zones from the top-level collection, filtered by account", async () => {
    // Zones are not nested under an account. Cloudflare answers
    // /accounts/{id}/zones with 400 "No route for that URI", so the whole
    // tunnel setup died the moment an account was chosen.
    const f = vi.fn<typeof fetch>(async () => ok([]));
    await createCloudflareClient({ token: "t", fetch: f }).listZones("acc-123");
    const url = String(f.mock.calls[0]?.[0]);
    expect(url).toContain("/zones?account.id=acc-123");
    expect(url).not.toContain("/accounts/acc-123/zones");
  });

  it("escapes the account id rather than pasting it into the query", async () => {
    const f = vi.fn<typeof fetch>(async () => ok([]));
    await createCloudflareClient({ token: "t", fetch: f }).listZones("a b&c=d");
    expect(String(f.mock.calls[0]?.[0])).toContain("account.id=a%20b%26c%3Dd");
  });

  it("never puts the token in a thrown error", async () => {
    // An error surfaces in logs and in a 500 body. A credential must not ride along.
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
          { status: 403 },
        ),
    );
    const client = createCloudflareClient({ token: "sekrit", fetch: f });
    await expect(client.listAccounts()).rejects.toThrow(/Authentication error/);
    await expect(client.listAccounts()).rejects.not.toThrow(/sekrit/);
  });

  it("reports the scopes a token is missing rather than a bare failure", async () => {
    const f = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/accounts")
        ? new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 9109, message: "Unauthorized" }],
            }),
            { status: 403 },
          )
        : ok([]),
    );
    const r = await createCloudflareClient({
      token: "t",
      fetch: f,
    }).verifyToken();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingScopes.length).toBeGreaterThan(0);
  });

  it("surfaces a Cloudflare error body rather than a bare status", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1003, message: "Invalid zone" }],
          }),
          { status: 400 },
        ),
    );
    await expect(
      createCloudflareClient({ token: "t", fetch: f }).listZones("a"),
    ).rejects.toThrow(/Invalid zone/);
  });

  it("throws on HTTP 200 with success: false (core Cloudflare behavior)", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1003, message: "Invalid zone" }],
          }),
          { status: 200 }, // HTTP 200 but success: false
        ),
    );
    await expect(
      createCloudflareClient({ token: "t", fetch: f }).listZones("a"),
    ).rejects.toThrow(/Invalid zone/);
  });

  it("handles non-JSON response body", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response("<!DOCTYPE html><html>Error</html>", { status: 500 }),
    );
    await expect(
      createCloudflareClient({ token: "t", fetch: f }).listAccounts(),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("handles empty response body", async () => {
    const f = vi.fn<typeof fetch>(
      async () => new Response("", { status: 500 }),
    );
    await expect(
      createCloudflareClient({ token: "t", fetch: f }).listAccounts(),
    ).rejects.toThrow(/not a valid envelope/);
  });

  it("handles fetch rejection (network error)", async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      createCloudflareClient({ token: "t", fetch: f }).listAccounts(),
    ).rejects.toThrow(/network error.*ECONNREFUSED/);
  });

  it("handles missing errors field in failure response", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ success: false }), { status: 400 }),
    );
    await expect(
      createCloudflareClient({ token: "t", fetch: f }).listAccounts(),
    ).rejects.toThrow(/Unknown error/);
  });

  it("handles empty errors array in failure response", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [] }), {
          status: 400,
        }),
    );
    await expect(
      createCloudflareClient({ token: "t", fetch: f }).listAccounts(),
    ).rejects.toThrow(/Unknown error/);
  });

  it("returns empty array when result is null", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ success: true, result: null, errors: [] }),
          { status: 200 },
        ),
    );
    const accounts = await createCloudflareClient({
      token: "t",
      fetch: f,
    }).listAccounts();
    expect(accounts).toEqual([]);
  });

  it("does not report non-scope 403s as missing scopes", async () => {
    // Error code 10000 is "Authentication error" (bad token), not a scope issue
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
          { status: 403 },
        ),
    );
    const r = await createCloudflareClient({
      token: "t",
      fetch: f,
    }).verifyToken();
    // Should return ok: true because the error is not a scope issue
    // (all probes failed with the same auth error, not permission errors)
    expect(r.ok).toBe(true);
  });
});
