import { describe, expect, it, vi } from "vitest";
import { createCloudflareClient } from "./client.js";
import { CloudflareError } from "./errors.js";

const TOKEN = "cfat_test-token-abcd1234";
const ACCOUNT_ID = "account-1";

function envelope(body: {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: unknown;
  result_info?: { page: number; per_page: number; count: number; total_count: number };
}) {
  return { errors: [], ...body };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** A `sleep` that resolves immediately but still records what it was asked to wait for,
 * so retry/backoff tests never wait out real timers. */
function fakeSleep() {
  return vi.fn(async (_ms: number) => {});
}

function client(opts: {
  fetch: typeof globalThis.fetch;
  sleep?: ReturnType<typeof fakeSleep>;
  now?: () => number;
}) {
  return createCloudflareClient({
    token: TOKEN,
    accountId: ACCOUNT_ID,
    fetch: opts.fetch,
    sleep: opts.sleep ?? fakeSleep(),
    now: opts.now,
  });
}

describe("createCloudflareClient", () => {
  describe("envelope and success", () => {
    it("returns zones from a 200 with success:true", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: [
              { id: "z1", name: "example.com" },
              { id: "z2", name: "example.org" },
            ],
            result_info: { page: 1, per_page: 50, count: 2, total_count: 2 },
          }),
        ),
      );
      const zones = await client({ fetch: fetchMock }).listZones();
      expect(zones).toEqual([
        { id: "z1", name: "example.com" },
        { id: "z2", name: "example.org" },
      ]);
    });

    it("treats a 200 with success:false as an error, not a success", async () => {
      // `result` is a validly-shaped (empty) zone list on purpose: an implementation that
      // trusts the HTTP status and ignores `success` would otherwise be caught only by
      // the shape check below, not by the success:false check this test exists to bind.
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: false, errors: [{ code: 1003, message: "nope" }], result: [] }),
        ),
      );
      await expect(client({ fetch: fetchMock }).listZones()).rejects.toBeInstanceOf(
        CloudflareError,
      );
    });

    it("raises a cloudflare fault when the body is not the v4 envelope at all (HTML)", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("<html><body>502 Bad Gateway</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      );
      const error = await client({ fetch: fetchMock })
        .listZones()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).fault).toBe("cloudflare");
    });

    it("raises a cloudflare fault when the body is empty", async () => {
      const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
      const error = await client({ fetch: fetchMock })
        .listZones()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).fault).toBe("cloudflare");
    });

    it("accepts a result_info that omits count, a field the plan never claimed was known", async () => {
      // `count` is not on the plan's "known and safe to rely on" list for `result_info`
      // (only `page`, `per_page`, `total_count` are) — a schema that required it anyway
      // would fail this entire, otherwise-valid envelope the moment Cloudflare omits or
      // renames a field nothing here even uses.
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          success: true,
          errors: [],
          result: [{ id: "z1", name: "example.com" }],
          result_info: { page: 1, per_page: 50, total_count: 1 },
        }),
      );
      const zones = await client({ fetch: fetchMock }).listZones();
      expect(zones).toEqual([{ id: "z1", name: "example.com" }]);
    });
  });

  describe("fault classification", () => {
    it("classifies a 401 as auth", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: false, errors: [{ code: 9109, message: "Invalid access token" }] }),
          { status: 401 },
        ),
      );
      const error = (await client({ fetch: fetchMock })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.fault).toBe("auth");
    });

    it("classifies error code 10000 as auth even without a 401 status", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          }),
          { status: 400 },
        ),
      );
      const error = (await client({ fetch: fetchMock })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.fault).toBe("auth");
    });

    it("classifies a 403 as permission", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: false, errors: [{ code: 9109, message: "forbidden" }] }), {
          status: 403,
        }),
      );
      const error = (await client({ fetch: fetchMock })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.fault).toBe("permission");
    });

    it("classifies a 429 as rate_limit", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: false, errors: [{ code: 10013, message: "rate limited" }] }),
          {
            status: 429,
          },
        ),
      );
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.fault).toBe("rate_limit");
    });

    it("classifies a 5xx as cloudflare", async () => {
      const fetchMock = vi.fn(async () => new Response("Internal Server Error", { status: 502 }));
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.fault).toBe("cloudflare");
    });

    it("classifies a rejecting fetch as network", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
      });
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.fault).toBe("network");
    });

    it("classifies error code 9109 as permission even at a 200 status", async () => {
      // Cloudflare can report a permission failure at HTTP 200 with `success: false`,
      // the same "classic mistake" trap this whole client exists to avoid — but the
      // classifier used to decide fault from `status` alone, so a status this switch
      // doesn't recognise (200) fell through to the `cloudflare` catch-all and got
      // retried three times before reporting a useless "unexpected error" message.
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: false,
            errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
          }),
          { status: 200 },
        ),
      );
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.fault).toBe("permission");
      // permission is not retryable — one call, not three.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("classifies a 400 with a validation code as client", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: false, errors: [{ code: 1002, message: "invalid page value" }] }),
          { status: 400 },
        ),
      );
      const error = (await client({ fetch: fetchMock })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.fault).toBe("client");
    });
  });

  describe("retry", () => {
    it("retries a 429, honouring Retry-After when present", async () => {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return jsonResponse(
            envelope({ success: false, errors: [{ code: 10013, message: "rate limited" }] }),
            { status: 429, headers: { "retry-after": "2" } },
          );
        }
        return jsonResponse(
          envelope({
            success: true,
            result: [{ id: "z1", name: "example.com" }],
            result_info: { page: 1, per_page: 50, count: 1, total_count: 1 },
          }),
        );
      });
      const sleep = fakeSleep();
      const zones = await client({ fetch: fetchMock, sleep, now: () => 0 }).listZones();
      expect(zones).toEqual([{ id: "z1", name: "example.com" }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it("retries a 5xx with backoff", async () => {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("bad gateway", { status: 502 });
        return jsonResponse(
          envelope({
            success: true,
            result: [{ id: "z1", name: "example.com" }],
            result_info: { page: 1, per_page: 50, count: 1, total_count: 1 },
          }),
        );
      });
      const sleep = fakeSleep();
      const zones = await client({ fetch: fetchMock, sleep }).listZones();
      expect(zones).toEqual([{ id: "z1", name: "example.com" }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("never retries a 401", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: false, errors: [{ code: 9109, message: "bad token" }] }), {
          status: 401,
        }),
      );
      await expect(
        client({ fetch: fetchMock, sleep: fakeSleep() }).listZones(),
      ).rejects.toMatchObject({ fault: "auth" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never retries a 403", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: false, errors: [{ code: 9109, message: "forbidden" }] }), {
          status: 403,
        }),
      );
      await expect(
        client({ fetch: fetchMock, sleep: fakeSleep() }).listZones(),
      ).rejects.toMatchObject({ fault: "permission" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries a rejecting fetch (network) the same as any other retryable fault", async () => {
      // Binds `RETRYABLE_FAULTS`'s `"network"` member to actual behaviour. Before this
      // test, "classifies a rejecting fetch as network" above asserted only the fault,
      // never the call count — the exact gap the plan warned about ("a test that only
      // checks the final error passes against no retry at all"). Measured: deleting
      // `"network"` from `RETRYABLE_FAULTS`, or deleting the retry path outright, both
      // left the full suite green until this test existed.
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
        return jsonResponse(
          envelope({
            success: true,
            result: [{ id: "z1", name: "example.com" }],
            result_info: { page: 1, per_page: 50, count: 1, total_count: 1 },
          }),
        );
      });
      const sleep = fakeSleep();
      const zones = await client({ fetch: fetchMock, sleep }).listZones();
      expect(zones).toEqual([{ id: "z1", name: "example.com" }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("bounds retries and raises the last fault after exhaustion", async () => {
      const fetchMock = vi.fn(async () => new Response("bad gateway", { status: 502 }));
      const sleep = fakeSleep();
      const error = (await client({ fetch: fetchMock, sleep })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error.fault).toBe("cloudflare");
      // Bounded to exactly 3 attempts (the original call plus two retries), not an
      // unbounded hammer against a wedged API. Asserting the exact count is what makes
      // this test binding — an implementation with no retry at all would also end up
      // throwing "cloudflare", just after a single call.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("secrets", () => {
    it("never puts the token in a thrown error's message or stack", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error(`connection refused while using ${TOKEN}`);
      });
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .listZones()
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error.message).not.toContain(TOKEN);
      expect(error.stack ?? "").not.toContain(TOKEN);
    });
  });

  describe("pagination", () => {
    it("follows result_info across pages and returns every zone", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const page = url.searchParams.get("page");
        if (page === "1") {
          return jsonResponse(
            envelope({
              success: true,
              result: [
                { id: "z1", name: "one.example" },
                { id: "z2", name: "two.example" },
              ],
              result_info: { page: 1, per_page: 2, count: 2, total_count: 3 },
            }),
          );
        }
        if (page === "2") {
          return jsonResponse(
            envelope({
              success: true,
              result: [{ id: "z3", name: "three.example" }],
              result_info: { page: 2, per_page: 2, count: 1, total_count: 3 },
            }),
          );
        }
        throw new Error(`unexpected page ${page}`);
      });
      const zones = await client({ fetch: fetchMock }).listZones();
      expect(zones).toEqual([
        { id: "z1", name: "one.example" },
        { id: "z2", name: "two.example" },
        { id: "z3", name: "three.example" },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("caps pagination and raises a clear error, rather than looping forever, when the API ignores ?page=", async () => {
      // Always answers `page: 1` regardless of the `?page=` query parameter — the
      // measured trigger: an API that ignores pagination convinces a loop comparing
      // against the RESPONSE's page number that it never advances, and it does not, at
      // 203 requests and climbing. `per_page: 2` and a huge `total_count` mean the
      // "have we fetched everything" check never trips either.
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: [
              { id: "z1", name: "one.example" },
              { id: "z2", name: "two.example" },
            ],
            result_info: { page: 1, per_page: 2, count: 2, total_count: 1_000_000 },
          }),
        ),
      );
      const error = await client({ fetch: fetchMock })
        .listZones()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
      // A clear, bounded failure — not a partial list quietly handed back as if it were
      // complete, which would let an admin pick a zone a later sub-phase can't find.
      expect(fetchMock).toHaveBeenCalledTimes(50);
    });
  });

  describe("createTunnel", () => {
    it("posts config_src: cloudflare on the request body", async () => {
      // The binding assertion: on the REQUEST body, not the response — nothing in the
      // response handling would notice if `config_src` were dropped from what we send,
      // which is exactly why this test inspects the outgoing fetch call.
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        expect(sent).toEqual({ name: "homestead", config_src: "cloudflare" });
        return jsonResponse(
          envelope({ success: true, result: { id: "tunnel-1", name: "homestead" } }),
        );
      });
      const tunnel = await client({ fetch: fetchMock }).createTunnel("homestead");
      expect(tunnel).toEqual({ id: "tunnel-1", name: "homestead" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends the request to the account-scoped cfd_tunnel endpoint", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel`,
        );
        return jsonResponse(
          envelope({ success: true, result: { id: "tunnel-1", name: "homestead" } }),
        );
      });
      await client({ fetch: fetchMock }).createTunnel("homestead");
    });

    it("raises a CloudflareError classified the normal way on failure", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: false, errors: [{ code: 9109, message: "forbidden" }] }), {
          status: 403,
        }),
      );
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .createTunnel("homestead")
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error.fault).toBe("permission");
    });
  });

  describe("listTunnels", () => {
    it("surfaces a deleted tunnel's deletedAt rather than excluding it from the list", async () => {
      // Choosing to surface rather than exclude: the interface's `deletedAt` field would
      // be pointless — always null — if this method filtered deleted tunnels out itself.
      // A caller that wants only live tunnels filters on `deletedAt`; a picker showing a
      // deleted tunnel as if it were live is the confusing bug this test guards against
      // in the other direction (surfacing it means a caller CAN grey it out).
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: [
              { id: "t1", name: "live", deleted_at: null },
              { id: "t2", name: "gone", deleted_at: "2024-01-02T03:04:05Z" },
            ],
          }),
        ),
      );
      const tunnels = await client({ fetch: fetchMock }).listTunnels();
      expect(tunnels).toEqual([
        { id: "t1", name: "live", deletedAt: null },
        { id: "t2", name: "gone", deletedAt: Date.parse("2024-01-02T03:04:05Z") },
      ]);
    });

    it("tolerates a tunnel with no deleted_at field at all", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: true, result: [{ id: "t1", name: "live" }] })),
      );
      const tunnels = await client({ fetch: fetchMock }).listTunnels();
      expect(tunnels).toEqual([{ id: "t1", name: "live", deletedAt: null }]);
    });
  });

  describe("tunnelToken", () => {
    it("returns the token when the result is a bare string", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: true, result: "the-tunnel-token" })),
      );
      const token = await client({ fetch: fetchMock }).tunnelToken("tunnel-1");
      expect(token).toBe("the-tunnel-token");
    });

    it("returns the token when the result is wrapped in an object", async () => {
      // Two plausible shapes were never verified against a real account; both are
      // accepted rather than guessing one and failing on the other.
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: true, result: { token: "the-tunnel-token" } })),
      );
      const token = await client({ fetch: fetchMock }).tunnelToken("tunnel-1");
      expect(token).toBe("the-tunnel-token");
    });

    it("raises rather than returning an empty string when the token is empty", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(envelope({ success: true, result: "" })));
      const error = await client({ fetch: fetchMock })
        .tunnelToken("tunnel-1")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).message).not.toBe("");
    });

    it("raises rather than returning an empty string when the token field is missing", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: true, result: { notToken: "oops" } })),
      );
      const error = await client({ fetch: fetchMock })
        .tunnelToken("tunnel-1")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
    });

    it("never puts the tunnel token in a thrown error's message", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(envelope({ success: true, result: "" })));
      const error = (await client({ fetch: fetchMock })
        .tunnelToken("tunnel-1")
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.message).not.toContain("the-tunnel-token");
    });
  });

  describe("deleteTunnel", () => {
    it("succeeds on a live tunnel", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: true, result: { id: "tunnel-1" } })),
      );
      await expect(client({ fetch: fetchMock }).deleteTunnel("tunnel-1")).resolves.toBeUndefined();
    });

    it("is idempotent: calling it twice on an already-deleted tunnel is not an error", async () => {
      // Real Cloudflare tunnels are soft-deleted, so a repeat delete is expected to
      // report the same success envelope rather than a fresh error — the rollback path
      // (2B's step-sequence runner) depends on being able to call this twice safely.
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: true, result: { id: "tunnel-1" } })),
      );
      const c = client({ fetch: fetchMock });
      await expect(c.deleteTunnel("tunnel-1")).resolves.toBeUndefined();
      await expect(c.deleteTunnel("tunnel-1")).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("sends the DELETE method to the account-scoped tunnel endpoint", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE");
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/tunnel-1`,
        );
        return jsonResponse(envelope({ success: true, result: { id: "tunnel-1" } }));
      });
      await client({ fetch: fetchMock }).deleteTunnel("tunnel-1");
    });

    it("raises a CloudflareError classified the normal way on a genuine failure", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: false, errors: [{ code: 9109, message: "nope" }] }), {
          status: 403,
        }),
      );
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .deleteTunnel("tunnel-1")
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error.fault).toBe("permission");
    });
  });

  describe("getTunnelConfig", () => {
    it("returns the ingress array from result.config.ingress", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: {
              tunnel_id: "tunnel-1",
              config: {
                ingress: [
                  { hostname: "a.example.com", service: "http://localhost:8080" },
                  { service: "http_status:404" },
                ],
              },
            },
          }),
        ),
      );
      const { ingress } = await client({ fetch: fetchMock }).getTunnelConfig("tunnel-1");
      expect(ingress).toEqual([
        { hostname: "a.example.com", service: "http://localhost:8080" },
        { service: "http_status:404" },
      ]);
    });

    it("sends the request to the account-scoped configurations endpoint", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/tunnel-1/configurations`,
        );
        return jsonResponse(envelope({ success: true, result: { config: { ingress: [] } } }));
      });
      await client({ fetch: fetchMock }).getTunnelConfig("tunnel-1");
    });

    it("raises when the response does not carry a usable config.ingress", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: true, result: { config: {} } })),
      );
      const error = await client({ fetch: fetchMock })
        .getTunnelConfig("tunnel-1")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
    });

    it("preserves fields this client does not model, on both the config and a rule (F2)", async () => {
      // Measured defect: `ingressRuleSchema`/`tunnelConfigResultSchema` used to be plain
      // `z.object`, which drops any key it doesn't declare on parse. `path` and
      // `originRequest` are real, common ingress fields (a self-signed origin, or one
      // hostname serving several paths) and `warp-routing` is a real tunnel-level field —
      // none of them are read by this client, and all three used to vanish the instant
      // `getTunnelConfig` parsed the response, long before any caller got a chance to
      // round-trip them back through `putTunnelConfig`.
      const rawConfig = {
        ingress: [
          {
            hostname: "wiki.example.com",
            path: "/docs/.*",
            service: "http://localhost:3000",
            originRequest: { noTLSVerify: true, httpHostHeader: "wiki.internal" },
          },
          { service: "http_status:404" },
        ],
        "warp-routing": { enabled: true },
        originRequest: { connectTimeout: 30 },
        // A field neither this schema NOR Cloudflare's documented shape names — proving
        // this survives a field the schema has literally never heard of, not merely one
        // it happens to already know about.
        aFieldThisClientHasNeverHeardOf: "still here",
      };
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: true, result: { config: rawConfig } })),
      );
      const config = await client({ fetch: fetchMock }).getTunnelConfig("tunnel-1");
      expect(config).toEqual(rawConfig);
    });
  });

  describe("putTunnelConfig", () => {
    it("sends the ingress array under config.ingress on the request body", async () => {
      const ingress = [{ hostname: "a.example.com", service: "http://localhost:8080" }];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("PUT");
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/tunnel-1/configurations`,
        );
        expect(JSON.parse(String(init?.body))).toEqual({ config: { ingress } });
        return jsonResponse(envelope({ success: true, result: { config: { ingress } } }));
      });
      await expect(
        client({ fetch: fetchMock }).putTunnelConfig("tunnel-1", { ingress }),
      ).resolves.toBeUndefined();
    });

    it("sends whatever config object it is given verbatim, not just ingress (F2)", async () => {
      // The other half of the round trip: even if `getTunnelConfig` preserved everything,
      // a `putTunnelConfig` that reconstructs `{ ingress: config.ingress }` internally
      // would still drop it on the write. This sends a config carrying fields this client
      // has no opinion on and asserts the exact request body — the binding assertion,
      // same posture `createDnsRecord`'s `proxied: true` test takes.
      const config = {
        ingress: [{ service: "http_status:404" }],
        "warp-routing": { enabled: true },
        originRequest: { connectTimeout: 30 },
      };
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({ config });
        return jsonResponse(envelope({ success: true, result: { config } }));
      });
      await client({ fetch: fetchMock }).putTunnelConfig("tunnel-1", config);
    });

    it("raises a CloudflareError classified the normal way on failure", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: false, errors: [{ code: 9109, message: "nope" }] }), {
          status: 403,
        }),
      );
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .putTunnelConfig("tunnel-1", { ingress: [] })
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error.fault).toBe("permission");
    });
  });

  describe("getTunnelConfig → putTunnelConfig round trip (F2)", () => {
    it("a caller that changes only ingress sends every other field back untouched", async () => {
      // This is the test the finding asked for: fails if ANY field is dropped along the
      // way, including one the schema was never told about — end to end, through both
      // methods, the way `expose.ts`/`deprovision.ts` actually use this client.
      const rawConfig = {
        ingress: [
          { hostname: "wiki.example.com", path: "/docs/.*", service: "http://localhost:3000" },
          { service: "http_status:404" },
        ],
        "warp-routing": { enabled: true },
        originRequest: { connectTimeout: 30 },
        somethingThisClientDoesNotKnowAbout: 42,
      };
      let sentBody: unknown;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") sentBody = JSON.parse(String(init.body));
        return jsonResponse(envelope({ success: true, result: { config: rawConfig } }));
      });
      const c = client({ fetch: fetchMock });

      const config = await c.getTunnelConfig("tunnel-1");
      const updated = [...config.ingress, { hostname: "new.example.com", service: "http://x:1" }];
      await c.putTunnelConfig("tunnel-1", { ...config, ingress: updated });

      expect(sentBody).toEqual({ config: { ...rawConfig, ingress: updated } });
    });
  });

  describe("createDnsRecord", () => {
    it("sends proxied: true and type: CNAME on the request body", async () => {
      // The binding assertion: on the REQUEST body. An unproxied record points at a
      // hostname that never resolves publicly, and nothing else in the system notices.
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        expect(sent).toEqual({
          type: "CNAME",
          name: "app.example.com",
          content: "tunnel-1.cfargotunnel.com",
          proxied: true,
        });
        return jsonResponse(envelope({ success: true, result: { id: "dns-1" } }));
      });
      const record = await client({ fetch: fetchMock }).createDnsRecord("zone-1", {
        name: "app.example.com",
        content: "tunnel-1.cfargotunnel.com",
      });
      expect(record).toEqual({ id: "dns-1" });
    });

    it("sends the request to the zone-scoped dns_records endpoint", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("https://api.cloudflare.com/client/v4/zones/zone-1/dns_records");
        return jsonResponse(envelope({ success: true, result: { id: "dns-1" } }));
      });
      await client({ fetch: fetchMock }).createDnsRecord("zone-1", {
        name: "app.example.com",
        content: "tunnel-1.cfargotunnel.com",
      });
    });
  });

  describe("findDnsRecord", () => {
    const TUNNEL_CONTENT = "tunnel-1.cfargotunnel.com";

    it("returns the id of a matching proxied CNAME to the tunnel", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/client/v4/zones/zone-1/dns_records");
        expect(url.searchParams.get("name")).toBe("app.example.com");
        return jsonResponse(
          envelope({
            success: true,
            result: [
              {
                id: "dns-1",
                name: "app.example.com",
                type: "CNAME",
                content: TUNNEL_CONTENT,
                proxied: true,
              },
            ],
          }),
        );
      });
      const record = await client({ fetch: fetchMock }).findDnsRecord(
        "zone-1",
        "app.example.com",
        TUNNEL_CONTENT,
      );
      expect(record).toEqual({ id: "dns-1" });
    });

    it("returns null rather than throwing when no record matches", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(envelope({ success: true, result: [] })));
      const record = await client({ fetch: fetchMock }).findDnsRecord(
        "zone-1",
        "nowhere.example.com",
        TUNNEL_CONTENT,
      );
      expect(record).toBeNull();
    });

    it("does not adopt an unproxied A record at the same hostname (F4)", async () => {
      // Measured defect: `?name=` alone matched this record, and the old code adopted it
      // outright — no CNAME to the tunnel was ever created, and the hostname kept
      // resolving to a LAN address no external client could reach.
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: [
              {
                id: "dns-a-record",
                name: "app.example.com",
                type: "A",
                content: "192.168.1.50",
                proxied: false,
              },
            ],
          }),
        ),
      );
      const record = await client({ fetch: fetchMock }).findDnsRecord(
        "zone-1",
        "app.example.com",
        TUNNEL_CONTENT,
      );
      expect(record).toBeNull();
    });

    it("does not adopt a proxied CNAME pointing at a different target", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: [
              {
                id: "dns-other",
                name: "app.example.com",
                type: "CNAME",
                content: "someone-elses-tunnel.cfargotunnel.com",
                proxied: true,
              },
            ],
          }),
        ),
      );
      const record = await client({ fetch: fetchMock }).findDnsRecord(
        "zone-1",
        "app.example.com",
        TUNNEL_CONTENT,
      );
      expect(record).toBeNull();
    });
  });

  describe("deleteDnsRecord", () => {
    it("succeeds on an existing record", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE");
        expect(String(input)).toBe(
          "https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/dns-1",
        );
        return jsonResponse(envelope({ success: true, result: { id: "dns-1" } }));
      });
      await expect(
        client({ fetch: fetchMock }).deleteDnsRecord("zone-1", "dns-1"),
      ).resolves.toBeUndefined();
    });

    it("is idempotent: a 404 on an already-deleted record is not an error — rollback calls this", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: false, errors: [{ code: 81044, message: "Record does not exist" }] }),
          { status: 404 },
        ),
      );
      await expect(
        client({ fetch: fetchMock }).deleteDnsRecord("zone-1", "dns-1"),
      ).resolves.toBeUndefined();
    });

    it("still raises on a genuine, non-404 failure", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: false, errors: [{ code: 9109, message: "forbidden" }] }), {
          status: 403,
        }),
      );
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .deleteDnsRecord("zone-1", "dns-1")
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error.fault).toBe("permission");
    });
  });

  describe("createAccessApp", () => {
    it("sends type: self_hosted and the policy ids on the request body", async () => {
      // The binding assertion: on the REQUEST body. A policy that is not `non_identity`
      // (asserted below, on createMonitorPolicy) demands a human login, which the monitor
      // probe cannot give — and a wrong `type` here would leave the app unreachable in a
      // way that reads as "every probe redirects", not as an obvious misconfiguration.
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        expect(sent).toEqual({
          name: "app",
          domain: "app.example.com",
          type: "self_hosted",
          policies: [{ id: "policy-human" }, { id: "policy-monitor" }],
        });
        return jsonResponse(envelope({ success: true, result: { id: "app-1", aud: "aud-1" } }));
      });
      const app = await client({ fetch: fetchMock }).createAccessApp({
        domain: "app.example.com",
        name: "app",
        policyIds: ["policy-human", "policy-monitor"],
      });
      expect(app).toEqual({ id: "app-1", aud: "aud-1" });
    });
  });

  describe("findAccessApp", () => {
    it("returns the id and aud of the app matching the domain", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps`,
        );
        return jsonResponse(
          envelope({
            success: true,
            result: [
              { id: "app-1", aud: "aud-1", domain: "other.example.com" },
              { id: "app-2", aud: "aud-2", domain: "app.example.com" },
            ],
          }),
        );
      });
      const app = await client({ fetch: fetchMock }).findAccessApp("app.example.com");
      expect(app).toEqual({ id: "app-2", aud: "aud-2" });
    });

    it("returns null rather than throwing when no app matches the domain", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(envelope({ success: true, result: [] })));
      const app = await client({ fetch: fetchMock }).findAccessApp("app.example.com");
      expect(app).toBeNull();
    });
  });

  describe("deleteAccessApp", () => {
    it("succeeds on an existing app", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE");
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps/app-1`,
        );
        return jsonResponse(envelope({ success: true, result: { id: "app-1" } }));
      });
      await expect(client({ fetch: fetchMock }).deleteAccessApp("app-1")).resolves.toBeUndefined();
    });

    it("is idempotent: a 404 on an already-deleted app is not an error — rollback calls this", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: false, errors: [{ code: 12112, message: "not found" }] }),
          {
            status: 404,
          },
        ),
      );
      await expect(client({ fetch: fetchMock }).deleteAccessApp("app-1")).resolves.toBeUndefined();
    });
  });

  describe("createServiceToken", () => {
    it("returns the id, clientId, clientSecret and expiresAt when the secret is under client_secret", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: {
              id: "token-1",
              client_id: "client-1",
              client_secret: "shh-secret",
              expires_at: "2027-09-12T00:00:00Z",
            },
          }),
        ),
      );
      const token = await client({ fetch: fetchMock }).createServiceToken("Homestead Monitor");
      expect(token).toEqual({
        id: "token-1",
        clientId: "client-1",
        clientSecret: "shh-secret",
        expiresAt: Date.parse("2027-09-12T00:00:00Z"),
      });
    });

    it("accepts the secret under an alternate `secret` field — the field name is unverified", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: {
              id: "token-1",
              client_id: "client-1",
              secret: "shh-secret",
              expires_at: null,
            },
          }),
        ),
      );
      const token = await client({ fetch: fetchMock }).createServiceToken("Homestead Monitor");
      expect(token).toEqual({
        id: "token-1",
        clientId: "client-1",
        clientSecret: "shh-secret",
        expiresAt: null,
      });
    });

    it("raises rather than returning an empty string when the secret is missing", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: { id: "token-1", client_id: "client-1", expires_at: null },
          }),
        ),
      );
      const error = await client({ fetch: fetchMock })
        .createServiceToken("Homestead Monitor")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).message).not.toBe("");
    });

    it("raises rather than returning an empty string when the secret is present but empty", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: {
              id: "token-1",
              client_id: "client-1",
              client_secret: "",
              expires_at: null,
            },
          }),
        ),
      );
      const error = await client({ fetch: fetchMock })
        .createServiceToken("Homestead Monitor")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
    });

    it("never puts the secret in a thrown error's message", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("connection refused");
      });
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .createServiceToken("Homestead Monitor")
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error.message).not.toContain("shh-secret");
    });
  });

  describe("rotateServiceToken", () => {
    it("posts to the rotate endpoint and returns the new secret", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/service_tokens/token-1/rotate`,
        );
        return jsonResponse(
          envelope({
            success: true,
            result: {
              client_id: "client-1",
              client_secret: "new-secret",
              expires_at: "2027-09-12T00:00:00Z",
            },
          }),
        );
      });
      const rotated = await client({ fetch: fetchMock }).rotateServiceToken("token-1");
      expect(rotated).toEqual({
        clientId: "client-1",
        clientSecret: "new-secret",
        expiresAt: Date.parse("2027-09-12T00:00:00Z"),
      });
    });

    it("raises rather than returning an empty string when the rotated secret is missing", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: true, result: { client_id: "client-1", expires_at: null } }),
        ),
      );
      const error = await client({ fetch: fetchMock })
        .rotateServiceToken("token-1")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
    });
  });

  describe("listServiceTokens", () => {
    it("returns every token with its parsed expiry", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: [
              { id: "token-1", name: "Homestead Monitor", expires_at: "2027-09-12T00:00:00Z" },
              { id: "token-2", name: "other", expires_at: null },
            ],
          }),
        ),
      );
      const tokens = await client({ fetch: fetchMock }).listServiceTokens();
      expect(tokens).toEqual([
        { id: "token-1", name: "Homestead Monitor", expiresAt: Date.parse("2027-09-12T00:00:00Z") },
        { id: "token-2", name: "other", expiresAt: null },
      ]);
    });

    it("never puts a secret in the result — the list endpoint does not return one", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({
            success: true,
            result: [{ id: "token-1", name: "Homestead Monitor", expires_at: null }],
          }),
        ),
      );
      const tokens = await client({ fetch: fetchMock }).listServiceTokens();
      expect(tokens[0]).not.toHaveProperty("clientSecret");
    });
  });

  describe("deleteServiceToken", () => {
    // Not in the plan's original interface list — added because `ensureMonitorAccess`
    // (Task 2) needs to compensate a service token whose paired policy creation failed,
    // the same "compensate inline rather than leave an orphan" idiom `provision-tunnel.ts`
    // already uses for its `register-app` step. Same shape as the other delete methods
    // in this batch, so it costs nothing extra to reuse the one request path for it too.
    it("succeeds on an existing token", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("DELETE");
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/service_tokens/token-1`,
        );
        return jsonResponse(envelope({ success: true, result: { id: "token-1" } }));
      });
      await expect(
        client({ fetch: fetchMock }).deleteServiceToken("token-1"),
      ).resolves.toBeUndefined();
    });

    it("is idempotent: a 404 on an already-deleted token is not an error", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: false, errors: [{ code: 12112, message: "not found" }] }),
          {
            status: 404,
          },
        ),
      );
      await expect(
        client({ fetch: fetchMock }).deleteServiceToken("token-1"),
      ).resolves.toBeUndefined();
    });
  });

  describe("createMonitorPolicy", () => {
    it("sends decision: non_identity and the token in the include list on the request body", async () => {
      // The binding assertion: on the REQUEST body. Anything other than `non_identity`
      // demands a human login, which the monitor probe cannot give — and the failure mode
      // is every external probe getting a redirect, not an obvious misconfiguration.
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        expect(sent).toEqual({
          name: "Homestead Monitor",
          decision: "non_identity",
          include: [{ service_token: { token_id: "token-1" } }],
        });
        return jsonResponse(envelope({ success: true, result: { id: "policy-1" } }));
      });
      const policy = await client({ fetch: fetchMock }).createMonitorPolicy(
        "Homestead Monitor",
        "token-1",
      );
      expect(policy).toEqual({ id: "policy-1" });
    });
  });

  describe("createEmailPolicy", () => {
    it("sends decision: allow and one include per email on the request body", async () => {
      // The binding assertion Phase 3A's brief calls out by name: `non_identity` here
      // would silently admit the monitor's service token where a human is meant to log
      // in, and nothing else in the system would notice.
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        expect(sent).toEqual({
          name: "Homestead Access",
          decision: "allow",
          include: [{ email: { email: "a@example.com" } }, { email: { email: "b@example.com" } }],
        });
        return jsonResponse(envelope({ success: true, result: { id: "policy-human" } }));
      });
      const policy = await client({ fetch: fetchMock }).createEmailPolicy("Homestead Access", [
        "a@example.com",
        "b@example.com",
      ]);
      expect(policy).toEqual({ id: "policy-human" });
    });

    it("raises before making a network call when the email list is empty", async () => {
      const fetchMock = vi.fn();
      const error = await client({ fetch: fetchMock })
        .createEmailPolicy("Homestead Access", [])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).fault).toBe("client");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("updateEmailPolicy", () => {
    it("PUTs the full desired email list, not a delta", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("PUT");
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/policies/policy-human`,
        );
        const sent = JSON.parse(String(init?.body));
        expect(sent).toEqual({
          name: "Homestead Access",
          decision: "allow",
          include: [{ email: { email: "a@example.com" } }, { email: { email: "c@example.com" } }],
        });
        return jsonResponse(envelope({ success: true, result: { id: "policy-human" } }));
      });
      await expect(
        client({ fetch: fetchMock }).updateEmailPolicy("policy-human", "Homestead Access", [
          "a@example.com",
          "c@example.com",
        ]),
      ).resolves.toBeUndefined();
    });

    it("raises before making a network call when the email list is empty", async () => {
      const fetchMock = vi.fn();
      const error = await client({ fetch: fetchMock })
        .updateEmailPolicy("policy-human", "Homestead Access", [])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).fault).toBe("client");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("getPolicy", () => {
    it("returns the id and name of an existing policy", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/policies/policy-human`,
        );
        return jsonResponse(
          envelope({ success: true, result: { id: "policy-human", name: "Homestead Access" } }),
        );
      });
      const policy = await client({ fetch: fetchMock }).getPolicy("policy-human");
      expect(policy).toEqual({ id: "policy-human", name: "Homestead Access" });
    });

    it("returns null rather than throwing for a missing policy", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(
          envelope({ success: false, errors: [{ code: 12112, message: "not found" }] }),
          { status: 404 },
        ),
      );
      const policy = await client({ fetch: fetchMock }).getPolicy("policy-human");
      expect(policy).toBeNull();
    });

    it("still raises on a genuine, non-404 failure", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(envelope({ success: false, errors: [{ code: 9109, message: "forbidden" }] }), {
          status: 403,
        }),
      );
      const error = (await client({ fetch: fetchMock, sleep: fakeSleep() })
        .getPolicy("policy-human")
        .catch((e: unknown) => e)) as CloudflareError;
      expect(error).toBeInstanceOf(CloudflareError);
      expect(error.fault).toBe("permission");
    });
  });
});
