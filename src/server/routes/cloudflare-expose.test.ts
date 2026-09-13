import { LOCAL_HOST_ID } from "@server/bootstrap";
import { MonitorAccessStore } from "@server/cloudflare/monitor-access";
import { TunnelStore } from "@server/cloudflare/tunnel-store";
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
function exposeFetch(): { fetch: typeof fetch; ingress: () => unknown[] } {
  let ingress: Array<{ hostname?: string; service: string }> = [{ service: "http_status:404" }];
  const dnsRecords = new Map<string, { id: string }>();
  const accessApps = new Map<string, { id: string; aud: string }>();
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
      const body = JSON.parse(String(init?.body ?? "{}")) as { domain: string };
      const id = `access-${nextId++}`;
      const aud = `aud-${id}`;
      accessApps.set(body.domain, { id, aud });
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

  return { fetch: fetchFn, ingress: () => ingress };
}

async function withFullSetup() {
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

  const monitorStore = new MonitorAccessStore(app.deps.db, app.deps.secrets);
  await monitorStore.set(
    {
      tokenId: "monitor-token",
      clientId: "monitor-client",
      policyId: "monitor-policy",
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
  });

  return { app, cookie, appId };
}

const exposeBody = {
  hostname: "jellyfin.example.com",
  zoneId: ZONE_ID,
  ingressService: "http://localhost:8096",
  policyId: "human-policy-1",
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
    const monitorStore = new MonitorAccessStore(app.deps.db, app.deps.secrets);
    await monitorStore.set(
      { tokenId: "t", clientId: "c", policyId: "p", expiresAt: null },
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
    const { fetch: exposed, ingress } = exposeFetch();
    app.deps.fetch = exposed;

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/expose`,
      headers: { cookie },
      payload: exposeBody,
    });

    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const [jobRow] = await app.deps.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobRow?.status).toBe("succeeded");
    expect(jobRow?.appId).toBe(appId);

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
    });

    const [probeRow] = await app.deps.db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRow).toMatchObject({
      kind: "http_external",
      target: "https://jellyfin.example.com",
    });

    await app.close();
  });
});
