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

  describe("detectTokenKind", () => {
    it("calls nothing when the prefix already settles it", async () => {
      // cfut_ is Cloudflare's documented user-token prefix. Spending a request
      // to learn what the string already says is waste.
      const f = vi.fn<typeof fetch>(async () => ok([]));
      const kind = await createCloudflareClient({
        token: "cfut_abc123",
        fetch: f,
      }).detectTokenKind();
      expect(kind).toBe("user");
      expect(f).not.toHaveBeenCalled();
    });

    it("recognises an account-owned token by its prefix", async () => {
      const f = vi.fn<typeof fetch>(async () => ok([]));
      const kind = await createCloudflareClient({
        token: "cfat_abc123",
        fetch: f,
      }).detectTokenKind();
      expect(kind).toBe("account");
      expect(f).not.toHaveBeenCalled();
    });

    it("probes memberships for a token predating the prefix format", async () => {
      // Older tokens carry no prefix. Only a user token has a user context, so
      // /memberships answering at all is the tell.
      const f = vi.fn<typeof fetch>(async () => ok([{ id: "m1" }]));
      const kind = await createCloudflareClient({
        token: "0123456789abcdef0123456789abcdef01234567",
        fetch: f,
      }).detectTokenKind();
      expect(kind).toBe("user");
      expect(String(f.mock.calls[0]?.[0])).toContain("/memberships");
    });

    it("treats a refused memberships probe as account-owned", async () => {
      const f = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [
                { code: 9109, message: "Unauthorized to access resource" },
              ],
            }),
            { status: 403 },
          ),
      );
      const kind = await createCloudflareClient({
        token: "0123456789abcdef0123456789abcdef01234567",
        fetch: f,
      }).detectTokenKind();
      expect(kind).toBe("account");
    });

    it("does not call a network failure an account token", async () => {
      // Misreading a timeout as "account-owned" would let a user token through
      // whenever Cloudflare is briefly unreachable.
      const f = vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      });
      await expect(
        createCloudflareClient({
          token: "0123456789abcdef0123456789abcdef01234567",
          fetch: f,
        }).detectTokenKind(),
      ).rejects.toThrow(/network/i);
    });
  });

  it("falls back to memberships when /accounts comes back empty", async () => {
    // Verified against a real token: /accounts answers 200 with an empty array
    // and total_count 0, while /memberships returns the account perfectly well.
    // Trusting /accounts alone strands setup on an empty dropdown for a token
    // that can do everything else.
    const calls: string[] = [];
    const f = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/memberships")) {
        return ok([
          { id: "mem-1", account: { id: "acc-real", name: "Real Account" } },
        ]);
      }
      return ok([]);
    });

    const accounts = await createCloudflareClient({
      token: "t",
      fetch: f,
    }).listAccounts();

    expect(accounts).toEqual([{ id: "acc-real", name: "Real Account" }]);
    expect(calls.some((u) => u.endsWith("/accounts"))).toBe(true);
  });

  it("does not call memberships when /accounts already answered", async () => {
    // The fallback is for a gap in /accounts, not a second request every time.
    const calls: string[] = [];
    const f = vi.fn<typeof fetch>(async (input) => {
      calls.push(String(input));
      return ok([{ id: "acc-1", name: "From Accounts" }]);
    });

    const accounts = await createCloudflareClient({
      token: "t",
      fetch: f,
    }).listAccounts();

    expect(accounts).toEqual([{ id: "acc-1", name: "From Accounts" }]);
    expect(calls.some((u) => u.includes("/memberships"))).toBe(false);
  });

  it("returns empty when neither source knows of an account", async () => {
    const f = vi.fn<typeof fetch>(async () => ok([]));
    const accounts = await createCloudflareClient({
      token: "t",
      fetch: f,
    }).listAccounts();
    expect(accounts).toEqual([]);
  });

  it("survives a membership row with no account object", async () => {
    const f = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/memberships")
        ? ok([{ id: "mem-1" }, { id: "m2", account: { id: "a", name: "A" } }])
        : ok([]),
    );
    const accounts = await createCloudflareClient({
      token: "t",
      fetch: f,
    }).listAccounts();
    expect(accounts).toEqual([{ id: "a", name: "A" }]);
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
