import { resolveAccessSettings } from "@server/auth/access-settings";
import { LOCAL_HOST_ID } from "@server/bootstrap";
import { AccessPoliciesStore } from "@server/cloudflare/access-policies";
import { TunnelStore } from "@server/cloudflare/tunnel-store";
import type { Db } from "@server/db/client";
import { apps, exposures, jobs, probes } from "@server/db/schema";
import { buildTestApp, createScopedAdmin, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const TOKEN = "cfat_super-secret-token-value";
const ACCOUNT_ID = "acct-123";
const TUNNEL_ID = "tunnel-1";
const ZONE_ID = "zone-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Polls until `ready`, or fails loudly rather than hanging the suite — mirrors
 * `cloudflare-tunnel.test.ts`'s own helper of the same name. `POST /api/apps/:id/expose`
 * no longer waits for its sequence to finish (2F Task 1), so a test that needs the
 * exposure actually in place can no longer rely on the POST's own response for that. */
async function until<T>(attempt: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await attempt();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

async function waitForJobTerminal(db: Db, jobId: string) {
  return until(
    async () => {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      return row;
    },
    (row) => row !== undefined && row.status !== "running",
  );
}

function verifyingFetch(): typeof fetch {
  return (async () =>
    jsonResponse({
      success: true,
      errors: [],
      result: [{ id: ZONE_ID, name: "example.com" }],
      result_info: { page: 1, per_page: 50, count: 1, total_count: 1 },
    })) as unknown as typeof fetch;
}

/**
 * A minimal in-memory simulator of the ingress-config, DNS-record and Access-app
 * endpoints `exposeSteps` drives — enough to exercise the real `CloudflareClient` through
 * a real (fake) HTTP exchange without ever leaving the process. No test in this file
 * makes a real network call, matching `cloudflare-tunnel.test.ts`'s own `tunnelFetch`.
 */
function exposeFetch(): {
  fetch: typeof fetch;
  ingress: () => unknown[];
  dnsRecords: Map<string, { id: string }>;
  accessApps: Map<string, { id: string; aud: string }>;
  /** The `policies[].id` list the LAST `POST .../access/apps` call carried — Task 5's own
   * binding check: the route must source the human policy id from `AccessPoliciesStore`,
   * never from the request body (the field the UI no longer sends at all). */
  lastAccessAppPolicyIds: () => string[] | undefined;
} {
  let ingress: Array<{ hostname?: string; service: string }> = [{ service: "http_status:404" }];
  const dnsRecords = new Map<string, { id: string }>();
  const accessApps = new Map<string, { id: string; aud: string }>();
  let lastAccessAppPolicyIds: string[] | undefined;
  let nextId = 1;
  const accountPrefix = `/client/v4/accounts/${ACCOUNT_ID}`;
  const zonePrefix = `/client/v4/zones/${ZONE_ID}`;

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const envelope = (result: unknown) => jsonResponse({ success: true, errors: [], result });

    if (url.pathname === `${accountPrefix}/cfd_tunnel/${TUNNEL_ID}/configurations`) {
      if (method === "GET") return envelope({ config: { ingress } });
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          config: { ingress: typeof ingress };
        };
        ingress = body.config.ingress;
        return envelope(null);
      }
    }
    if (url.pathname === `${zonePrefix}/dns_records` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
      const id = `dns-${nextId++}`;
      dnsRecords.set(body.name, { id });
      return envelope({ id });
    }
    if (url.pathname === `${zonePrefix}/dns_records` && method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      const record = dnsRecords.get(name);
      return envelope(record ? [{ id: record.id, name }] : []);
    }
    const dnsDeleteMatch = url.pathname.match(new RegExp(`^${zonePrefix}/dns_records/([^/]+)$`));
    if (dnsDeleteMatch && method === "DELETE") {
      const recordId = dnsDeleteMatch[1];
      for (const [name, record] of dnsRecords) if (record.id === recordId) dnsRecords.delete(name);
      return envelope(null);
    }
    if (url.pathname === `${accountPrefix}/access/apps` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        domain: string;
        policies?: Array<{ id: string }>;
      };
      const id = `access-${nextId++}`;
      const aud = `aud-${id}`;
      accessApps.set(body.domain, { id, aud });
      lastAccessAppPolicyIds = (body.policies ?? []).map((p) => p.id);
      return envelope({ id, aud });
    }
    if (url.pathname === `${accountPrefix}/access/apps` && method === "GET") {
      return envelope([...accessApps].map(([domain, a]) => ({ id: a.id, aud: a.aud, domain })));
    }
    const accessDeleteMatch = url.pathname.match(
      new RegExp(`^${accountPrefix}/access/apps/([^/]+)$`),
    );
    if (accessDeleteMatch && method === "DELETE") {
      const appId = accessDeleteMatch[1];
      for (const [domain, a] of accessApps) if (a.id === appId) accessApps.delete(domain);
      return envelope(null);
    }

    throw new Error(`cloudflare-expose.test.ts: unexpected fetch ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;

  return {
    fetch: fetchFn,
    ingress: () => ingress,
    dnsRecords,
    accessApps,
    lastAccessAppPolicyIds: () => lastAccessAppPolicyIds,
  };
}

async function withFullSetup(opts: { systemKind?: "self" } = {}) {
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

  const tunnelStore = new TunnelStore(app.deps.db, app.deps.secrets);
  await tunnelStore.set(
    { tunnelId: TUNNEL_ID, name: "homestead", appId: null, createdAt: 1_700_000_000 },
    "tunnel-token",
  );

  const monitorStore = new AccessPoliciesStore(app.deps.db, app.deps.secrets);
  await monitorStore.set(
    {
      tokenId: "monitor-token",
      clientId: "monitor-client",
      monitorPolicyId: "monitor-policy",
      humanPolicyId: "human-shared-policy",
      expiresAt: null,
    },
    "monitor-secret",
  );

  const appId = ulid();
  await app.deps.db.insert(apps).values({
    id: appId,
    hostId: LOCAL_HOST_ID,
    slug: "jellyfin",
    displayName: "Jellyfin",
    directory: "jellyfin",
    composeFile: "compose.yaml",
    projectName: "jellyfin",
    systemKind: opts.systemKind ?? null,
  });

  // Task 4: the route now validates `serviceName`/`port` against the app's OWN resolved
  // compose file, so every test that reaches that point needs a real (fake) compose
  // resolution to succeed against — same fixture shape `apps-compose.test.ts` uses.
  app.deps.host.files.set(
    "jellyfin/compose.yaml",
    "services:\n  app:\n    ports:\n      - 8096:8096\n",
  );
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: JSON.stringify({
      name: "jellyfin",
      services: { app: { image: "jellyfin/jellyfin", ports: [{ published: 8096 }] } },
    }),
    stderr: "",
  });

  return { app, cookie, appId };
}

const exposeBody = {
  hostname: "jellyfin.example.com",
  zoneId: ZONE_ID,
  serviceName: "app",
  port: 8096,
};

describe("POST /api/apps/:id/expose", () => {
  it("requires an admin capability — a viewer gets 403", async () => {
    const { app, cookie: adminCookie, appId } = await withFullSetup();
    const { cookie: viewerCookie } = await createViewer(app, adminCookie);

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie: viewerCookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("gives a scoped admin 404 for an app outside their scope, not 409", async () => {
    const { app, cookie: adminCookie, appId } = await withFullSetup();
    const { cookie: scopedCookie } = await createScopedAdmin(app, adminCookie, { appIds: [] });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie: scopedCookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s for a nonexistent app", async () => {
    const { app, cookie } = await withFullSetup();

    const res = await app.inject({
      method: "POST",
      url: "/api/apps/does-not-exist/expose",
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a service name the app's compose file does not have", async () => {
    // Task 4: a typo'd service name must not reach `exposeSteps` at all — the route
    // validates against the app's OWN resolved compose config, not a free-text URL.
    const { app, cookie, appId } = await withFullSetup();

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: { ...exposeBody, serviceName: "does-not-exist" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("service_not_found");
    await app.close();
  });

  it("rejects a port the chosen service does not publish (binding check: an unvalidated port must not reach the URL)", async () => {
    const { app, cookie, appId } = await withFullSetup();

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: { ...exposeBody, port: 9999 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("port_not_published");
    await app.close();
  });

  it("says so clearly, rather than constructing a URL to nowhere, when the chosen service publishes no ports", async () => {
    const { app, cookie, appId } = await withFullSetup();
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({
        name: "jellyfin",
        services: { app: { image: "jellyfin/jellyfin", ports: [] } },
      }),
      stderr: "",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("service_publishes_no_ports");
    await app.close();
  });

  it("rejects an invalid compose file rather than guessing at a service inside it", async () => {
    const { app, cookie, appId } = await withFullSetup();
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "compose file is invalid",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("compose_invalid");
    await app.close();
  });

  it("refuses when the app is already exposed", async () => {
    const { app, cookie, appId } = await withFullSetup();
    await app.deps.db.insert(exposures).values({
      id: ulid(),
      appId,
      hostname: "already.example.com",
      zoneId: ZONE_ID,
      tunnelId: TUNNEL_ID,
      ingressService: "http://localhost:1",
      state: "ready",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_exposed");
    await app.close();
  });

  it("refuses a hostname another app already holds with 409, not a 500 (F11)", async () => {
    // `exposures.hostname` is `.unique()` the same way `appId` is (schema.ts) — the old
    // route only pre-checked `appId`, so a second app exposed at a hostname the first
    // already held spliced its own service into the tunnel over the first app's rule
    // BEFORE hitting the unique constraint deep inside the insert, surfacing as a bare
    // 500 rather than a clean 409 before anything was touched.
    const { app, cookie, appId } = await withFullSetup();
    const otherAppId = ulid();
    await app.deps.db.insert(apps).values({
      id: otherAppId,
      hostId: LOCAL_HOST_ID,
      slug: "plex",
      displayName: "Plex",
      directory: "plex",
      composeFile: "compose.yaml",
      projectName: "plex",
    });
    await app.deps.db.insert(exposures).values({
      id: ulid(),
      appId: otherAppId,
      hostname: exposeBody.hostname,
      zoneId: ZONE_ID,
      tunnelId: TUNNEL_ID,
      ingressService: "http://localhost:1",
      state: "ready",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("hostname_taken");
    await app.close();
  });

  it("refuses without a provisioned tunnel", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.fetch = verifyingFetch();
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    const monitorStore = new AccessPoliciesStore(app.deps.db, app.deps.secrets);
    await monitorStore.set(
      { tokenId: "t", clientId: "c", monitorPolicyId: "p", humanPolicyId: "h", expiresAt: null },
      "secret",
    );
    const appId = ulid();
    await app.deps.db.insert(apps).values({
      id: appId,
      hostId: LOCAL_HOST_ID,
      slug: "jellyfin",
      displayName: "Jellyfin",
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("tunnel_not_provisioned");
    await app.close();
  });

  it("refuses without the monitor service token configured", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.fetch = verifyingFetch();
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    const tunnelStore = new TunnelStore(app.deps.db, app.deps.secrets);
    await tunnelStore.set(
      { tunnelId: TUNNEL_ID, name: "homestead", appId: null, createdAt: 1_700_000_000 },
      "tunnel-token",
    );
    const appId = ulid();
    await app.deps.db.insert(apps).values({
      id: appId,
      hostId: LOCAL_HOST_ID,
      slug: "jellyfin",
      displayName: "Jellyfin",
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("monitor_not_configured");
    await app.close();
  });

  it("exposes the app end to end: 202 with a jobId, ingress spliced, exposures row ready, probe created", async () => {
    const { app, cookie, appId } = await withFullSetup();
    const { fetch: exposed, ingress, lastAccessAppPolicyIds } = exposeFetch();
    app.deps.fetch = exposed;

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const jobRow = await waitForJobTerminal(app.deps.db, jobId);
    expect(jobRow?.status).toBe("succeeded");
    expect(jobRow?.appId).toBe(appId);

    // Task 5: the human policy id comes from `AccessPoliciesStore` — `withFullSetup`'s
    // `human-shared-policy` — never from the request body, which no longer even has a
    // `policyId` field to send.
    expect(lastAccessAppPolicyIds()).toEqual(["human-shared-policy", "monitor-policy"]);

    expect(ingress()).toEqual([
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      { service: "http_status:404" },
    ]);

    const [exposureRow] = await app.deps.db
      .select()
      .from(exposures)
      .where(eq(exposures.appId, appId));
    expect(exposureRow).toMatchObject({
      hostname: "jellyfin.example.com",
      state: "ready",
      ingressRuleCreatedByUs: true,
      dnsRecordCreatedByUs: true,
      accessAppCreatedByUs: true,
      probeCreatedByUs: true,
      probeInternalCreatedByUs: true,
    });

    const probeRows = await app.deps.db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRows).toHaveLength(2);
    expect(probeRows).toContainEqual(
      expect.objectContaining({ kind: "http_external", target: "https://jellyfin.example.com" }),
    );
    expect(probeRows).toContainEqual(
      expect.objectContaining({ kind: "http_internal", target: "http://localhost:8096" }),
    );

    await app.close();
  });

  it("exposing the self app writes its aud and team domain, so 2E's database path resolves (2F Task 2)", async () => {
    // The assertion the task brief calls "the one that closes the three-times-deferred
    // gap": `auth/access-settings.ts`'s `resolveAccessSettings` has always been able to
    // READ these two values from the database — 2E built and tested that — but nothing
    // ever WROTE them, because nothing ever marked an app `systemKind: "self"` (1I, then
    // 2B, then 2E all deferred it). This test exposes a REAL self app end to end and
    // proves `resolveAccessSettings` — the exact function the Access sign-in path calls
    // at request time — now resolves from the database, with no environment override in
    // play at all.
    const { app, cookie, appId } = await withFullSetup({ systemKind: "self" });
    const { fetch: exposed } = exposeFetch();
    app.deps.fetch = exposed;

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: { ...exposeBody, teamDomain: "my-team" },
    });

    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const jobRow = await waitForJobTerminal(app.deps.db, jobId);
    expect(jobRow?.status).toBe("succeeded");

    const [exposureRow] = await app.deps.db
      .select()
      .from(exposures)
      .where(eq(exposures.appId, appId));
    expect(exposureRow?.accessAppAud).toBeTruthy();

    await expect(
      resolveAccessSettings({ db: app.deps.db, config: app.deps.config }),
    ).resolves.toEqual({
      teamDomain: "my-team",
      aud: exposureRow?.accessAppAud,
    });

    await app.close();
  });

  it("refuses to expose the self app without a teamDomain — nothing to write, so refuse before touching anything", async () => {
    const { app, cookie, appId } = await withFullSetup({ systemKind: "self" });
    const { fetch: exposed } = exposeFetch();
    app.deps.fetch = exposed;

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("team_domain_required");
    // Nothing started — no job, no lock taken, no Cloudflare call.
    expect(await app.deps.db.select().from(jobs)).toEqual([]);

    await app.close();
  });

  it("never writes the team-domain setting when exposing an ordinary (non-self) app", async () => {
    // The other half of the same gap, stated as a negative: an ordinary app's expose must
    // never be able to repoint the account-wide Access verification setting, even if a
    // `teamDomain` somehow ends up on the request body.
    const { app, cookie, appId } = await withFullSetup();
    const { fetch: exposed } = exposeFetch();
    app.deps.fetch = exposed;

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: { ...exposeBody, teamDomain: "should-be-ignored" },
    });

    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    await waitForJobTerminal(app.deps.db, jobId);

    await expect(
      resolveAccessSettings({ db: app.deps.db, config: app.deps.config }),
    ).resolves.toBeNull();

    await app.close();
  });
});

describe("GET /api/apps/:id/expose/services", () => {
  it("requires the read capability — a viewer gets 403", async () => {
    const { app, cookie: adminCookie, appId } = await withFullSetup();
    const { cookie: viewerCookie } = await createViewer(app, adminCookie);

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose/services`,
      headers: { cookie: viewerCookie },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("gives a scoped admin 404 for an app outside their scope, not a compose result", async () => {
    const { app, cookie: adminCookie, appId } = await withFullSetup();
    const { cookie: scopedCookie } = await createScopedAdmin(app, adminCookie, { appIds: [] });

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose/services`,
      headers: { cookie: scopedCookie },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s for a nonexistent app", async () => {
    const { app, cookie } = await withFullSetup();

    const res = await app.inject({
      method: "GET",
      url: "/api/apps/does-not-exist/expose/services",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns the resolved services and their published ports", async () => {
    const { app, cookie, appId } = await withFullSetup();

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose/services`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      valid: true,
      services: [{ name: "app", publishedPorts: [8096] }],
    });
    await app.close();
  });

  it("returns a service with no published ports as-is, rather than dropping it", async () => {
    // The form is what turns `publishedPorts: []` into "not exposable, with the reason" —
    // this route's job is only to report the resolved truth.
    const { app, cookie, appId } = await withFullSetup();
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({
        name: "jellyfin",
        services: {
          app: { image: "jellyfin/jellyfin", ports: [{ published: 8096 }] },
          worker: { image: "jellyfin/jellyfin" },
        },
      }),
      stderr: "",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose/services`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      valid: true,
      services: [
        { name: "app", publishedPorts: [8096] },
        { name: "worker", publishedPorts: [] },
      ],
    });
    await app.close();
  });

  it("reports an invalid compose file rather than guessing at its services", async () => {
    const { app, cookie, appId } = await withFullSetup();
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "compose file is invalid",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose/services`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false, message: "compose file is invalid" });
    await app.close();
  });

  it("reuses the same resolved config the POST route validates against — no second docker compose config call", async () => {
    // `ComposeConfigCache` exists specifically because `docker compose config` is the
    // expensive command in this codebase (`compose-config.ts`'s own doc comment) — this is
    // the binding proof that the new endpoint reads the warm cache rather than spawning a
    // second subprocess for the same compose file.
    const { app, cookie, appId } = await withFullSetup();
    const before = app.deps.host.composeCalls.length;

    const first = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose/services`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const afterFirst = app.deps.host.composeCalls.length;
    expect(afterFirst).toBe(before + 1);

    const second = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose/services`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    // A second read of the SAME unchanged compose file must not spawn another process.
    expect(app.deps.host.composeCalls.length).toBe(afterFirst);
    await app.close();
  });
});

describe("GET /api/apps/:id/expose", () => {
  it("requires the read capability — a viewer gets 403", async () => {
    const { app, cookie: adminCookie, appId } = await withFullSetup();
    const { cookie: viewerCookie } = await createViewer(app, adminCookie);

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie: viewerCookie },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("gives a scoped admin 404 for an app outside their scope, not a normal not-exposed answer", async () => {
    const { app, cookie: adminCookie, appId } = await withFullSetup();
    const { cookie: scopedCookie } = await createScopedAdmin(app, adminCookie, { appIds: [] });

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie: scopedCookie },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s for a nonexistent app", async () => {
    const { app, cookie } = await withFullSetup();

    const res = await app.inject({
      method: "GET",
      url: "/api/apps/does-not-exist/expose",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("reports not exposed, with no running job, for an app never exposed", async () => {
    const { app, cookie, appId } = await withFullSetup();

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exposed: false, runningJobId: null });
    await app.close();
  });

  it("reports the exposure's hostname, state and Access application once exposed", async () => {
    const { app, cookie, appId } = await withFullSetup();
    const { fetch: exposed } = exposeFetch();
    app.deps.fetch = exposed;

    const exposeRes = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });
    expect(exposeRes.statusCode).toBe(202);
    const { jobId } = exposeRes.json() as { jobId: string };
    await waitForJobTerminal(app.deps.db, jobId);

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      exposed: boolean;
      hostname: string;
      state: string;
      accessAppId: string | null;
      accessAppAud: string | null;
      runningJobId: string | null;
      driftFindings: unknown[];
    };
    expect(body).toEqual({
      exposed: true,
      hostname: "jellyfin.example.com",
      state: "ready",
      accessAppId: expect.any(String),
      accessAppAud: expect.any(String),
      runningJobId: null,
      driftFindings: [],
    });
    await app.close();
  });

  it("reports the in-flight job's id while an expose sequence is still running, before anything is exposed yet", async () => {
    // The gap `TunnelStatus.runningJobId` closes for the tunnel provision sequence
    // (2C Task 4), applied here: a page loaded the instant after `POST .../expose`
    // returns its `jobId` has no exposure row yet (the first step has not run), but
    // there IS a sequence in flight this tab needs to notice rather than silently
    // showing the "not exposed, offer the form again" state.
    const { app, cookie, appId } = await withFullSetup();
    let releaseIngress: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    const { fetch: exposed } = exposeFetch();
    app.deps.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname.endsWith("/configurations") && (init?.method ?? "GET") === "GET") {
        await gate;
      }
      return exposed(input, init);
    }) as typeof fetch;

    const exposeRes = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });
    expect(exposeRes.statusCode).toBe(202);
    const { jobId } = exposeRes.json() as { jobId: string };

    const res = await until(
      async () =>
        app.inject({
          method: "GET",
          url: `/api/apps/${appId}/expose`,
          headers: { cookie },
        }),
      (r) => (r.json() as { runningJobId: string | null }).runningJobId !== null,
    );
    expect(res.json()).toEqual({ exposed: false, runningJobId: jobId });

    releaseIngress?.();
    await waitForJobTerminal(app.deps.db, jobId);
    await app.close();
  });
});

describe("DELETE /api/apps/:id/expose", () => {
  it("requires an admin capability — a viewer gets 403", async () => {
    const { app, cookie: adminCookie, appId } = await withFullSetup();
    const { cookie: viewerCookie } = await createViewer(app, adminCookie);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie: viewerCookie },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("gives a scoped admin 404 for an app outside their scope, not 409", async () => {
    const { app, cookie: adminCookie, appId } = await withFullSetup();
    const { cookie: scopedCookie } = await createScopedAdmin(app, adminCookie, { appIds: [] });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie: scopedCookie },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s for a nonexistent app", async () => {
    const { app, cookie } = await withFullSetup();

    const res = await app.inject({
      method: "DELETE",
      url: "/api/apps/does-not-exist/expose",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses an app that is in scope but was never exposed", async () => {
    const { app, cookie, appId } = await withFullSetup();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_exposed");
    await app.close();
  });

  it("refuses with 409 app_busy while this app's own expose job is in flight (F7)", async () => {
    // Measured defect: this route took no `AppLock` at all, so it could race the app's
    // OWN in-flight expose job (not just an unrelated compose action) — orphaning a live
    // CNAME and Access application while both operations reported success. The POST
    // route's `stepJobs.start` acquires `app.deps.appLock` by app id; this simulates that
    // hold directly rather than needing to freeze a real job mid-sequence.
    const { app, cookie, appId } = await withFullSetup();
    await app.deps.db.insert(exposures).values({
      id: ulid(),
      appId,
      hostname: "already.example.com",
      zoneId: ZONE_ID,
      tunnelId: TUNNEL_ID,
      ingressService: "http://localhost:1",
      state: "ready",
    });
    expect(app.deps.appLock.tryAcquire(appId, "test: simulated in-flight job")).toBe(true);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("app_busy");

    app.deps.appLock.release(appId);
    await app.close();
  });

  it("deprovisions an exposed app end to end: 200, ingress restored, DNS and Access removed, probe gone, row gone", async () => {
    const { app, cookie, appId } = await withFullSetup();
    const { fetch: exposed, ingress, dnsRecords, accessApps } = exposeFetch();
    app.deps.fetch = exposed;

    const exposeRes = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });
    expect(exposeRes.statusCode).toBe(202);
    const { jobId: exposeJobId } = exposeRes.json() as { jobId: string };
    // The POST no longer waits for its sequence (2F Task 1) — wait for it to actually
    // finish before asserting on state the sequence itself creates, or DELETE below races
    // an exposure that has not been written yet.
    await waitForJobTerminal(app.deps.db, exposeJobId);
    expect(dnsRecords.has("jellyfin.example.com")).toBe(true);
    expect(accessApps.has("jellyfin.example.com")).toBe(true);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(ingress()).toEqual([{ service: "http_status:404" }]);
    expect(dnsRecords.has("jellyfin.example.com")).toBe(false);
    expect(accessApps.has("jellyfin.example.com")).toBe(false);

    const [exposureRow] = await app.deps.db
      .select()
      .from(exposures)
      .where(eq(exposures.appId, appId));
    expect(exposureRow).toBeUndefined();

    const [probeRow] = await app.deps.db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRow).toBeUndefined();

    await app.close();
  });

  it("reports a partial failure without deleting the exposures row", async () => {
    const { app, cookie, appId } = await withFullSetup();
    const { fetch: exposed } = exposeFetch();
    app.deps.fetch = exposed;

    const exposeRes = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });
    expect(exposeRes.statusCode).toBe(202);
    const { jobId: exposeJobId } = exposeRes.json() as { jobId: string };
    // Same reasoning as the end-to-end deprovision test above: wait for the expose
    // sequence to actually finish before making the app "already exposed" for DELETE.
    await waitForJobTerminal(app.deps.db, exposeJobId);

    // Once exposed, make every subsequent Cloudflare call fail — a 400 (`client` fault)
    // rather than a thrown network error, so `createCloudflareClient`'s retry loop does
    // not spend real backoff time on a fault it never retries. The deprovision route
    // must still respond (not throw), report which resources failed, and leave the row
    // in place.
    app.deps.fetch = (async () =>
      jsonResponse(
        { success: false, errors: [{ code: 1000, message: "boom" }] },
        400,
      )) as unknown as typeof fetch;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json() as {
      error: string;
      failures: Array<{ resource: string; message: string }>;
    };
    expect(body.error).toBe("deprovision_incomplete");
    expect(body.failures.length).toBeGreaterThan(0);
    // The reason, not just which resource — see `cloudflare-expose.ts`'s own comment on
    // why the slug alone used to be worse than useless for the access-app case.
    expect(typeof body.failures[0]?.resource).toBe("string");
    expect(typeof body.failures[0]?.message).toBe("string");
    expect(body.failures[0]?.message.length).toBeGreaterThan(0);

    const [exposureRow] = await app.deps.db
      .select()
      .from(exposures)
      .where(eq(exposures.appId, appId));
    expect(exposureRow).toBeDefined();

    await app.close();
  });
});
