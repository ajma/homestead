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

  it("passes an abort signal derived from the probe timeout", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    await createHttpRunners({ fetch: impl }).internal.run(probe({ timeoutMs: 1234 }), ctx);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not read an unbounded body", async () => {
    // A probe must not pull a gigabyte off a misconfigured target.
    const huge = "x".repeat(200_000);
    const { impl } = fakeFetch(() => new Response(huge, { status: 200 }));
    const result = await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx);
    expect(JSON.stringify(result.detail).length).toBeLessThan(3000);
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

  it("never leaks the service token into the detail payload", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 500 }));
    const result = await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
      external(),
      ctx,
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
