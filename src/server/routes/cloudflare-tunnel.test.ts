import { TunnelStore } from "@server/cloudflare/tunnel-store";
import { jobs } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const TOKEN = "cfat_super-secret-token-value";
const ACCOUNT_ID = "acct-123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A `fetch` that always answers a successful `GET /zones` with one fixed zone — enough
 * to pass `PUT /api/cloudflare/credentials`'s verification step. */
function verifyingFetch(): typeof fetch {
  return (async () =>
    jsonResponse({
      success: true,
      errors: [],
      result: [{ id: "z1", name: "example.com" }],
      result_info: { page: 1, per_page: 50, count: 1, total_count: 1 },
    })) as unknown as typeof fetch;
}

/**
 * A minimal in-memory simulator of the four tunnel endpoints, keyed by URL path and
 * method — enough to drive the real `CloudflareClient` through a real (fake) HTTP
 * exchange without ever leaving the process. No test in this file makes a real network
 * call.
 */
function tunnelFetch(accountId: string): typeof fetch {
  const tunnels: Array<{ id: string; name: string; deleted_at: string | null }> = [];
  let nextId = 1;
  const prefix = `/client/v4/accounts/${accountId}`;

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const suffix = url.pathname.slice(prefix.length);
    const envelope = (result: unknown) => jsonResponse({ success: true, errors: [], result });

    if (suffix === "/cfd_tunnel" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
      const id = `tunnel-${nextId++}`;
      tunnels.push({ id, name: body.name, deleted_at: null });
      return envelope({ id, name: body.name, deleted_at: null });
    }
    if (suffix === "/cfd_tunnel" && method === "GET") {
      return envelope(tunnels);
    }
    const tokenMatch = suffix.match(/^\/cfd_tunnel\/([^/]+)\/token$/);
    if (tokenMatch && method === "GET") {
      return envelope(`test-tunnel-token-${tokenMatch[1]}`);
    }
    const deleteMatch = suffix.match(/^\/cfd_tunnel\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
      const tunnel = tunnels.find((t) => t.id === deleteMatch[1]);
      if (tunnel) tunnel.deleted_at = new Date().toISOString();
      return envelope(null);
    }
    throw new Error(`cloudflare-tunnel.test.ts: unexpected fetch ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;
}

async function withStoredCredentials() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.fetch = verifyingFetch();
  const put = await app.inject({
    method: "PUT",
    url: "/api/cloudflare/credentials",
    headers: { cookie },
    payload: { token: TOKEN, accountId: ACCOUNT_ID },
  });
  expect(put.statusCode).toBe(200);
  return { app, cookie };
}

describe("POST /api/cloudflare/tunnel", () => {
  it("requires an admin capability — a viewer gets 403", async () => {
    const { app, cookie: adminCookie } = await withStoredCredentials();
    const { cookie: viewerCookie } = await createViewer(app, adminCookie);
    app.deps.fetch = tunnelFetch(ACCOUNT_ID);

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/tunnel",
      headers: { cookie: viewerCookie },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("refuses without stored Cloudflare credentials", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_configured");
    await app.close();
  });

  it("refuses when a tunnel is already provisioned, and never calls Cloudflare to create one", async () => {
    const { app, cookie } = await withStoredCredentials();
    const tunnelStore = new TunnelStore(app.deps.db, app.deps.secrets);
    await tunnelStore.set(
      { tunnelId: "existing-tunnel", name: "homestead", appId: null, createdAt: 1_700_000_000 },
      "existing-token",
    );
    // A fetch that would fail the test loudly if the route reached Cloudflare at all.
    app.deps.fetch = (async () => {
      throw new Error("must not call Cloudflare when a tunnel already exists");
    }) as unknown as typeof fetch;

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("tunnel_exists");
    await app.close();
  });

  it("provisions end to end: 202 with a jobId, and the job succeeds with the tunnel recorded", async () => {
    const { app, cookie } = await withStoredCredentials();
    app.deps.fetch = tunnelFetch(ACCOUNT_ID);

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    const [jobRow] = await app.deps.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow?.status).toBe("succeeded");
    expect(jobRow?.appId).toBeNull();
    // The token must never appear in the persisted job output — that is what a user reads
    // and what the audit trail keeps.
    expect(jobRow?.output ?? "").not.toContain("test-tunnel-token-");

    const tunnelStore = new TunnelStore(app.deps.db, app.deps.secrets);
    const record = await tunnelStore.get();
    expect(record?.name).toBe("homestead");
    expect(record?.appId).toBeTruthy();

    await app.close();
  });
});
