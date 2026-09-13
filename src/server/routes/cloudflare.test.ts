import { ACCESS_TEAM_DOMAIN_SETTING_KEY } from "@server/auth/access-settings";
import { LOCAL_HOST_ID } from "@server/bootstrap";
import { apps, auditLog, exposures, settings, users } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const TOKEN = "cfat_super-secret-token-value";
const ACCOUNT_ID = "acct-123";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function successEnvelope(zones: Array<{ id: string; name: string }>) {
  return {
    success: true,
    errors: [],
    result: zones,
    result_info: { page: 1, per_page: 50, count: zones.length, total_count: zones.length },
  };
}

function failureEnvelope(code: number, message: string) {
  return { success: false, errors: [{ code, message }], result: null };
}

/** A `fetch` that always answers a successful `GET /zones` with one fixed zone. */
function verifyingFetch(
  zones: Array<{ id: string; name: string }> = [{ id: "z1", name: "example.com" }],
) {
  return (async () => jsonResponse(successEnvelope(zones))) as unknown as typeof fetch;
}

/** A `fetch` that always answers 401 (an invalid token). */
function failingFetch(status = 401, code = 9109, message = "Invalid access token") {
  return (async () =>
    jsonResponse(failureEnvelope(code, message), { status })) as unknown as typeof fetch;
}

async function withAdmin() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  return { app, cookie };
}

/**
 * A `fetch` that answers `GET /zones` (for credential verification) plus every endpoint
 * `ensureAccessPolicies`/`rotateMonitorSecret` call — the service token, the rotate
 * endpoint, and now (Phase 3A) BOTH `/access/policies` POSTs, distinguished by
 * `decision` on the request body the same way `createMonitorPolicy`/`createEmailPolicy`
 * are distinguished at the client level. Not a real Cloudflare double — a router by URL
 * shape (and, here, request body), since these route tests exercise the HTTP layer end
 * to end rather than substituting a fake `CloudflareClient` the way
 * `provision-tunnel.test.ts` and `access-policies.test.ts` do.
 */
function monitorFetch(): {
  fetch: typeof fetch;
  calls: {
    tokens: number;
    monitorPolicies: number;
    humanPolicies: Array<{ email: string }[]>;
    rotations: number;
  };
} {
  const calls = {
    tokens: 0,
    monitorPolicies: 0,
    humanPolicies: [] as Array<{ email: string }[]>,
    rotations: 0,
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/zones")) {
      return jsonResponse(successEnvelope([{ id: "z1", name: "example.com" }]));
    }
    if (url.endsWith("/access/service_tokens")) {
      calls.tokens++;
      return jsonResponse({
        success: true,
        errors: [],
        result: {
          id: "token-1",
          client_id: "client-1",
          client_secret: "secret-1",
          expires_at: "2027-09-12T00:00:00Z",
        },
      });
    }
    if (/\/access\/service_tokens\/[^/]+\/rotate$/.test(url)) {
      calls.rotations++;
      return jsonResponse({
        success: true,
        errors: [],
        result: {
          client_id: "client-1",
          client_secret: "rotated-secret",
          expires_at: "2028-09-12T00:00:00Z",
        },
      });
    }
    if (url.endsWith("/access/policies")) {
      const body = JSON.parse(String(init?.body)) as {
        decision: string;
        include: Array<{ email?: { email: string } }>;
      };
      if (body.decision === "non_identity") {
        calls.monitorPolicies++;
        return jsonResponse({ success: true, errors: [], result: { id: "policy-monitor" } });
      }
      calls.humanPolicies.push(body.include.map((i) => ({ email: i.email?.email ?? "" })));
      return jsonResponse({ success: true, errors: [], result: { id: "policy-human" } });
    }
    throw new Error(`monitorFetch: unexpected URL ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

async function withConfiguredAdmin(fetchImpl: typeof fetch) {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.fetch = fetchImpl;
  await app.inject({
    method: "PUT",
    url: "/api/cloudflare/credentials",
    headers: { cookie },
    payload: { token: TOKEN, accountId: ACCOUNT_ID },
  });
  return { app, cookie };
}

describe("cloudflare routes", () => {
  it("PUT verifies by listing zones, stores on success, and returns the status", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();

    const res = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configured: true,
      accountId: ACCOUNT_ID,
      tokenHint: TOKEN.slice(-4),
    });
    await app.close();
  });

  it("does not store a token that fails verification", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = failingFetch();

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    expect(putRes.statusCode).toBe(422);

    const statusRes = await app.inject({
      method: "GET",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });
    expect(statusRes.json()).toEqual({ configured: false });
    await app.close();
  });

  it("surfaces the fault from a failed verification", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = failingFetch(401);

    const authRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    expect(authRes.json()).toMatchObject({ fault: "auth" });

    app.deps.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
    }) as unknown as typeof fetch;
    const networkRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    expect(networkRes.json()).toMatchObject({ fault: "network" });
    await app.close();
  });

  it("trims whitespace pasted around the token and account id before verifying and storing", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();

    const res = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      // A trailing newline is the most likely way a copy-pasted, otherwise-valid token
      // gets rejected — invisible in a `type="password"` field.
      payload: { token: `${TOKEN}\n`, accountId: ` ${ACCOUNT_ID} ` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountId: ACCOUNT_ID, tokenHint: TOKEN.slice(-4) });
    await app.close();
  });

  it("GET credentials never returns the token", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });
    expect(res.body).not.toContain(TOKEN);
    expect(JSON.stringify(res.json())).not.toContain(TOKEN);
    await app.close();
  });

  it("GET zones returns zones when configured", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch([
      { id: "z1", name: "one.example" },
      { id: "z2", name: "two.example" },
    ]);
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: "z1", name: "one.example" },
      { id: "z2", name: "two.example" },
    ]);
    await app.close();
  });

  it("GET zones returns a clean error when not configured, not a 500", async () => {
    const { app, cookie } = await withAdmin();

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.statusCode).not.toBe(500);
    expect(res.json()).toMatchObject({ error: "not_configured" });
    await app.close();
  });

  it("gives a viewer 403 on all four routes, revealing nothing about configuration", async () => {
    const { app, cookie: adminCookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie: adminCookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    const { cookie } = await createViewer(app, adminCookie);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: "whatever", accountId: "whatever" },
    });
    const zonesRes = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie },
    });
    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });

    for (const res of [getRes, putRes, zonesRes, deleteRes]) {
      expect(res.statusCode).toBe(403);
      const body = JSON.stringify(res.json());
      expect(body).not.toContain(ACCOUNT_ID);
      expect(body).not.toContain("configured");
      expect(body).not.toContain(TOKEN);
    }
    await app.close();
  });

  it("writes an audit row for every mutation, without the token", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();

    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    await app.inject({
      method: "DELETE",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });

    const rows = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "cloudflare.credentials_saved"));
    expect(rows).toHaveLength(1);

    const deleteRows = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "cloudflare.credentials_deleted"));
    expect(deleteRows).toHaveLength(1);

    const allRows = await app.deps.db.select().from(auditLog);
    const serialised = JSON.stringify(allRows);
    expect(serialised).not.toContain(TOKEN);
    await app.close();
  });

  // Whole-branch review, Critical (half 1). Before this fix, `AccessPoliciesStore.clear()`
  // had no production caller at all — deleting credentials cleared only
  // `CloudflareCredentialStore`, leaving a recorded `humanPolicyId` behind. Saving a
  // DIFFERENT Cloudflare account's credentials afterward left that stale id addressed
  // under the new account, and `routes/users.ts`'s `accessSync()` treated a recorded id as
  // permanently configured — every disable and delete then failed against a policy the new
  // account's token could never reach. Reproduced here without a second real account: the
  // observable bug is that the OLD policy id survives a credentials delete at all.
  it("clears the recorded Access policies when credentials are deleted, not only the credentials themselves", async () => {
    const { app, cookie } = await withAdmin();
    const { AccessPoliciesStore } = await import("@server/cloudflare/access-policies");
    const accessPoliciesStore = new AccessPoliciesStore(app.deps.db, app.deps.secrets);
    await accessPoliciesStore.set(
      {
        tokenId: "monitor-token",
        clientId: "monitor-client",
        monitorPolicyId: "monitor-policy",
        humanPolicyId: "human-policy-stale",
        expiresAt: null,
      },
      "monitor-secret",
    );
    expect(await accessPoliciesStore.get()).not.toBeNull();

    await app.inject({
      method: "DELETE",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });

    expect(await accessPoliciesStore.get()).toBeNull();
    expect(await accessPoliciesStore.getMonitorOnly()).toBeNull();
    await app.close();
  });

  describe("monitor access", () => {
    it("GET returns not configured before anything has been created", async () => {
      const { app, cookie } = await withAdmin();
      const res = await app.inject({
        method: "GET",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      expect(res.json()).toEqual({ configured: false });
      await app.close();
    });

    it("POST creates the token and both policies, and GET reflects it afterwards", async () => {
      const { fetch, calls } = monitorFetch();
      const { app, cookie } = await withConfiguredAdmin(fetch);

      const postRes = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      expect(postRes.statusCode).toBe(200);
      expect(postRes.json()).toMatchObject({
        configured: true,
        clientId: "client-1",
        policyId: "policy-monitor",
        humanPolicyId: expect.any(String),
        expiresAt: Date.parse("2027-09-12T00:00:00Z"),
      });
      expect(calls.tokens).toBe(1);
      expect(calls.monitorPolicies).toBe(1);
      // The human policy is seeded with every enabled user's email at creation time —
      // here, just the admin `withConfiguredAdmin` signed up.
      expect(calls.humanPolicies).toEqual([[{ email: "admin@example.com" }]]);

      const getRes = await app.inject({
        method: "GET",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      expect(getRes.json()).toEqual(postRes.json());
      await app.close();
    });

    it("POST is idempotent — a second call does not create a second token or a second human policy", async () => {
      const { fetch, calls } = monitorFetch();
      const { app, cookie } = await withConfiguredAdmin(fetch);

      const first = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });

      expect(second.json()).toEqual(first.json());
      expect(calls.tokens).toBe(1);
      expect(calls.monitorPolicies).toBe(1);
      expect(calls.humanPolicies).toHaveLength(1);
      await app.close();
    });

    it("seeds the human policy with every enabled user's email, excluding disabled ones", async () => {
      // Phase 3A's own point: a disabled user who keeps internet access to every exposed
      // app through this policy defeats the entire reason for disabling them.
      const { fetch, calls } = monitorFetch();
      const { app, cookie } = await withConfiguredAdmin(fetch);
      const now = Date.now();
      await app.deps.db.insert(users).values({
        id: ulid(),
        email: "viewer@example.com",
        name: "Viewer",
        role: "viewer",
        emailVerified: true,
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await app.deps.db.insert(users).values({
        id: ulid(),
        email: "gone@example.com",
        name: "Gone",
        role: "viewer",
        emailVerified: true,
        disabledAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await app.inject({ method: "POST", url: "/api/cloudflare/monitor", headers: { cookie } });

      expect(calls.humanPolicies).toHaveLength(1);
      const emails = (calls.humanPolicies[0] ?? []).map((e) => e.email).sort();
      expect(emails).toEqual(["admin@example.com", "viewer@example.com"].sort());
      await app.close();
    });

    it("POST returns 409 when Cloudflare credentials are not configured", async () => {
      const { app, cookie } = await withAdmin();
      const res = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "not_configured" });
      await app.close();
    });

    it("GET never returns the secret", async () => {
      const { fetch } = monitorFetch();
      const { app, cookie } = await withConfiguredAdmin(fetch);
      await app.inject({ method: "POST", url: "/api/cloudflare/monitor", headers: { cookie } });

      const res = await app.inject({
        method: "GET",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      expect(res.body).not.toContain("secret-1");
      await app.close();
    });

    it("rotate replaces the secret and keeps the same clientId's token/policy pairing, but 409s if nothing exists yet", async () => {
      const { fetch, calls } = monitorFetch();
      const { app, cookie } = await withConfiguredAdmin(fetch);

      const notYetRes = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor/rotate",
        headers: { cookie },
      });
      expect(notYetRes.statusCode).toBe(409);
      expect(notYetRes.json()).toMatchObject({ error: "monitor_not_configured" });

      const created = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      const rotated = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor/rotate",
        headers: { cookie },
      });

      expect(rotated.statusCode).toBe(200);
      expect(rotated.json()).toMatchObject({
        configured: true,
        policyId: created.json().policyId,
        expiresAt: Date.parse("2028-09-12T00:00:00Z"),
      });
      expect(calls.rotations).toBe(1);
      expect(rotated.body).not.toContain("rotated-secret");
      await app.close();
    });

    it("gives a viewer 403 on all three monitor routes", async () => {
      const { fetch } = monitorFetch();
      const { app, cookie: adminCookie } = await withConfiguredAdmin(fetch);
      await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor",
        headers: { cookie: adminCookie },
      });
      const { cookie } = await createViewer(app, adminCookie);

      const getRes = await app.inject({
        method: "GET",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      const postRes = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor",
        headers: { cookie },
      });
      const rotateRes = await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor/rotate",
        headers: { cookie },
      });

      for (const res of [getRes, postRes, rotateRes]) {
        expect(res.statusCode).toBe(403);
      }
      await app.close();
    });

    it("writes an audit row for ensure and for rotate, without the secret", async () => {
      const { fetch } = monitorFetch();
      const { app, cookie } = await withConfiguredAdmin(fetch);

      await app.inject({ method: "POST", url: "/api/cloudflare/monitor", headers: { cookie } });
      await app.inject({
        method: "POST",
        url: "/api/cloudflare/monitor/rotate",
        headers: { cookie },
      });

      const ensuredRows = await app.deps.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "cloudflare.monitor_access_ensured"));
      expect(ensuredRows).toHaveLength(1);

      const rotatedRows = await app.deps.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "cloudflare.monitor_secret_rotated"));
      expect(rotatedRows).toHaveLength(1);

      const allRows = await app.deps.db.select().from(auditLog);
      const serialised = JSON.stringify(allRows);
      expect(serialised).not.toContain("secret-1");
      expect(serialised).not.toContain("rotated-secret");
      await app.close();
    });
  });

  describe("GET /api/cloudflare/access", () => {
    it("is not configured when nothing is set anywhere", async () => {
      const { app, cookie } = await withAdmin();
      const res = await app.inject({
        method: "GET",
        url: "/api/cloudflare/access",
        headers: { cookie },
      });
      expect(res.json()).toEqual({ configured: false });
      await app.close();
    });

    it("resolves from the database once an app is marked self and its exposure and team domain are recorded", async () => {
      // Proves the wiring end to end through the route, not just `resolveAccessSettings`
      // in isolation — using a manually-seeded `self` app, since nothing in the codebase
      // assigns `systemKind: "self"` yet (see `access-settings.ts`'s doc comment).
      const { app, cookie } = await withAdmin();
      const appId = ulid();
      await app.deps.db.insert(apps).values({
        id: appId,
        hostId: LOCAL_HOST_ID,
        slug: "homestead",
        displayName: "Homestead",
        directory: "homestead",
        composeFile: "compose.yaml",
        projectName: "homestead",
        systemKind: "self",
      });
      await app.deps.db.insert(exposures).values({
        id: ulid(),
        appId,
        hostname: "homestead.example.com",
        ingressService: "http://localhost:3000",
        accessAppAud: "db-aud-value",
      });
      await app.deps.db
        .insert(settings)
        .values({ key: ACCESS_TEAM_DOMAIN_SETTING_KEY, value: "db-team" });

      const res = await app.inject({
        method: "GET",
        url: "/api/cloudflare/access",
        headers: { cookie },
      });
      expect(res.json()).toEqual({
        configured: true,
        teamDomain: "db-team",
        aud: "db-aud-value",
        source: "database",
      });
      await app.close();
    });

    it("says the environment when both HOMESTEAD_ACCESS_* variables are set, even with a self app in the database too", async () => {
      // `resolveAccessSettings`'s own precedence: the environment wins ONLY when it
      // supplies BOTH values, and never blends with the database. This proves the
      // route's own `source` field agrees with that precedence rather than reporting
      // "database" just because a self app happens to exist.
      const { app, cookie } = await withAdmin();
      app.deps.config = {
        ...app.deps.config,
        accessTeamDomain: "env-team",
        accessAud: "env-aud",
      };
      const appId = ulid();
      await app.deps.db.insert(apps).values({
        id: appId,
        hostId: LOCAL_HOST_ID,
        slug: "homestead",
        displayName: "Homestead",
        directory: "homestead",
        composeFile: "compose.yaml",
        projectName: "homestead",
        systemKind: "self",
      });
      await app.deps.db.insert(exposures).values({
        id: ulid(),
        appId,
        hostname: "homestead.example.com",
        ingressService: "http://localhost:3000",
        accessAppAud: "db-aud-value",
      });
      await app.deps.db
        .insert(settings)
        .values({ key: ACCESS_TEAM_DOMAIN_SETTING_KEY, value: "db-team" });

      const res = await app.inject({
        method: "GET",
        url: "/api/cloudflare/access",
        headers: { cookie },
      });
      expect(res.json()).toEqual({
        configured: true,
        teamDomain: "env-team",
        aud: "env-aud",
        source: "environment",
      });
      await app.close();
    });

    it("gives a viewer 403", async () => {
      const { app, cookie: adminCookie } = await withAdmin();
      const { cookie } = await createViewer(app, adminCookie);
      const res = await app.inject({
        method: "GET",
        url: "/api/cloudflare/access",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe("POST /api/cloudflare/reconcile", () => {
    /** Answers the three read calls `reconcile.ts` makes — DNS record lookup, tunnel
     * config, Access application lookup — plus `/zones`, needed only because
     * `withConfiguredAdmin` verifies credentials through it before this route ever runs.
     * `dnsFound`/`accessFound`/`ingressMatches` default to "everything matches, no
     * drift"; a test overrides only the one it means to break, the same shape
     * `reconcile.test.ts`'s own `fakeClient` uses. */
    function reconcileFetch(
      opts: {
        dnsFound?: boolean;
        accessFound?: boolean;
        ingressMatches?: boolean;
        expectedContent?: string;
        ingressService?: string;
      } = {},
    ): { fetch: typeof fetch; calls: Array<{ url: string; method: string }> } {
      const calls: Array<{ url: string; method: string }> = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET" });
        // Checked before the plain `/zones` match below: `findDnsRecord`'s own URL is
        // `.../zones/{zoneId}/dns_records`, which also contains the substring "/zones" —
        // an earlier version of this double matched THAT on the zones branch first,
        // handing `findDnsRecord` a zones envelope shaped just enough like a DNS record
        // list to parse (an `id` field is all `dnsRecordsResultSchema` strictly requires)
        // and silently reporting every exposure as drifted. Order matters here.
        if (url.includes("/dns_records")) {
          const found = opts.dnsFound ?? true;
          return jsonResponse({
            success: true,
            errors: [],
            result: found
              ? [
                  {
                    id: "dns-1",
                    type: "CNAME",
                    proxied: true,
                    content: opts.expectedContent ?? "tunnel-1.cfargotunnel.com",
                  },
                ]
              : [],
          });
        }
        if (url.endsWith("/configurations")) {
          const matches = opts.ingressMatches ?? true;
          return jsonResponse({
            success: true,
            errors: [],
            result: {
              config: {
                ingress: [
                  {
                    hostname: "jellyfin.example.com",
                    service: matches
                      ? (opts.ingressService ?? "http://localhost:8096")
                      : "http://localhost:9999",
                  },
                ],
              },
            },
          });
        }
        if (url.endsWith("/access/apps")) {
          const found = opts.accessFound ?? true;
          return jsonResponse({
            success: true,
            errors: [],
            result: found ? [{ id: "access-1", aud: "aud-1", domain: "jellyfin.example.com" }] : [],
          });
        }
        // Only `withConfiguredAdmin`'s own credential-verification PUT reaches this —
        // checked last, and deliberately loose (`includes`, not `endsWith`) is fine here
        // precisely because the three more specific branches above already claimed every
        // URL that could also contain this substring.
        if (url.includes("/zones")) {
          return jsonResponse(successEnvelope([{ id: "z1", name: "example.com" }]));
        }
        throw new Error(`reconcileFetch: unexpected URL ${url}`);
      }) as unknown as typeof fetch;
      return { fetch: fetchFn, calls };
    }

    async function seedReadyExposure(app: Awaited<ReturnType<typeof buildTestApp>>) {
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
      await app.deps.db.insert(exposures).values({
        id: ulid(),
        appId,
        hostname: "jellyfin.example.com",
        zoneId: "z1",
        tunnelId: "tunnel-1",
        ingressService: "http://localhost:8096",
        accessAppId: "access-1",
        accessAppAud: "aud-1",
        state: "ready",
      });
      return appId;
    }

    it("404s — well, 409s — when credentials aren't configured", async () => {
      const { app, cookie } = await withAdmin();
      const res = await app.inject({
        method: "POST",
        url: "/api/cloudflare/reconcile",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "not_configured" });
      await app.close();
    });

    it("reports nothing checked and nothing drifted when there are no exposures", async () => {
      const { fetch } = reconcileFetch();
      const { app, cookie } = await withConfiguredAdmin(fetch);
      const res = await app.inject({
        method: "POST",
        url: "/api/cloudflare/reconcile",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ checked: 0, drifted: 0 });
      await app.close();
    });

    it("flags a drifted exposure, records an audit entry, and never calls a Cloudflare write endpoint", async () => {
      const { fetch, calls } = reconcileFetch({ dnsFound: false });
      const { app, cookie } = await withConfiguredAdmin(fetch);
      await seedReadyExposure(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/cloudflare/reconcile",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ checked: 1, drifted: 1 });

      const [exposureRow] = await app.deps.db.select().from(exposures);
      expect(exposureRow?.state).toBe("drifted");
      expect(exposureRow?.driftFindings).toContain("dns_record_missing");

      const entries = await app.deps.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "cloudflare.reconcile_ran"));
      expect(entries).toHaveLength(1);
      expect(entries[0]?.detail).toEqual({ checked: 1, drifted: 1 });

      // Every call this run made to Cloudflare was a read (GET), never a PUT, POST, or
      // DELETE — the binding check for §6's "flags, never corrects" rule at the HTTP
      // layer, mirroring `reconcile.test.ts`'s own client-level version of the same
      // assertion. `calls[0]` is `/zones` (`withConfiguredAdmin`'s own credential
      // verification, a GET too) — included rather than filtered out, since it is still a
      // real call this test can assert never mutated anything.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.method).toBe("GET");
      }
    });

    it("reports a clean exposure as checked but not drifted", async () => {
      const { fetch } = reconcileFetch();
      const { app, cookie } = await withConfiguredAdmin(fetch);
      await seedReadyExposure(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/cloudflare/reconcile",
        headers: { cookie },
      });
      expect(res.json()).toEqual({ checked: 1, drifted: 0 });

      const [exposureRow] = await app.deps.db.select().from(exposures);
      expect(exposureRow?.state).toBe("ready");
      expect(exposureRow?.driftFindings).toBeNull();
    });

    it("gives a viewer 403", async () => {
      const { app, cookie: adminCookie } = await withAdmin();
      const { cookie } = await createViewer(app, adminCookie);
      const res = await app.inject({
        method: "POST",
        url: "/api/cloudflare/reconcile",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});
