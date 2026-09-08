import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import type { CloudflareClient } from "../cloudflare/client.js";
import { encrypt } from "../crypto/secrets.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { exposures, settings, user } from "../db/schema.js";
import { createFakeDocker } from "../docker/fake.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

/**
 * Every app in this file gets a docker runner. Without one, buildApp falls
 * back to the real `docker`, and setup's startProject genuinely brought a
 * cloudflared container up on the developer's machine from a /tmp compose
 * file. Tests do not start containers.
 */
const noDocker = {
  run: async () => ({ stdout: "", stderr: "", code: 0 }),
  stream: async () => 0,
};

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let auth: ReturnType<typeof createAuth>;
let root: string;
let adminCookie: string;
let viewerCookie: string;

const PLAINTEXT_TOKEN = "test-cloudflare-api-token-12345";
const PLAINTEXT_SERVICE_SECRET = "test-service-token-secret-67890";

/** Server-side sign-in: bypasses the HTTP rate limiter (5/min per file). */
async function signIn(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie returned");
  // biome-ignore lint/style/noNonNullAssertion: cookie is checked above
  return cookie.split(";")[0]!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-cloudflare-"));
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);

  // Default mock cloudflare client (returns success)
  const mockCloudflare = (): CloudflareClient => ({
    detectTokenKind: async () => "account" as const,
    verifyToken: async () => ({ ok: true }),
    listAccounts: async () => [
      { id: "acc-123", name: "Test Account" },
      { id: "acc-456", name: "Another Account" },
    ],
    listZones: async () => [{ id: "zone-abc", name: "example.com" }],
    listIdentityProviders: async () => [
      { id: "idp-xyz", name: "Google OAuth", type: "google" },
    ],
    request: async (_m: string, path: string) =>
      // Realistic enough for the paths a request actually takes: DNS listing
      // returns a collection; anything created comes back with an id.
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (path.includes("/dns_records") ? [] : { id: "cf-obj" }) as any,
  });

  app = await buildApp({
    db,
    auth,
    secretKey: Buffer.alloc(32),
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
    cloudflare: mockCloudflare,
    docker: noDocker,
  });

  const a = await auth.api.signUpEmail({
    body: {
      email: "admin@example.com",
      name: "Admin",
      password: "correct-horse-battery",
    },
  });
  await db.update(user).set({ role: "admin" }).where(eq(user.id, a.user.id));
  await auth.api.signUpEmail({
    body: {
      email: "viewer@example.com",
      name: "Viewer",
      password: "correct-horse-battery",
    },
  });
  adminCookie = await signIn("admin@example.com", "correct-horse-battery");
  viewerCookie = await signIn("viewer@example.com", "correct-horse-battery");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/cloudflare/status", () => {
  it("returns unconfigured status when no token is set", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/status",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.accountId).toBeNull();
    expect(body.tunnelId).toBeNull();
    expect(body.runtime).toEqual({ kind: "none" });
    expect(body.idpId).toBeNull();
    expect(body.syncState).toBe("synced");
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/status",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/cloudflare/zones", () => {
  it("lists the account's zones for the hostname picker", async () => {
    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      {
        key: "cloudflare.apiToken",
        value: encrypt(PLAINTEXT_TOKEN, Buffer.alloc(32)),
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().zones).toEqual([{ id: "zone-abc", name: "example.com" }]);
  });

  it("says Cloudflare is not configured rather than failing obscurely", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("tunnel_not_configured");
  });

  it("is refused for a viewer", async () => {
    // Zone names are account structure, and every other Cloudflare route here
    // is admin-only.
    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/cloudflare/token", () => {
  it("verifies and stores encrypted token, returns accounts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts[0]).toEqual({ id: "acc-123", name: "Test Account" });

    // Verify token is stored encrypted (does not contain plaintext)
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.apiToken"));
    expect(row?.value).toBeTruthy();
    expect(row?.value).not.toContain(PLAINTEXT_TOKEN);
  });

  it("returns 400 with missing scopes when token is invalid", async () => {
    // Replace app with one that returns missing scopes
    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({
        ok: false,
        missingScopes: ["Account:Read", "Zone:Read"],
      }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      request: async () => ({}) as any,
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: "invalid-token" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_token");
    expect(body.missingScopes).toEqual(["Account:Read", "Zone:Read"]);

    // Verify nothing was stored
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.apiToken"));
    expect(row).toBeUndefined();
  });

  it("refuses a user token and says how to make an account one", async () => {
    // Homestead runs unattended for years. A user token goes inactive the day
    // its owner loses access to the account, taking management of every
    // exposed hostname with it. Cloudflare's own guidance is that durable
    // integrations use an account-owned token.
    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "user",
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [{ id: "acc-123", name: "Test Account" }],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      request: async () => ({}) as any,
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: "cfut_a-user-token" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("user_token");
    expect(body.detail).toMatch(/account-owned/i);
    expect(body.detail).toMatch(/Account API Tokens/);

    // Rejected means rejected: a user token must not be left behind.
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.apiToken"));
    expect(row).toBeUndefined();
  });

  it("never leaks the token back in the rejection", async () => {
    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "user",
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      request: async () => ({}) as any,
    });
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: "cfut_secret-value-here" },
    });
    expect(res.body).not.toContain("secret-value-here");
  });

  it("does not report unreadable identity providers as none configured", async () => {
    // The account had two. The token could not read them, so Cloudflare
    // answered with an authentication error — and before this, that surfaced
    // as a 500. When there are zero it answers with an empty list instead, so
    // the two cases are genuinely different and must not be conflated: telling
    // someone to configure an IdP they already have sends them somewhere with
    // nothing to do.
    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [{ id: "acc-123", name: "Test Account" }],
      listZones: async () => [{ id: "z1", name: "example.com" }],
      listIdentityProviders: async () => {
        throw new Error("Cloudflare API error (403): Authentication error");
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      request: async () => ({}) as any,
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/account",
      headers: { cookie: adminCookie },
      payload: { accountId: "acc-123" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("idp_unreadable");
    expect(body.detail).toMatch(/Identity Providers Read/);
    // Not the other message, which would send them to configure one they have.
    expect(body.detail).not.toMatch(/no identity providers configured/i);
  });

  it("explains an empty account list instead of accepting the token", async () => {
    // Cloudflare answers GET /accounts with 200 and an empty array when the
    // token lacks User → Memberships → Read, so verifyToken sees nothing wrong.
    // Storing it leaves setup on an empty dropdown with no way to learn why.
    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      request: async () => ({}) as any,
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("no_accounts");
    // The permission is under User, not Account or Zone, which is exactly why
    // it gets missed. Naming it is the whole point of this branch.
    expect(body.missingScopes).toEqual(["User:Memberships:Read"]);
    expect(body.detail).toMatch(/Memberships/);

    // A token that cannot list accounts cannot finish setup, so it is not kept.
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.apiToken"));
    expect(row).toBeUndefined();
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: viewerCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/cloudflare/account", () => {
  it("returns zones and identity providers for the account", async () => {
    // Store a token first
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/account",
      headers: { cookie: adminCookie },
      payload: { accountId: "acc-123" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.zones).toHaveLength(1);
    expect(body.zones[0]).toEqual({ id: "zone-abc", name: "example.com" });
    expect(body.idps).toHaveLength(1);
    expect(body.idps[0]).toEqual({
      id: "idp-xyz",
      name: "Google OAuth",
      type: "google",
    });
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/account",
      headers: { cookie: viewerCookie },
      payload: { accountId: "acc-123" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/cloudflare/setup", () => {
  it("refuses setup when account has no identity provider", async () => {
    // Replace app with one that returns empty IdP list
    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [{ id: "acc-123", name: "Test Account" }],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      request: async () => ({}) as any,
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Store a token first
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    // Store account
    await db
      .insert(settings)
      .values({ key: "cloudflare.accountId", value: "acc-123" });

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: adminCookie },
      payload: { idpId: "idp-xyz" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("no_identity_provider");

    // Verify no tunnel was created (tunnelId should not be stored)
    const [tunnelRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.tunnelId"));
    expect(tunnelRow).toBeUndefined();
  });

  // The runtime dependencies were `async () => []` and a no-op from the day
  // this module was written. runtime.test.ts covers adopt-vs-deploy thoroughly
  // with its own fakes, so both stayed green while the real call site could
  // neither see a running cloudflared nor write a file. These two drive the
  // wiring itself.
  function fullSetupMock(): CloudflareClient {
    return {
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [{ id: "acc-123", name: "Test Account" }],
      listZones: async () => [{ id: "zone-abc", name: "example.com" }],
      listIdentityProviders: async () => [
        { id: "idp-xyz", name: "Google OAuth", type: "google" },
      ],
      request: async (method, path) => {
        if (method === "POST" && path.includes("/cfd_tunnel"))
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "tunnel-123" } as any;
        if (method === "GET" && path.includes("/token"))
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return "tunnel-run-token-abc" as any;
        if (method === "POST" && path.includes("/access/service_tokens"))
          return {
            id: "st-1",
            client_id: "client-abc",
            client_secret: PLAINTEXT_SERVICE_SECRET,
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return { id: `x-${randomUUID()}` } as any;
      },
    };
  }

  /** A docker runner that answers `ps` with the given "id\timage" lines. */
  function dockerWith(lines: string[]) {
    return {
      run: async () => ({ stdout: lines.join("\n"), stderr: "", code: 0 }),
      stream: async () => 0,
    };
  }

  async function bootForSetup(docker: ReturnType<typeof dockerWith>) {
    await app.close();
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: fullSetupMock,
      docker,
    });
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/account",
      headers: { cookie: adminCookie },
      payload: { accountId: "acc-123" },
    });
    return app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: adminCookie },
      payload: { idpId: "idp-xyz" },
    });
  }

  it("accepts what the exposure form actually sends", async () => {
    // The form has no zone field, and sends null for an empty project or
    // label. The schema required zoneId and rejected null for both, so every
    // attempt to add an exposure failed with a bare "invalid_body" that named
    // nothing. This drives the real body shape.
    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      {
        key: "cloudflare.apiToken",
        value: encrypt(PLAINTEXT_TOKEN, Buffer.alloc(32)),
      },
      // Access is on by default, and reconcile refuses to publish a hostname
      // it cannot protect. After setup these exist; without them the fail-
      // closed guard correctly rejects the exposure.
      { key: "cloudflare.policyAllowId", value: "pol-allow" },
      { key: "cloudflare.policyProbeId", value: "pol-probe" },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostname: "metube.example.com",
        hostPort: 8081,
        scheme: "http",
        noTlsVerify: false,
        projectSlug: null,
        label: null,
        enabled: true,
        accessEnabled: true,
      },
    });

    expect(res.statusCode).toBe(201);

    // The zone came from the hostname rather than the request.
    const [row] = await db.select().from(exposures);
    expect(row?.zoneId).toBe("zone-abc");
    expect(row?.hostPort).toBe(8081);
  });

  it("reports a DNS conflict in the response, not just the server log", async () => {
    // upsertDnsRecord refuses to repoint a hostname that already resolves
    // elsewhere — correct, and destructive to do otherwise. But it threw, and
    // the 5xx handler masks every unhandled error to {"error":"internal_error"}
    // to avoid leaking paths, so the one thing worth saying — which record is
    // in the way — reached only the log.
    await app.close();
    const base = fullSetupMock();
    const mock = (): CloudflareClient => ({
      ...base,
      request: async (method, path, body) => {
        if (method === "GET" && path.includes("/dns_records")) {
          const records = [
            {
              id: "r1",
              name: "metube.example.com",
              type: "A",
              content: "192.0.2.1",
            },
          ];
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return records as any;
        }
        return base.request(method, path, body);
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mock,
      docker: noDocker,
    });

    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      {
        key: "cloudflare.apiToken",
        value: encrypt(PLAINTEXT_TOKEN, Buffer.alloc(32)),
      },
      { key: "cloudflare.policyAllowId", value: "pol-allow" },
      { key: "cloudflare.policyProbeId", value: "pol-probe" },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostname: "metube.example.com",
        hostPort: 8081,
        scheme: "http",
        noTlsVerify: false,
        projectSlug: null,
        label: null,
        enabled: true,
        accessEnabled: true,
      },
    });

    // A conflict, not a crash: 4xx so the error handler does not mask it.
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.detail).toContain("metube.example.com");
    expect(body.detail).toContain("192.0.2.1");
  });

  it("keeps provisioning the other exposures when one hostname conflicts", async () => {
    // The loop aborted on the first throw, so one bad hostname stopped DNS and
    // Access for every exposure after it.
    await app.close();
    const seen: string[] = [];
    const base = fullSetupMock();
    const mock = (): CloudflareClient => ({
      ...base,
      request: async (method, path, body) => {
        if (method === "GET" && path.includes("/dns_records")) {
          const records = [
            {
              id: "r1",
              name: "bad.example.com",
              type: "A",
              content: "1.2.3.4",
            },
          ];
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return records as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          seen.push((body as { name: string }).name);
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "new" } as any;
        }
        return base.request(method, path, body);
      },
    });
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mock,
      docker: noDocker,
    });

    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      {
        key: "cloudflare.apiToken",
        value: encrypt(PLAINTEXT_TOKEN, Buffer.alloc(32)),
      },
      { key: "cloudflare.policyAllowId", value: "pol-allow" },
      { key: "cloudflare.policyProbeId", value: "pol-probe" },
    ]);
    await db.insert(exposures).values([
      {
        id: "e-bad",
        projectSlug: null,
        hostPort: 9001,
        zoneId: "zone-abc",
        hostname: "bad.example.com",
        scheme: "http",
        noTlsVerify: false,
        label: null,
        enabled: true,
        accessEnabled: false,
        accessAppId: null,
      },
      {
        id: "e-good",
        projectSlug: null,
        hostPort: 9002,
        zoneId: "zone-abc",
        hostname: "good.example.com",
        scheme: "http",
        noTlsVerify: false,
        label: null,
        enabled: true,
        accessEnabled: false,
        accessAppId: null,
      },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures/reconcile",
      headers: { cookie: adminCookie },
    });

    expect(res.statusCode).toBe(409);
    // The healthy one was still created.
    expect(seen).toContain("good.example.com");
    expect(res.json().detail).toContain("bad.example.com");
  });

  it("says which zone is missing rather than a bare invalid_body", async () => {
    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      {
        key: "cloudflare.apiToken",
        value: encrypt(PLAINTEXT_TOKEN, Buffer.alloc(32)),
      },
      // Access is on by default, and reconcile refuses to publish a hostname
      // it cannot protect. After setup these exist; without them the fail-
      // closed guard correctly rejects the exposure.
      { key: "cloudflare.policyAllowId", value: "pol-allow" },
      { key: "cloudflare.policyProbeId", value: "pol-probe" },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostname: "metube.somewhere-else.net",
        hostPort: 8081,
        scheme: "http",
        noTlsVerify: false,
        projectSlug: null,
        label: null,
        enabled: true,
        accessEnabled: true,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("unknown_zone");
    // Naming the hostname and what is available is the difference between a
    // typo you can see and a form that just refuses.
    expect(body.detail).toContain("somewhere-else.net");
    expect(body.detail).toContain("example.com");
  });

  it("explains a malformed body instead of only refusing it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: { hostname: "x.example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/hostPort/);
  });

  it("reports a running connector in status instead of a hardcoded none", async () => {
    // status returned { kind: "none" } unconditionally, with a comment saying
    // real detection needed docker access. It has had that since listContainers
    // landed, and until now the screen said nothing was running while a healthy
    // connector sat there.
    await app.close();
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      docker: dockerWith([
        "c0ffee\tcloudflare/cloudflared:latest\thomestead-tunnel",
      ]),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/status",
      headers: { cookie: adminCookie },
    });
    expect(res.json().runtime).toEqual({
      kind: "deployed",
      projectSlug: "homestead-tunnel",
    });
  });

  it("reports none in status when no connector is running", async () => {
    await app.close();
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      docker: dockerWith([]),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/status",
      headers: { cookie: adminCookie },
    });
    expect(res.json().runtime).toEqual({ kind: "none" });
  });

  it("starts the stack it just wrote", async () => {
    // Writing the files is not a running tunnel. Leaving the start manual is
    // what left every hostname dead behind a screen saying "Setup complete".
    const calls: string[][] = [];
    await app.close();
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: fullSetupMock,
      docker: {
        run: async (args: string[]) => {
          calls.push(args);
          return { stdout: "", stderr: "", code: 0 };
        },
        stream: async () => 0,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/account",
      headers: { cookie: adminCookie },
      payload: { accountId: "acc-123" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: adminCookie },
      payload: { idpId: "idp-xyz" },
    });

    expect(res.statusCode).toBe(200);
    const up = calls.find((a) => a.includes("up"));
    expect(up, `no compose up in ${JSON.stringify(calls)}`).toBeDefined();
    expect(up).toContain("-d");
    expect(up?.join(" ")).toContain("homestead-tunnel");
  });

  it("replaces a tunnel deleted in Cloudflare, and its run token with it", async () => {
    // Deleting the tunnel upstream leaves the stored id and run token pointing
    // at nothing. Reusing them writes a dead token into the cloudflared stack:
    // the daemon starts, never registers, and setup reports success. Dropping
    // the token matters as much as the id — leaving it makes the fetch below
    // get skipped.
    await db.insert(settings).values([
      { key: "cloudflare.tunnelId", value: "tunnel-deleted" },
      { key: "cloudflare.runToken", value: encrypt("stale", Buffer.alloc(32)) },
    ]);

    await app.close();
    const base = fullSetupMock();
    const mock = (): CloudflareClient => ({
      ...base,
      request: async (method, path, body) => {
        // The tunnel is gone upstream.
        if (method === "GET" && /\/cfd_tunnel\/tunnel-deleted$/.test(path)) {
          throw new Error("Cloudflare API error (404): Not found");
        }
        return base.request(method, path, body);
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mock,
      docker: dockerWith([]),
    });
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/account",
      headers: { cookie: adminCookie },
      payload: { accountId: "acc-123" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: adminCookie },
      payload: { idpId: "idp-xyz" },
    });

    expect(res.statusCode).toBe(200);
    // A fresh tunnel, not the deleted one.
    expect(res.json().tunnelId).toBe("tunnel-123");

    // And the stack carries the new tunnel's token, not the stale one.
    const env = await readFile(join(root, "homestead-tunnel", ".env"), "utf8");
    expect(env).toContain("tunnel-run-token-abc");
    expect(env).not.toContain("stale");
  });

  it("writes the cloudflared stack to disk when nothing is running", async () => {
    const res = await bootForSetup(dockerWith([]));
    expect(res.statusCode).toBe(200);
    expect(res.json().runtime).toEqual({
      kind: "deployed",
      projectSlug: "homestead-tunnel",
    });

    // The files, on the real projects directory — not a fake's record of them.
    const dir = join(root, "homestead-tunnel");
    const compose = await readFile(join(dir, "compose.yaml"), "utf8");
    expect(compose).toContain("cloudflare/cloudflared");
    expect(compose).toContain("network_mode: host");
    const env = await readFile(join(dir, ".env"), "utf8");
    expect(env).toContain("tunnel-run-token-abc");
  });

  it("adopts a cloudflared already running instead of writing a second one", async () => {
    const res = await bootForSetup(
      dockerWith(["c0ffee\tcloudflare/cloudflared:latest"]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().runtime).toEqual({
      kind: "adopted",
      containerId: "c0ffee",
    });
    // Adoption exists so two daemons do not compete for one tunnel; writing
    // the project anyway would invite exactly that.
    await expect(
      readFile(join(root, "homestead-tunnel", "compose.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  it("creates tunnel, policies, service token, and runtime", async () => {
    let tunnelCreated = false;
    let policyCreated = false;
    let serviceTokenCreated = false;

    // Replace app with full mock implementation
    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [{ id: "acc-123", name: "Test Account" }],
      listZones: async () => [{ id: "zone-abc", name: "example.com" }],
      listIdentityProviders: async () => [
        { id: "idp-xyz", name: "Google OAuth", type: "google" },
      ],
      request: async (method, path) => {
        if (method === "POST" && path.includes("/cfd_tunnel")) {
          tunnelCreated = true;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "tunnel-123" } as any;
        }
        if (
          method === "GET" &&
          path.includes("/cfd_tunnel") &&
          path.includes("/token")
        ) {
          // A bare string, which is what Cloudflare actually returns. The
          // object form this mock used to return is why the wrong shape
          // shipped.
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return "tunnel-run-token-abc" as any;
        }
        if (method === "POST" && path.includes("/access/policies")) {
          policyCreated = true;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: `policy-${randomUUID()}` } as any;
        }
        if (method === "POST" && path.includes("/access/service_tokens")) {
          serviceTokenCreated = true;
          return {
            id: "st-123",
            client_id: "client-abc",
            client_secret: PLAINTEXT_SERVICE_SECRET,
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Store a token first
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    // Store account
    await db
      .insert(settings)
      .values({ key: "cloudflare.accountId", value: "acc-123" });

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: adminCookie },
      payload: { idpId: "idp-xyz" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tunnelId).toBe("tunnel-123");
    expect(body.runtime).toEqual({
      kind: "deployed",
      projectSlug: "homestead-tunnel",
    });

    // Verify the response body does not contain plaintext secrets
    const responseText = JSON.stringify(body);
    expect(responseText).not.toContain(PLAINTEXT_TOKEN);
    expect(responseText).not.toContain(PLAINTEXT_SERVICE_SECRET);

    // Verify resources were created
    expect(tunnelCreated).toBe(true);
    expect(policyCreated).toBe(true);
    expect(serviceTokenCreated).toBe(true);

    // Verify service token secret is stored encrypted
    const [secretRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.serviceTokenSecret"));
    expect(secretRow?.value).toBeTruthy();
    expect(secretRow?.value).not.toContain(PLAINTEXT_SERVICE_SECRET);
  });

  it("is resumable after failure at service token step", async () => {
    let tunnelCreateCount = 0;
    let serviceTokenCreateCount = 0;
    let policyCreateCount = 0;

    // Replace app with mock that fails after service token on first try
    await app.close();
    let shouldFail = true;
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [{ id: "acc-123", name: "Test Account" }],
      listZones: async () => [{ id: "zone-abc", name: "example.com" }],
      listIdentityProviders: async () => [
        { id: "idp-xyz", name: "Google OAuth", type: "google" },
      ],
      request: async (method, path) => {
        if (method === "POST" && path.includes("/cfd_tunnel")) {
          tunnelCreateCount++;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "tunnel-456" } as any;
        }
        if (
          method === "GET" &&
          path.includes("/cfd_tunnel") &&
          path.includes("/token")
        ) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return "tunnel-run-token-def" as any; // bare string: the real Cloudflare shape
        }
        if (method === "POST" && path.includes("/access/service_tokens")) {
          serviceTokenCreateCount++;
          return {
            id: "st-456",
            client_id: "client-def",
            client_secret: PLAINTEXT_SERVICE_SECRET,
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "POST" && path.includes("/access/policies")) {
          policyCreateCount++;
          if (shouldFail) {
            throw new Error("Simulated policy creation failure");
          }
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: `policy-${randomUUID()}` } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Store a token first
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    // Store account
    await db
      .insert(settings)
      .values({ key: "cloudflare.accountId", value: "acc-123" });

    // First attempt - will fail at policy creation
    const firstAttempt = await app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: adminCookie },
      payload: { idpId: "idp-xyz" },
    });

    expect(firstAttempt.statusCode).toBe(500);

    // Verify tunnel was created and service token secret was stored
    const [tunnelRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.tunnelId"));
    expect(tunnelRow?.value).toBe("tunnel-456");

    const [secretRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.serviceTokenSecret"));
    expect(secretRow?.value).toBeTruthy();
    expect(secretRow?.value).not.toContain(PLAINTEXT_SERVICE_SECRET);

    // Second attempt - should succeed without recreating tunnel or service token
    shouldFail = false;
    const secondAttempt = await app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: adminCookie },
      payload: { idpId: "idp-xyz" },
    });

    expect(secondAttempt.statusCode).toBe(200);
    const body = secondAttempt.json();
    expect(body.tunnelId).toBe("tunnel-456");

    // Verify only one tunnel was created (not duplicated on retry)
    expect(tunnelCreateCount).toBe(1);
    // Verify only one service token was created (not duplicated on retry)
    expect(serviceTokenCreateCount).toBe(1);
    // Verify policies: first attempt created 1 (failed), second attempt created 2 (allow + probe)
    expect(policyCreateCount).toBe(3);
  });

  it("setup output feeds exposure creation with Access app", async () => {
    // This test verifies the seam between runSetup and exposure sync.
    // Setup writes policy IDs; exposure creation reads them to create Access app.
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [{ id: "acc-789", name: "Test Account" }],
      listZones: async () => [{ id: "zone-def", name: "example.org" }],
      listIdentityProviders: async () => [
        { id: "idp-789", name: "Google OAuth", type: "google" },
      ],
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "POST" && path.includes("/cfd_tunnel")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "tunnel-789" } as any;
        }
        if (
          method === "GET" &&
          path.includes("/cfd_tunnel") &&
          path.includes("/token")
        ) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return "tunnel-run-token-789" as any; // bare string: the real Cloudflare shape
        }
        if (method === "POST" && path.includes("/access/service_tokens")) {
          return {
            id: "st-789",
            client_id: "client-789",
            client_secret: PLAINTEXT_SERVICE_SECRET,
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "POST" && path.includes("/access/policies")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: `policy-${randomUUID()}` } as any;
        }
        if (method === "GET" && path.includes("/configurations")) {
          return {
            config: { ingress: [{ service: "http_status:404" }] },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return [] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-789" } as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-789" } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Store a token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    // Store account
    await db
      .insert(settings)
      .values({ key: "cloudflare.accountId", value: "acc-789" });

    // Run setup - this should write policyAllowId and policyProbeId
    const setupRes = await app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: adminCookie },
      payload: { idpId: "idp-789" },
    });

    expect(setupRes.statusCode).toBe(200);

    // Now create an exposure with Access enabled
    const exposureRes = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 9090,
        hostname: "app.example.org",
        zoneId: "zone-def",
        scheme: "http",
        accessEnabled: true,
      },
    });

    expect(exposureRes.statusCode).toBe(201);

    // Verify Access app was created (proves policy IDs were read from setup)
    const accessAppCall = calls.find(
      (c) => c.method === "POST" && c.path.includes("/access/apps"),
    );
    expect(accessAppCall).toBeTruthy();

    // Verify the app was created with both policy IDs
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const appBody = accessAppCall?.body as any;
    expect(appBody?.policies).toBeTruthy();
    expect(appBody.policies).toHaveLength(2);
    // If the keys were transposed, policyAllowId and policyProbeId would be
    // undefined, the guard at sync.ts:115 would skip Access app creation,
    // and this assertion would fail.
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/setup",
      headers: { cookie: viewerCookie },
      payload: { idpId: "idp-xyz" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/exposures", () => {
  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/exposures",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/exposures", () => {
  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: viewerCookie },
      payload: {
        hostPort: 8080,
        hostname: "test.example.com",
        zoneId: "zone-abc",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates exposure and pushes entire ingress array including catch-all", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    // Set up tunnel configuration
    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-123" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-123" },
    ]);

    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "GET" && path.includes("/configurations")) {
          return {
            config: { ingress: [{ service: "http_status:404" }] },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return [] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-123" } as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-123" } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 8080,
        hostname: "test.example.com",
        zoneId: "zone-abc",
        scheme: "http",
        accessEnabled: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();

    // Verify entire ingress array was pushed, including the catch-all
    const putCall = calls.find(
      (c) => c.method === "PUT" && c.path.includes("/configurations"),
    );
    expect(putCall).toBeTruthy();
    expect(putCall?.body).toEqual({
      config: {
        ingress: [
          {
            hostname: "test.example.com",
            service: "http://localhost:8080",
          },
          { service: "http_status:404" },
        ],
      },
    });
  });

  it("creates Access app with stored policy IDs and creates no new policy", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-456" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-456" },
    ]);

    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "GET" && path.includes("/configurations")) {
          return {
            config: { ingress: [{ service: "http_status:404" }] },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return [] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-456" } as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-456" } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 9090,
        hostname: "app.example.com",
        zoneId: "zone-abc",
        accessEnabled: true,
      },
    });

    expect(res.statusCode).toBe(201);

    // Verify no policy was created
    const policyCall = calls.find(
      (c) => c.method === "POST" && c.path.includes("/access/policies"),
    );
    expect(policyCall).toBeUndefined();

    // Verify Access app was created with both stored policy IDs
    const appCall = calls.find(
      (c) => c.method === "POST" && c.path.includes("/access/apps"),
    );
    expect(appCall).toBeTruthy();
    expect(appCall?.body).toEqual({
      name: "app.example.com",
      type: "self_hosted",
      domain: "app.example.com",
      policies: [{ id: "policy-allow-456" }, { id: "policy-probe-456" }],
    });
  });

  it("returns conflict and does not push when remote ingress has drifted", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-123" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-123" },
      {
        key: "cloudflare.lastPushedIngress",
        value: "original-fingerprint-abc",
      },
    ]);

    const calls: Array<{ method: string; path: string }> = [];

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path) => {
        calls.push({ method, path });
        if (method === "GET" && path.includes("/configurations")) {
          // Return different ingress than what we last pushed
          return {
            config: {
              ingress: [
                {
                  hostname: "hand-edited.example.com",
                  service: "http://localhost:9999",
                },
                { service: "http_status:404" },
              ],
            },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 7070,
        hostname: "new.example.com",
        zoneId: "zone-abc",
      },
    });

    // 409, not 500: drift is the operator's to resolve, and a 5xx body is
    // masked to {"error":"internal_error"} so the conflict would not survive
    // the trip to the browser.
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("reconcile_conflict");
    expect(body.conflict).toBe(
      "Remote configuration has been modified outside of Homestead",
    );
    expect(body.detail).toContain("modified outside of Homestead");

    // Verify no PUT was attempted
    const putCall = calls.find(
      (c) => c.method === "PUT" && c.path.includes("/configurations"),
    );
    expect(putCall).toBeUndefined();

    // Verify exposure was created in database (commit first, then converge)
    const allExposures = await db.select().from(exposures);
    expect(allExposures).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    expect(allExposures[0]!.hostname).toBe("new.example.com");
  });

  it("failed push leaves visible row and no orphan resources", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-123" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-123" },
    ]);

    let dnsCreated = false;
    let appCreated = false;
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path) => {
        calls.push({ method, path });
        if (method === "GET" && path.includes("/configurations")) {
          return {
            config: { ingress: [{ service: "http_status:404" }] },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return [] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          dnsCreated = true;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-orphan-123" } as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          appCreated = true;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-orphan-123" } as any;
        }
        if (method === "PUT" && path.includes("/configurations")) {
          throw new Error("Simulated push failure");
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 8888,
        hostname: "orphan-test.example.com",
        zoneId: "zone-abc",
        accessEnabled: true,
      },
    });

    expect(res.statusCode).toBe(500);

    // Verify row exists in database
    const rows = await db.select().from(exposures);
    expect(rows).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    expect(rows[0]!.hostname).toBe("orphan-test.example.com");

    // Verify NO orphan resources created (DNS and Access created in reconcile, not during create)
    expect(dnsCreated).toBe(false);
    expect(appCreated).toBe(false);
  });

  it("two concurrent creates both land", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-123" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-123" },
    ]);

    let currentIngress = [{ service: "http_status:404" }];
    let putCount = 0;

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path, body) => {
        if (method === "GET" && path.includes("/configurations")) {
          return {
            config: { ingress: currentIngress },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "PUT" && path.includes("/configurations")) {
          putCount++;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          const payload = body as any;
          currentIngress = payload.config.ingress;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return {} as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return [] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-concurrent-123" } as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-concurrent-123" } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Fire two creates concurrently
    const [res1, res2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/exposures",
        headers: { cookie: adminCookie },
        payload: {
          hostPort: 9001,
          hostname: "concurrent1.example.com",
          zoneId: "zone-abc",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/exposures",
        headers: { cookie: adminCookie },
        payload: {
          hostPort: 9002,
          hostname: "concurrent2.example.com",
          zoneId: "zone-abc",
        },
      }),
    ]);

    // Both should succeed
    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    // Both exposures should exist in database
    const rows = await db.select().from(exposures);
    expect(rows).toHaveLength(2);

    // Mutex should serialize pushes - two separate pushes, not one interleaved mess
    expect(putCount).toBe(2);

    // Final ingress should contain both hostnames
    expect(currentIngress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostname: "concurrent1.example.com" }),
        expect.objectContaining({ hostname: "concurrent2.example.com" }),
        { service: "http_status:404" },
      ]),
    );
  });

  it("fingerprints actual pushed state, not desired (guards against normalization)", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-123" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-123" },
    ]);

    let pushedIngress: unknown = null;

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path, body) => {
        if (method === "GET" && path.includes("/configurations")) {
          if (pushedIngress) {
            // Return normalized variant: rules reordered and with extra default field
            const original = pushedIngress as {
              config: { ingress: Array<unknown> };
            };
            const rules = [...original.config.ingress];
            // Add a default field Cloudflare might inject
            const normalized = rules.map((r: unknown) => {
              if (typeof r === "object" && r !== null && "hostname" in r) {
                return { ...r, ttl: 1 }; // Cloudflare might add TTL
              }
              return r;
            });
            // Reverse order (some APIs reorder)
            return {
              config: { ingress: normalized.reverse() },
              // biome-ignore lint/suspicious/noExplicitAny: test mock
            } as any;
          }
          return {
            config: { ingress: [{ service: "http_status:404" }] },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "PUT" && path.includes("/configurations")) {
          pushedIngress = body;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return {} as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return [] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-normalize-123" } as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-normalize-123" } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Create exposure - reconcile will push and re-read normalized variant
    const res = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 8080,
        hostname: "normalize-test.example.com",
        zoneId: "zone-abc",
      },
    });

    expect(res.statusCode).toBe(201);

    // Get the normalized variant that getIngress returned
    const client = mockCloudflare();
    const normalizedRemote = (await client.request(
      "GET",
      "/accounts/acc-123/cfd_tunnel/tunnel-123/configurations",
    )) as { config: { ingress: unknown } };

    // Stored fingerprint should equal fingerprint of what getIngress returned
    const [storedRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.lastPushedIngress"));
    expect(storedRow?.value).toBeTruthy();

    const { fingerprint: fpFn } = await import("../cloudflare/reconcile.js");
    const expectedFingerprint = fpFn(normalizedRemote.config.ingress);
    expect(storedRow?.value).toBe(expectedFingerprint);

    // Most important: subsequent checkForClobber against same remote should report no conflict
    const { checkForClobber } = await import("../cloudflare/reconcile.js");
    const check = checkForClobber(
      normalizedRemote.config.ingress,
      storedRow?.value ?? null,
    );
    expect(check.ok).toBe(true);
  });
});

describe("PATCH /api/exposures/:id", () => {
  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/exposures/some-id",
      headers: { cookie: viewerCookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects unknown key with 400 and does not partially write", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    // Set up tunnel configuration
    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-123" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-123" },
    ]);

    // Create an exposure first
    const calls: Array<{ method: string; path: string }> = [];
    let currentIngress = [{ service: "http_status:404" }];

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path, body) => {
        calls.push({ method, path });
        if (method === "GET" && path.includes("/configurations")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { config: { ingress: currentIngress } } as any;
        }
        if (method === "PUT" && path.includes("/configurations")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          const payload = body as any;
          currentIngress = payload.config.ingress;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return {} as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return [] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-123" } as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-123" } as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 5050,
        hostname: "patch-test.example.com",
        zoneId: "zone-abc",
        label: "Original Label",
      },
    });

    expect(createRes.statusCode).toBe(201);
    const { id } = createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/exposures/${id}`,
      headers: { cookie: adminCookie },
      payload: {
        label: "Updated Label",
        unknownField: "should be rejected",
      },
    });

    expect(res.statusCode).toBe(400);

    // Verify label was not updated (no partial write)
    const [exposure] = await db
      .select()
      .from(exposures)
      .where(eq(exposures.id, id));
    expect(exposure?.label).toBe("Original Label");
  });
});

describe("DELETE /api/exposures/:id", () => {
  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/exposures/some-id",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("deletes Access app and DNS record but not shared policies", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    // Set up tunnel configuration
    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-123" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-123" },
    ]);

    const calls: Array<{ method: string; path: string }> = [];
    let currentIngress = [{ service: "http_status:404" }];
    let dnsGetCount = 0;

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path, body) => {
        calls.push({ method, path });
        if (method === "GET" && path.includes("/configurations")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { config: { ingress: currentIngress } } as any;
        }
        if (method === "PUT" && path.includes("/configurations")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          const payload = body as any;
          currentIngress = payload.config.ingress;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return {} as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          dnsGetCount++;
          if (dnsGetCount === 1) {
            // First call during create
            // biome-ignore lint/suspicious/noExplicitAny: test mock
            return [] as any;
          }
          // Second call during delete
          return [
            { id: "dns-delete-123", name: "delete-test.example.com" },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          ] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-delete-123" } as any;
        }
        if (method === "DELETE" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return {} as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-delete-123" } as any;
        }
        if (method === "DELETE" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return {} as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Create an exposure with Access enabled
    const createRes = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 6060,
        hostname: "delete-test.example.com",
        zoneId: "zone-abc",
        accessEnabled: true,
      },
    });

    const { id } = createRes.json();

    // Clear calls from create
    calls.length = 0;

    // Delete the exposure
    const res = await app.inject({
      method: "DELETE",
      url: `/api/exposures/${id}`,
      headers: { cookie: adminCookie },
    });

    expect(res.statusCode).toBe(200);

    // Verify no policy DELETE was called
    expect(
      calls.every(
        (c) => c.method !== "DELETE" || !c.path.includes("/access/policies"),
      ),
    ).toBe(true);

    // Verify Access app was deleted
    const appDeleteCall = calls.find(
      (c) =>
        c.method === "DELETE" && c.path.includes("/access/apps/app-delete-123"),
    );
    expect(appDeleteCall).toBeTruthy();

    // Verify DNS record was deleted
    const dnsDeleteCall = calls.find(
      (c) =>
        c.method === "DELETE" && c.path.includes("/dns_records/dns-delete-123"),
    );
    expect(dnsDeleteCall).toBeTruthy();
  });

  it("delete succeeds when Access app already deleted", async () => {
    // Store encrypted token
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      { key: "cloudflare.policyAllowId", value: "policy-allow-123" },
      { key: "cloudflare.policyProbeId", value: "policy-probe-123" },
    ]);

    const calls: Array<{ method: string; path: string }> = [];
    let currentIngress = [{ service: "http_status:404" }];
    let dnsGetCount = 0;

    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path, body) => {
        calls.push({ method, path });
        if (method === "GET" && path.includes("/configurations")) {
          return {
            config: { ingress: currentIngress },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any;
        }
        if (method === "PUT" && path.includes("/configurations")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          const payload = body as any;
          currentIngress = payload.config.ingress;
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return {} as any;
        }
        if (method === "GET" && path.includes("/dns_records")) {
          dnsGetCount++;
          if (dnsGetCount === 1) {
            // biome-ignore lint/suspicious/noExplicitAny: test mock
            return [] as any;
          }
          return [
            { id: "dns-already-gone-123", name: "already-gone.example.com" },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          ] as any;
        }
        if (method === "POST" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "dns-already-gone-123" } as any;
        }
        if (method === "DELETE" && path.includes("/dns_records")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return {} as any;
        }
        if (method === "POST" && path.includes("/access/apps")) {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return { id: "app-already-gone-123" } as any;
        }
        if (method === "DELETE" && path.includes("/access/apps")) {
          // Simulate app already deleted (404)
          throw new Error("404: Application not found");
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Create an exposure with Access enabled
    const createRes = await app.inject({
      method: "POST",
      url: "/api/exposures",
      headers: { cookie: adminCookie },
      payload: {
        hostPort: 7777,
        hostname: "already-gone.example.com",
        zoneId: "zone-abc",
        accessEnabled: true,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const { id } = createRes.json();

    // Clear calls from create
    calls.length = 0;

    // Delete the exposure - should succeed even though Access app returns 404
    const res = await app.inject({
      method: "DELETE",
      url: `/api/exposures/${id}`,
      headers: { cookie: adminCookie },
    });

    expect(res.statusCode).toBe(200);

    // Verify exposure was deleted from database
    const rows = await db.select().from(exposures);
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/exposures/reconcile", () => {
  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/exposures/reconcile",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses to publish when Access is wanted but no policies are configured", async () => {
    // Fail closed. Without policy ids there is nothing to attach, so pushing
    // would put this hostname on the public internet with no login while its
    // row still says accessEnabled. Refuse before any remote write.
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });
    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.tunnelId", value: "tunnel-123" },
      // policyAllowId and policyProbeId deliberately absent
    ]);
    await db.insert(exposures).values({
      id: randomUUID(),
      hostPort: 8080,
      hostname: "unprotected.example.com",
      zoneId: "zone-abc",
      scheme: "http",
      enabled: true,
      accessEnabled: true,
    });

    const calls: Array<{ method: string; path: string }> = [];
    await app.close();
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      listAccounts: async () => [],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method, path) => {
        calls.push({ method, path });
        if (method === "GET" && path.includes("/configurations")) {
          const empty = {
            config: { ingress: [{ service: "http_status:404" }] },
          };
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          return empty as any;
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/exposures/reconcile",
      headers: { cookie: adminCookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().conflict).toMatch(/unprotected\.example\.com/);
    // Nothing was pushed and no DNS record was touched.
    expect(
      calls.some(
        (c) => c.method === "PUT" && c.path.includes("/configurations"),
      ),
    ).toBe(false);
    expect(calls.some((c) => c.path.includes("/dns_records"))).toBe(false);
  });
});

describe("POST /api/cloudflare/sync-users", () => {
  it("succeeds for an admin when tunnel is configured", async () => {
    await app.close();

    // Mock that returns a valid policy structure
    const mockCloudflare = (): CloudflareClient => ({
      detectTokenKind: async () => "account" as const,
      verifyToken: async () => ({ ok: true }),
      // Non-empty: this test seeds a token through the real route, which now
      // refuses a token that can list no accounts.
      listAccounts: async () => [{ id: "acc-123", name: "Test Account" }],
      listZones: async () => [],
      listIdentityProviders: async () => [],
      request: async (method: string, path: string) => {
        if (method === "GET" && path.includes("/access/policies/")) {
          return {
            include: [{ email: { email: "admin@example.com" } }],
            require: [{ login_method: { id: "idp-xyz" } }],
          };
        }
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        return {} as any;
      },
    });

    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      cloudflare: mockCloudflare,
      docker: createFakeDocker().runner,
    });

    // Ensure users have emailVerified set (better-auth doesn't set this by default)
    await db.update(user).set({ emailVerified: true });

    // Store a token using the API (which encrypts it)
    await app.inject({
      method: "POST",
      url: "/api/cloudflare/token",
      headers: { cookie: adminCookie },
      payload: { token: PLAINTEXT_TOKEN },
    });

    // Set up remaining Cloudflare configuration
    await db.insert(settings).values([
      { key: "cloudflare.accountId", value: "acc-123" },
      { key: "cloudflare.policyAllowId", value: "pol-allow-123" },
      { key: "cloudflare.idpId", value: "idp-xyz" },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/sync-users",
      headers: { cookie: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cloudflare/sync-users",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
