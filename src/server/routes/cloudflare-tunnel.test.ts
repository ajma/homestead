import { TunnelStore } from "@server/cloudflare/tunnel-store";
import { auditLog, jobs } from "@server/db/schema";
import { TUNNEL_PROVISION_KIND } from "@server/routes/cloudflare-tunnel";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const TOKEN = "cfat_super-secret-token-value";
const ACCOUNT_ID = "acct-123";

/** Polls until `ready`, or fails loudly rather than hanging the suite — mirrors
 * `jobs.test.ts`'s own helper of the same name. Used below in place of a fixed
 * `setTimeout` wait wherever a test needs "the provision job has reached a specific
 * point", which a fixed sleep can only guess at under load; polling the actual row is
 * exact regardless of how much CPU this test happens to get scheduled. */
async function until<T>(attempt: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await attempt();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

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

/**
 * `tunnelFetch`, but the very first `POST /cfd_tunnel` (create-tunnel, step 1) waits on a
 * gate before answering. For proving the `AppBusyError` → 409 mapping, gating
 * `docker compose up` (step 5, via `FakeHost.gateCompose`) is too late: by then
 * `fetch-token` (step 2) has already called `TunnelStore.set()`, so a second POST arriving
 * in that window is refused by the route's own `existingTunnel` check before it ever
 * reaches `stepJobs.start` — the very case this file already covers ("refuses when a
 * tunnel is already provisioned"). Only a gate held during step 1, before that record
 * exists, forces a second concurrent POST through to the lock itself.
 */
function gatedTunnelFetch(accountId: string): { fetch: typeof fetch; release: () => void } {
  const inner = tunnelFetch(accountId);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = false;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    if (!gated && url.pathname.endsWith("/cfd_tunnel") && method === "POST") {
      gated = true;
      await gate;
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
  if (!release) throw new Error("release was not assigned synchronously");
  return { fetch: fetchFn, release };
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

  it("answers 409 tunnel_provision_running, not a 500, when a sequence is already in flight", async () => {
    // The route's own `TunnelStore.get()` idempotency check (above) only ever sees a
    // PREVIOUS attempt that already finished — it says nothing about one still holding
    // `StepJobRunner`'s lock right now. A second POST landing in that window used to reach
    // `stepJobs.start` uncaught and 500; this proves it now reads as "try again shortly".
    const { app, cookie } = await withStoredCredentials();
    const gated = gatedTunnelFetch(ACCOUNT_ID);
    app.deps.fetch = gated.fetch;

    const first = app.inject({
      method: "POST",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });
    // Waits for the job row itself, not a fixed sleep: the row is inserted right after
    // `stepJobs.start` acquires the lock, so its existence is the exact signal that the
    // first request has taken the lock the second one needs to collide with.
    await until(
      async () => {
        const rows = await app.deps.db
          .select()
          .from(jobs)
          .where(eq(jobs.kind, TUNNEL_PROVISION_KIND));
        return rows.length;
      },
      (count) => count > 0,
    );

    const second = await app.inject({
      method: "POST",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("tunnel_provision_running");

    gated.release();
    const firstRes = await first;
    expect(firstRes.statusCode).toBe(202);

    await app.close();
  });

  it("writes the audit row before the sequence runs, not once it completes (Important 2)", async () => {
    // Measured in the whole-branch review: `stepJobs.start` does not return until the
    // whole sequence — including any rollback — has finished, so an audit call placed
    // AFTER it (as this route used to do) produces zero audit rows for the entire run. A
    // crash mid-flight — after `create-tunnel` has already made a real Cloudflare tunnel
    // — used to leave no record that anyone ever asked. Gate `compose-up`, the last step,
    // so the sequence is provably still running while this test inspects the audit log.
    const { app, cookie } = await withStoredCredentials();
    app.deps.fetch = tunnelFetch(ACCOUNT_ID);
    app.deps.host.gateCompose();

    const post = app.inject({ method: "POST", url: "/api/cloudflare/tunnel", headers: { cookie } });
    await until(
      async () => {
        const [row] = await app.deps.db
          .select()
          .from(jobs)
          .where(eq(jobs.kind, TUNNEL_PROVISION_KIND));
        return row?.status ?? null;
      },
      (status) => status === "running",
    );

    const midFlight = await app.deps.db.select().from(auditLog);
    expect(
      midFlight.filter((row) => row.action === "cloudflare.tunnel_provision_started"),
    ).toHaveLength(1);

    app.deps.host.releaseCompose();
    const res = await post;
    expect(res.statusCode).toBe(202);

    await app.close();
  });
});

describe("GET /api/cloudflare/tunnel", () => {
  it("requires an admin capability — a viewer gets 403", async () => {
    const { app, cookie: adminCookie } = await withStoredCredentials();
    const { cookie: viewerCookie } = await createViewer(app, adminCookie);

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/tunnel",
      headers: { cookie: viewerCookie },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("reports not provisioned with no running job before anything has happened", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provisioned: false, runningJobId: null });
    await app.close();
  });

  it("reports the tunnel's name and appId once a provision has succeeded", async () => {
    const { app, cookie } = await withStoredCredentials();
    app.deps.fetch = tunnelFetch(ACCOUNT_ID);
    const post = await app.inject({
      method: "POST",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });
    const { jobId } = post.json() as { jobId: string };

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { provisioned: true; name: string; appId: string | null };
    expect(body.provisioned).toBe(true);
    expect(body.name).toBe("homestead");
    expect(body.appId).toBeTruthy();
    // The sequence already finished by the time `POST` answered (`StepJobRunner.start`
    // does not return until it does) — nothing is left running for a client that only
    // just learned about this tunnel to watch.
    expect((res.json() as { runningJobId: string | null }).runningJobId).toBeNull();
    expect(jobId).toBeTruthy();
    await app.close();
  });

  it("reports the running job id while the sequence is still in flight, matching the job POST hands back", async () => {
    // The scenario `@web/api/cloudflare`'s `useCloudflareTunnel` exists for: a page
    // reloaded (or a second admin's tab) while `POST /api/cloudflare/tunnel` — which does
    // not return until its whole sequence finishes — is still running server-side. This
    // is the only way such a tab can learn a provision is under way at all, since the
    // job's `appId` is `null` and invisible to every app-scoped job listing.
    const { app, cookie } = await withStoredCredentials();
    app.deps.fetch = tunnelFetch(ACCOUNT_ID);
    app.deps.host.gateCompose();

    const post = app.inject({ method: "POST", url: "/api/cloudflare/tunnel", headers: { cookie } });
    // Waits for the row to actually be running, not a fixed sleep — see the `until`
    // helper's own doc above.
    await until(
      async () => {
        const [row] = await app.deps.db
          .select()
          .from(jobs)
          .where(eq(jobs.kind, TUNNEL_PROVISION_KIND));
        return row?.status ?? null;
      },
      (status) => status === "running",
    );

    const status = await app.inject({
      method: "GET",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    const runningJobId = (status.json() as { runningJobId: string | null }).runningJobId;
    expect(runningJobId).toBeTruthy();

    app.deps.host.releaseCompose();
    const postRes = await post;
    expect(postRes.statusCode).toBe(202);
    expect((postRes.json() as { jobId: string }).jobId).toBe(runningJobId);

    const afterwards = await app.inject({
      method: "GET",
      url: "/api/cloudflare/tunnel",
      headers: { cookie },
    });
    expect((afterwards.json() as { runningJobId: string | null }).runningJobId).toBeNull();

    await app.close();
  });
});
