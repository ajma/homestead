import { createHttpRunners } from "@server/monitoring/http-runner";
import type { ProbeContext, ProbeRow } from "@server/monitoring/types";
import { describe, expect, it } from "vitest";

const ctx = {} as ProbeContext;
const probe = (over: Partial<ProbeRow> = {}): ProbeRow =>
  ({
    id: "p1",
    appId: "a1",
    kind: "http_internal",
    target: "http://nas.local:8096",
    expectedStatusPattern: "2xx,3xx",
    timeoutMs: 5000,
    insecureTls: false,
    followRedirects: false,
    ...over,
  }) as ProbeRow;

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("http_internal", () => {
  it("is up for an accepted status", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 204 }));
    const result = await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx);
    expect(result.status).toBe("up");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is down with an app fault for a rejected status", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 500 }));
    expect(await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)).toMatchObject({
      status: "down",
      faultClass: "app",
    });
  });

  it("never follows redirects", async () => {
    // The whole reason this phase exists. A 302 must be judged, not chased.
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 302 }));
    await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx);
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("is down with a network fault on a connection failure", async () => {
    const impl = (async () => {
      throw new Error("connect ECONNREFUSED 192.168.1.10:8096");
    }) as unknown as typeof fetch;
    expect(await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)).toMatchObject({
      status: "down",
      faultClass: "network",
    });
  });

  it("is down with a config fault when the host does not resolve", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND nas.local");
    }) as unknown as typeof fetch;
    expect(await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)).toMatchObject({
      status: "down",
      faultClass: "config",
    });
  });

  it("is down with a config fault when the target is missing or unparseable", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const runners = createHttpRunners({ fetch: impl });
    expect(await runners.internal.run(probe({ target: null }), ctx)).toMatchObject({
      status: "down",
      faultClass: "config",
    });
    expect(await runners.internal.run(probe({ target: "not a url" }), ctx)).toMatchObject({
      status: "down",
      faultClass: "config",
    });
    // Nothing was requested for either.
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-http scheme without making the request", async () => {
    // The API rejects these when the user types one, but this is the code that performs
    // the fetch, and a row can reach it by other routes. Measured before this check:
    // `file:///etc/passwd` was passed to fetch.
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const runners = createHttpRunners({ fetch: impl });
    for (const target of ["file:///etc/passwd", "ftp://x/y", "data:text/plain,hi"]) {
      const result = await runners.internal.run(probe({ target }), ctx);
      expect(result, target).toMatchObject({ status: "down", faultClass: "config" });
    }
    expect(calls).toHaveLength(0);
  });

  it("passes an abort signal derived from the probe timeout", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    await createHttpRunners({ fetch: impl }).internal.run(probe({ timeoutMs: 1234 }), ctx);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not read a body at all on the internal path", async () => {
    // The internal runner classifies on the status line alone, so it never touches the
    // body. Asserting a size cap here would pass without any cap existing — the external
    // runner is the one that reads, and it has its own test below.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1000)));
        controller.close();
      },
    });
    const { impl } = fakeFetch(() => new Response(body, { status: 200 }));
    const result = await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx);
    expect(result.status).toBe("up");
    expect(JSON.stringify(result.detail)).not.toContain("xxx");
  });
});

describe("http_external", () => {
  const external = (over: Partial<ProbeRow> = {}) =>
    probe({ kind: "http_external", target: "https://jellyfin.example.com", ...over });

  const creds = async () => ({ clientId: "cid", clientSecret: "secret" });

  it("sends the Access service-token headers", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
      external(),
      ctx,
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["cf-access-client-id"]).toBe("cid");
    expect(headers["cf-access-client-secret"]).toBe("secret");
  });

  it("calls a redirect to the Access login page degraded/config, not up", async () => {
    // The failure this classification exists for: that login page returns 200, so a
    // monitor following redirects reports a dead origin as healthy forever.
    const { impl } = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" },
        }),
    );
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
        external(),
        ctx,
      ),
    ).toMatchObject({ status: "degraded", faultClass: "config" });
  });

  it.each([502, 503])("calls a Cloudflare %i down/network", async (status) => {
    const { impl } = fakeFetch(() => new Response(null, { status }));
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
        external(),
        ctx,
      ),
    ).toMatchObject({ status: "down", faultClass: "network" });
  });

  it("calls a Cloudflare 1033 body down/network even behind a 530", async () => {
    const { impl } = fakeFetch(
      () => new Response("Error 1033: Argo Tunnel error", { status: 530 }),
    );
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
        external(),
        ctx,
      ),
    ).toMatchObject({ status: "down", faultClass: "network" });
  });

  it("is degraded/config when no service token is configured", async () => {
    // Without credentials every request lands on the login page; saying "up" would be a lie
    // and saying "down" would blame the app.
    const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: async () => null }).external.run(
        external(),
        ctx,
      ),
    ).toMatchObject({ status: "degraded", faultClass: "config" });
  });

  it("is up for an accepted status from the origin", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
        external(),
        ctx,
      ),
    ).toMatchObject({ status: "up" });
  });

  it("stops reading a huge error body instead of buffering all of it", async () => {
    // This is the path that DOES read a body — looking for Cloudflare's 1033 under a
    // 5xx. `response.text()` would buffer the whole thing first, so an origin answering
    // a 5xx with a gigabyte would be pulled in full every 60 seconds.
    let produced = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        // Bound the stream: 200 chunks of 64KB (~12.8 MB), then close.
        // Without the fix, the test fails fast showing `produced` reached 200.
        // With the fix, `produced` stays around 1 and `cancelled` is true.
        if (produced >= 200) {
          controller.close();
        } else {
          controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const { impl } = fakeFetch(() => new Response(body, { status: 520 }));
    const result = await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
      external(),
      ctx,
    );
    expect(result.status).toBe("down");
    // A handful of 64KB chunks, not an unbounded stream, and the transfer was stopped.
    expect(produced).toBeLessThan(5);
    expect(cancelled).toBe(true);
  });

  it("never leaks the service token into the detail payload", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 500 }));
    const result = await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
      external(),
      ctx,
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
