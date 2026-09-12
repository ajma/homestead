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
  });
});
