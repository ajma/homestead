# Cloudflare Tunnel and Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a local service at a real hostname, behind a login, without opening a router port.

**Architecture:** SQLite is authoritative and Cloudflare is a projection that gets pushed. One remotely-managed tunnel per instance; one Access application per exposure, referencing two account-level *reusable* policies. Every push is a full rebuild from local state, guarded by clobber-detection that compares remote state against a hash of what Homestead last wrote.

**Tech Stack:** TypeScript ESM, Fastify, Drizzle + libSQL, Zod v4, React + TanStack Query v5, Vitest, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-09-07-cloudflare-tunnel-and-access-design.md`

## Global Constraints

- **`src/server/auth/permissions.ts` is changed in exactly one task (Task 2), adding one resource to `adminRole` and nothing to `viewerRole`.** Homestead holds the Docker socket, so an admin is root-equivalent on the host; this is the one file where a mistake hands over the machine. If a test 403s, the fix is in the test's user setup, never in that file.
- **No test may reach the network, open a socket, resolve a real name, start a container, or use a real timer.** The Cloudflare client takes an injectable `fetch`; every test passes a fake.
- **Credentials never escape.** The API token, the tunnel run token, and the Access service token are encrypted at rest with `encrypt()` from `src/server/crypto/secrets.ts`, never logged, never returned by a route, never rendered into the DOM, never placed in a TanStack Query key.
- `src/web/**` and `e2e/**` must never import from `src/server/**`. `src/shared/**` is browser-safe and imports nothing.
- Import `test` from `e2e/support/fixtures.js`, never `@playwright/test` — Biome-enforced, and a raw import bypasses the container guard.
- **Lint baseline is 0 errors and exactly 6 warnings.** Biome counts formatting violations as errors.
- **Never add a `Co-Authored-By` trailer or any AI-attribution line to a commit.**
- **Verify every mutation actually changed the file by comparing a checksum before and after.** Never `grep … | sed … || echo`: a pipeline's exit status is the last command's, so a pattern matching nothing yields a silent pass indistinguishable from a surviving mutation.
- **Commit a fix before mutating the file it lives in.** `git checkout <file>` restores HEAD and silently discards uncommitted work there.
- Run each gate and read its **actual exit status**. Vitest does not typecheck; a green suite proves nothing about types.
- Never amend a commit. A review packaged against an amended SHA reviews a diff that no longer exists.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/cloudflare.ts` | Browser-safe types: `ExposureSummary`, `ZoneOption`, `IdpOption`, `TunnelRuntime`, `SyncState`. Zero imports. |
| `src/server/db/schema.ts` | `exposures` table (modify). |
| `src/server/auth/permissions.ts` | The `exposure` resource (modify, Task 2 only). |
| `src/server/cloudflare/client.ts` | Thin HTTP wrapper over the Cloudflare REST API. Injectable `fetch`. No business logic. |
| `src/server/cloudflare/tunnel.ts` | Tunnel creation, run token, ingress push, DNS records. |
| `src/server/cloudflare/access.ts` | Reusable policies, applications, service tokens. |
| `src/server/cloudflare/reconcile.ts` | Desired-state builders and clobber-detection for both ingress and the allow policy. |
| `src/server/cloudflare/runtime.ts` | Adopt an existing `cloudflared`, or deploy one as a Homestead project. |
| `src/server/monitoring/checks.ts` | The `reachability` executor (modify). |
| `src/server/routes/cloudflare.ts` | Setup and exposure routes. |
| `src/web/routes/Exposures.tsx` | The exposure list and editor. |
| `src/web/routes/CloudflareSetup.tsx` | The setup wizard. |

---

## Task 1: Schema and shared types

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: `src/shared/cloudflare.ts`
- Test: `src/server/db/schema.test.ts` (modify)

**Interfaces:**
- Produces: the `exposures` table; `ExposureSummary`, `ZoneOption`, `IdpOption`, `TunnelRuntime`, `SyncState`.

- [ ] **Step 1: Write the failing test**

Add to `src/server/db/schema.test.ts`:

```typescript
it("stores an exposure with a nullable project and Access on by default", async () => {
  const db = createDb(":memory:");
  await runMigrations(db);
  await db.insert(exposures).values({
    id: "e1",
    projectSlug: null,
    hostPort: 8080,
    zoneId: "z1",
    hostname: "app.example.com",
    scheme: "http",
  });
  const [row] = await db.select().from(exposures);
  expect(row).toMatchObject({
    projectSlug: null,
    hostPort: 8080,
    accessEnabled: true,
    enabled: true,
    noTlsVerify: false,
    accessAppId: null,
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/server/db/schema.test.ts`
Expected: FAIL — `exposures` is not exported.

- [ ] **Step 3: Add the table**

In `src/server/db/schema.ts`:

```typescript
export const exposures = sqliteTable(
  "exposures",
  {
    id: text("id").primaryKey(),
    /**
     * Nullable: an exposure is fundamentally "host port -> hostname", so a bare
     * host service or an unmanaged stack can be tunnelled.
     */
    projectSlug: text("project_slug"),
    /**
     * The join key across exposures, tiles and probes. No service name is
     * stored: it is derived from `docker compose config` at read time, because
     * storing a derivation beside its source lets the two drift.
     */
    hostPort: integer("host_port").notNull(),
    zoneId: text("zone_id").notNull(),
    hostname: text("hostname").notNull().unique(),
    scheme: text("scheme").notNull().default("http"),
    /** Unifi and Proxmox serve HTTPS with a self-signed cert; cloudflared refuses those by default. */
    noTlsVerify: integer("no_tls_verify", { mode: "boolean" })
      .notNull()
      .default(false),
    label: text("label"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    accessEnabled: integer("access_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    accessAppId: text("access_app_id"),
  },
  (t) => [index("exposures_port_idx").on(t.hostPort)],
);
```

- [ ] **Step 4: Create the shared types**

`src/shared/cloudflare.ts` — zero imports, browser-safe:

```typescript
export type Scheme = "http" | "https";

/**
 * Sync state belongs to the instance, not to a single exposure. Ingress is
 * pushed as one whole array, so a failed or conflicted push leaves every
 * exposure unpushed together — a per-exposure flag would imply a granularity
 * the API does not have.
 */
export type SyncState = "synced" | "pending" | "conflict" | "error";

export type ExposureSummary = {
  id: string;
  projectSlug: string | null;
  serviceName: string | null;
  hostPort: number;
  hostname: string;
  scheme: Scheme;
  noTlsVerify: boolean;
  label: string | null;
  enabled: boolean;
  accessEnabled: boolean;
};

export type ZoneOption = { id: string; name: string };
export type IdpOption = { id: string; name: string; type: string };

/** How cloudflared is running: adopted from an existing container, or deployed by us. */
export type TunnelRuntime =
  | { kind: "none" }
  | { kind: "adopted"; containerId: string }
  | { kind: "deployed"; projectSlug: string };
```

- [ ] **Step 5: Generate and inspect the migration**

Run: `npx drizzle-kit generate`

Open the generated `drizzle/0007_*.sql` **before committing**. It must contain exactly one `CREATE TABLE exposures`, one `CREATE INDEX`, and one unique index on `hostname`. If it contains `ALTER` or `DROP` against any existing table, stop and report — the snapshot and journal have diverged.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/server/db && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/schema.ts src/shared/cloudflare.ts src/server/db/schema.test.ts drizzle
git commit -m "feat(db): add the exposures table"
```

---

## Task 2: Permissions

**Files:**
- Modify: `src/server/auth/permissions.ts`
- Test: `src/server/auth/permissions.test.ts`

**This is the only task that touches `permissions.ts`.** The whole diff is two lines.

- [ ] **Step 1: Write the failing tests**

```typescript
it("gives an admin full control of exposures", () => {
  for (const action of ["read", "create", "update", "delete"] as const) {
    expect(
      roles.admin.authorize({ exposure: [action] }).success,
      `admin should have exposure:${action}`,
    ).toBe(true);
  }
});

it("gives a viewer no exposure permission at all", () => {
  // A hostname is a map of what this household runs and where it is reachable.
  for (const action of ["read", "create", "update", "delete"] as const) {
    expect(
      roles.viewer.authorize({ exposure: [action] }).success,
      `viewer must not have exposure:${action}`,
    ).toBe(false);
  }
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/auth/permissions.test.ts`
Expected: FAIL — `exposure` is not in the statement.

- [ ] **Step 3: Add the resource**

Two lines. Add `exposure: ["read", "create", "update", "delete"]` to the `statement` object, and the same to `adminRole`. **Add nothing to `viewerRole`.**

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/auth && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Prove the viewer test discriminates**

Grant `exposure: ["read"]` to `viewerRole`, confirm the viewer test fails, and revert. Compare a file checksum before and after to prove the edit applied. Report the failure message.

- [ ] **Step 6: Commit**

```bash
git add src/server/auth/permissions.ts src/server/auth/permissions.test.ts
git commit -m "feat(auth): add admin-only exposure permissions"
```

---

## Task 3: The Cloudflare API client

**Files:**
- Create: `src/server/cloudflare/client.ts`
- Test: `src/server/cloudflare/client.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type CloudflareClient = {
    verifyToken(): Promise<{ ok: true } | { ok: false; missingScopes: string[] }>;
    listAccounts(): Promise<{ id: string; name: string }[]>;
    listZones(accountId: string): Promise<ZoneOption[]>;
    listIdentityProviders(accountId: string): Promise<IdpOption[]>;
    request<T>(method: string, path: string, body?: unknown): Promise<T>;
  };
  export function createCloudflareClient(opts: {
    token: string;
    fetch?: typeof fetch;
  }): CloudflareClient;
  ```

This module is a thin HTTP wrapper. It holds **no** business logic — later tasks build on `request`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it, vi } from "vitest";
import { createCloudflareClient } from "./client.js";

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, result, errors: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("createCloudflareClient", () => {
  it("sends the token as a bearer header", async () => {
    const f = vi.fn(async () => ok([]));
    await createCloudflareClient({ token: "sekrit", fetch: f }).listAccounts();
    const init = f.mock.calls[0]?.[1] as RequestInit;
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer sekrit");
  });

  it("never puts the token in a thrown error", async () => {
    // An error surfaces in logs and in a 500 body. A credential must not ride along.
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }),
          { status: 403 },
        ),
    );
    const client = createCloudflareClient({ token: "sekrit", fetch: f });
    await expect(client.listAccounts()).rejects.toThrow(/Authentication error/);
    await expect(client.listAccounts()).rejects.not.toThrow(/sekrit/);
  });

  it("reports the scopes a token is missing rather than a bare failure", async () => {
    const f = vi.fn(async (url: string) =>
      String(url).includes("/accounts")
        ? new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: "Unauthorized" }] }), { status: 403 })
        : ok([]),
    );
    const r = await createCloudflareClient({ token: "t", fetch: f }).verifyToken();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingScopes.length).toBeGreaterThan(0);
  });

  it("surfaces a Cloudflare error body rather than a bare status", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 1003, message: "Invalid zone" }] }), { status: 400 }),
    );
    await expect(
      createCloudflareClient({ token: "t", fetch: f }).listZones("a"),
    ).rejects.toThrow(/Invalid zone/);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/cloudflare/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`request` posts to `https://api.cloudflare.com/client/v4{path}` with
`Authorization: Bearer <token>` and `content-type: application/json`. Cloudflare
returns `{ success, result, errors: [{ code, message }] }` with a 200 even for some
failures, so **check `success`, not just the HTTP status**. On failure, throw an
error carrying the joined `errors[].message` and the status — and nothing else.
Never interpolate the token into a message.

`verifyToken` probes the endpoints the plan needs and maps a 403 on each to the
scope that would grant it, returning the list. `listAccounts`, `listZones` and
`listIdentityProviders` are thin `request` calls returning the mapped fields only.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/cloudflare && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Prove no test reaches the network**

Set `globalThis.fetch` to a function that throws, run `pnpm vitest run src/server/cloudflare`, and confirm it still passes. Report what you observed.

- [ ] **Step 6: Commit**

```bash
git add src/server/cloudflare/client.ts src/server/cloudflare/client.test.ts
git commit -m "feat(cloudflare): add the API client"
```

---

## Task 4: Tunnel, ingress and DNS

**Files:**
- Create: `src/server/cloudflare/tunnel.ts`
- Test: `src/server/cloudflare/tunnel.test.ts`

**Interfaces:**
- Consumes: `CloudflareClient` (Task 3).
- Produces:
  ```typescript
  export type IngressRule = {
    hostname?: string;
    service: string;
    originRequest?: { noTLSVerify?: boolean };
  };
  export async function createTunnel(c: CloudflareClient, accountId: string, name: string): Promise<{ id: string }>;
  export async function getTunnelToken(c: CloudflareClient, accountId: string, tunnelId: string): Promise<string>;
  export async function getIngress(c: CloudflareClient, accountId: string, tunnelId: string): Promise<IngressRule[]>;
  export async function putIngress(c: CloudflareClient, accountId: string, tunnelId: string, rules: IngressRule[]): Promise<void>;
  export async function upsertDnsRecord(c: CloudflareClient, zoneId: string, hostname: string, tunnelId: string): Promise<void>;
  export async function deleteDnsRecord(c: CloudflareClient, zoneId: string, hostname: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
it("creates a remotely-managed tunnel", async () => {
  const c = fakeClient({ "POST /accounts/a/cfd_tunnel": { id: "t1" } });
  const r = await createTunnel(c, "a", "homestead");
  expect(r.id).toBe("t1");
  expect(c.calls[0]?.body).toMatchObject({ config_src: "cloudflare" });
});

it("always ends the ingress array with a catch-all", async () => {
  // cloudflared rejects a configuration whose last rule is not a catch-all.
  const c = fakeClient({});
  await putIngress(c, "a", "t1", [
    { hostname: "app.example.com", service: "http://localhost:8080" },
  ]);
  const sent = c.calls[0]?.body as { config: { ingress: IngressRule[] } };
  expect(sent.config.ingress.at(-1)).toEqual({ service: "http_status:404" });
});

it("does not add a second catch-all when one is already present", async () => {
  const c = fakeClient({});
  await putIngress(c, "a", "t1", [
    { hostname: "a.example.com", service: "http://localhost:1" },
    { service: "http_status:404" },
  ]);
  const sent = c.calls[0]?.body as { config: { ingress: IngressRule[] } };
  expect(sent.config.ingress.filter((r) => !r.hostname)).toHaveLength(1);
});

it("passes noTLSVerify through for a self-signed origin", async () => {
  const c = fakeClient({});
  await putIngress(c, "a", "t1", [
    { hostname: "unifi.example.com", service: "https://localhost:8443", originRequest: { noTLSVerify: true } },
  ]);
  const sent = c.calls[0]?.body as { config: { ingress: IngressRule[] } };
  expect(sent.config.ingress[0]?.originRequest).toEqual({ noTLSVerify: true });
});

it("points the DNS record at the tunnel and proxies it", async () => {
  const c = fakeClient({ "GET /zones/z1/dns_records": [] });
  await upsertDnsRecord(c, "z1", "app.example.com", "t1");
  const post = c.calls.find((k) => k.method === "POST");
  expect(post?.body).toMatchObject({
    type: "CNAME",
    name: "app.example.com",
    content: "t1.cfargotunnel.com",
    proxied: true,
  });
});

it("updates an existing DNS record rather than creating a duplicate", async () => {
  const c = fakeClient({ "GET /zones/z1/dns_records": [{ id: "r1", name: "app.example.com" }] });
  await upsertDnsRecord(c, "z1", "app.example.com", "t1");
  expect(c.calls.some((k) => k.method === "POST")).toBe(false);
  expect(c.calls.some((k) => k.method === "PATCH" || k.method === "PUT")).toBe(true);
});
```

Write `fakeClient` in the test file: it records `{ method, path, body }` on a `calls`
array and returns canned results keyed by `"METHOD /path"`.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/cloudflare/tunnel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`putIngress` appends `{ service: "http_status:404" }` only when the last rule has no
`hostname`. It PUTs to `/accounts/{acct}/cfd_tunnel/{id}/configurations` with
`{ config: { ingress: rules } }`.

`upsertDnsRecord` lists records filtered by name, then PATCHes the match or POSTs a
new `CNAME` to `{tunnelId}.cfargotunnel.com` with `proxied: true`.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/cloudflare && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/cloudflare/tunnel.ts src/server/cloudflare/tunnel.test.ts
git commit -m "feat(cloudflare): add tunnel, ingress and DNS operations"
```

---

## Task 5: Access policies, applications and the service token

**Files:**
- Create: `src/server/cloudflare/access.ts`
- Test: `src/server/cloudflare/access.test.ts`

**Interfaces:**
- Consumes: `CloudflareClient` (Task 3).
- Produces:
  ```typescript
  export type PolicyRule = Record<string, Record<string, string>>;
  export async function createAllowPolicy(c: CloudflareClient, accountId: string, idpId: string, emails: string[]): Promise<{ id: string }>;
  export async function updateAllowPolicy(c: CloudflareClient, accountId: string, policyId: string, idpId: string, emails: string[]): Promise<void>;
  export async function getPolicy(c: CloudflareClient, accountId: string, policyId: string): Promise<{ include: PolicyRule[]; require: PolicyRule[] }>;
  export async function createProbePolicy(c: CloudflareClient, accountId: string, serviceTokenId: string): Promise<{ id: string }>;
  export async function createServiceToken(c: CloudflareClient, accountId: string, name: string): Promise<{ id: string; clientId: string; clientSecret: string }>;
  export async function createApp(c: CloudflareClient, accountId: string, hostname: string, policyIds: string[]): Promise<{ id: string }>;
  export async function deleteApp(c: CloudflareClient, accountId: string, appId: string): Promise<void>;
  ```

**The `include` / `require` split is the security-critical detail of this whole plan.** Cloudflare treats `include` as *any of* and `require` as *all of*. Emails go in `include`; the identity provider goes in `require`. Putting the provider in `include` means "a listed email **or** anyone who can log in through this provider" — with a public provider, that is the entire internet, on a hostname the UI reports as protected.

- [ ] **Step 1: Write the failing tests**

```typescript
it("puts emails in include and the identity provider in require", async () => {
  // include is ANY-of and require is ALL-of. Swapping them admits anyone who can
  // authenticate with the provider at all, which for a public IdP is everyone.
  const c = fakeClient({ "POST /accounts/a/access/policies": { id: "p1" } });
  await createAllowPolicy(c, "a", "idp1", ["me@example.com", "you@example.com"]);
  const body = c.calls[0]?.body as { include: PolicyRule[]; require: PolicyRule[] };
  expect(body.include).toEqual([
    { email: { email: "me@example.com" } },
    { email: { email: "you@example.com" } },
  ]);
  expect(body.require).toEqual([{ login_method: { id: "idp1" } }]);
});

it("never places the identity provider in include", async () => {
  const c = fakeClient({ "POST /accounts/a/access/policies": { id: "p1" } });
  await createAllowPolicy(c, "a", "idp1", ["me@example.com"]);
  const body = c.calls[0]?.body as { include: PolicyRule[] };
  expect(JSON.stringify(body.include)).not.toContain("login_method");
});

it("creates the probe policy as a non-identity service-auth rule", async () => {
  const c = fakeClient({ "POST /accounts/a/access/policies": { id: "p2" } });
  await createProbePolicy(c, "a", "st1");
  const body = c.calls[0]?.body as { decision: string; include: PolicyRule[] };
  expect(body.decision).toBe("non_identity");
  expect(body.include).toEqual([{ service_token: { token_id: "st1" } }]);
});

it("creates a self-hosted app that references policies by id", async () => {
  const c = fakeClient({ "POST /accounts/a/access/apps": { id: "app1" } });
  await createApp(c, "a", "app.example.com", ["p1", "p2"]);
  const body = c.calls[0]?.body as { type: string; domain: string; policies: { id: string }[] };
  expect(body.type).toBe("self_hosted");
  expect(body.domain).toBe("app.example.com");
  expect(body.policies).toEqual([{ id: "p1" }, { id: "p2" }]);
});

it("deleting an app does not delete any policy", async () => {
  // Cloudflare deletes a LEGACY inline policy when it is detached from an app.
  // Reusable policies must survive, or removing one exposure destroys access for all.
  const c = fakeClient({});
  await deleteApp(c, "a", "app1");
  expect(c.calls.every((k) => !k.path.includes("/access/policies"))).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/cloudflare/access.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`createAllowPolicy` POSTs to `/accounts/{acct}/access/policies` with
`{ name: "Homestead — allowed users", decision: "allow", include: emails.map(...), require: [{ login_method: { id: idpId } }] }`.

`createProbePolicy` POSTs `{ name: "Homestead — probe", decision: "non_identity", include: [{ service_token: { token_id } }] }`.

`createApp` POSTs `{ name, type: "self_hosted", domain: hostname, policies: policyIds.map((id) => ({ id })) }`.

`deleteApp` DELETEs the app and touches nothing else.

`createServiceToken` POSTs to `/accounts/{acct}/access/service_tokens` and returns
`client_id` and `client_secret`. **The secret is returned once, at creation, and
never again** — the caller must persist it immediately.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/cloudflare && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Prove the include/require test discriminates**

Swap the two fields so the provider lands in `include`, confirm both of the first
two tests fail, and revert. Compare a file checksum before and after to prove the
edit applied. Report the messages.

- [ ] **Step 6: Commit**

```bash
git add src/server/cloudflare/access.ts src/server/cloudflare/access.test.ts
git commit -m "feat(cloudflare): add reusable Access policies, apps and service tokens"
```

---

## Task 6: The reconciler

**Files:**
- Create: `src/server/cloudflare/reconcile.ts`
- Test: `src/server/cloudflare/reconcile.test.ts`

**Interfaces:**
- Consumes: `IngressRule` (Task 4), `PolicyRule` (Task 5).
- Produces:
  ```typescript
  export type ExposureRow = {
    hostname: string; hostPort: number; scheme: "http" | "https";
    noTlsVerify: boolean; enabled: boolean;
  };
  export function desiredIngress(rows: ExposureRow[]): IngressRule[];
  export function fingerprint(value: unknown): string;
  export type ConflictCheck =
    | { ok: true }
    | { ok: false; reason: string };
  export function checkForClobber(remote: unknown, lastWrittenFingerprint: string | null): ConflictCheck;
  ```

Pure functions over data. No client, no database, no clock.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("desiredIngress", () => {
  it("emits one rule per enabled exposure, then a catch-all", () => {
    const rules = desiredIngress([
      { hostname: "a.example.com", hostPort: 1, scheme: "http", noTlsVerify: false, enabled: true },
      { hostname: "b.example.com", hostPort: 2, scheme: "https", noTlsVerify: true, enabled: true },
    ]);
    expect(rules).toEqual([
      { hostname: "a.example.com", service: "http://localhost:1" },
      { hostname: "b.example.com", service: "https://localhost:2", originRequest: { noTLSVerify: true } },
      { service: "http_status:404" },
    ]);
  });

  it("omits a disabled exposure", () => {
    // The whole array is replaced on every push, so a disabled row must be
    // absent rather than merely unreferenced.
    const rules = desiredIngress([
      { hostname: "off.example.com", hostPort: 1, scheme: "http", noTlsVerify: false, enabled: false },
    ]);
    expect(rules).toEqual([{ service: "http_status:404" }]);
  });

  it("produces a lone catch-all when there are no exposures", () => {
    expect(desiredIngress([])).toEqual([{ service: "http_status:404" }]);
  });
});

describe("checkForClobber", () => {
  it("passes when remote matches what we last wrote", () => {
    const remote = [{ service: "http_status:404" }];
    expect(checkForClobber(remote, fingerprint(remote))).toEqual({ ok: true });
  });

  it("passes on a first push, when we have written nothing yet", () => {
    expect(checkForClobber([{ service: "http_status:404" }], null).ok).toBe(true);
  });

  it("refuses when remote has drifted from what we last wrote", () => {
    // Someone added a rule in the Cloudflare dashboard. A full-replace push
    // would delete it silently.
    const written = [{ service: "http_status:404" }];
    const remote = [
      { hostname: "manual.example.com", service: "http://localhost:9" },
      { service: "http_status:404" },
    ];
    const r = checkForClobber(remote, fingerprint(written));
    expect(r.ok).toBe(false);
  });

  it("compares against what we wrote, not against what we now want", () => {
    // The distinction is the whole point: a local edit changes desired state and
    // must NOT read as foreign drift, or every push raises a false conflict.
    const written = [{ service: "http_status:404" }];
    const remoteUnchanged = [{ service: "http_status:404" }];
    expect(checkForClobber(remoteUnchanged, fingerprint(written)).ok).toBe(true);
  });

  it("is insensitive to key order", () => {
    const a = [{ hostname: "x.example.com", service: "http://localhost:1" }];
    const b = [{ service: "http://localhost:1", hostname: "x.example.com" }];
    expect(checkForClobber(b, fingerprint(a)).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/cloudflare/reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`desiredIngress` filters to enabled rows, maps each to
`{ hostname, service: `${scheme}://localhost:${hostPort}` }`, adds
`originRequest: { noTLSVerify: true }` only when `noTlsVerify` is set, and appends
the catch-all.

`fingerprint` serialises with **sorted keys** and hashes with SHA-256, so key order
from the API cannot fake a conflict.

`checkForClobber` returns `{ ok: true }` when `lastWrittenFingerprint` is null,
otherwise compares it to `fingerprint(remote)` and returns a reason on mismatch.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/cloudflare && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Prove the drift test discriminates**

Make `checkForClobber` always return `{ ok: true }`, confirm the drift test fails,
and revert. Checksum before and after. Report the message.

- [ ] **Step 6: Commit**

```bash
git add src/server/cloudflare/reconcile.ts src/server/cloudflare/reconcile.test.ts
git commit -m "feat(cloudflare): add desired-state and clobber detection"
```

---

## Task 7: The `cloudflared` runtime

**Files:**
- Create: `src/server/cloudflare/runtime.ts`
- Test: `src/server/cloudflare/runtime.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type RuntimeDeps = {
    listContainers: () => Promise<{ id: string; image: string }[]>;
    writeProject: (slug: string, files: Record<string, string>) => Promise<void>;
  };
  export async function detectRuntime(deps: RuntimeDeps): Promise<TunnelRuntime>;
  export async function deployTunnel(deps: RuntimeDeps, runToken: string): Promise<TunnelRuntime>;
  ```

Both dependencies are injected so **no test starts a container or writes outside a temp directory**.

- [ ] **Step 1: Write the failing tests**

```typescript
it("detects an existing cloudflared container for adoption", async () => {
  const r = await detectRuntime({
    listContainers: async () => [{ id: "c1", image: "cloudflare/cloudflared:latest" }],
    writeProject: async () => {},
  });
  expect(r).toEqual({ kind: "adopted", containerId: "c1" });
});

it("reports none when nothing is running", async () => {
  const r = await detectRuntime({ listContainers: async () => [], writeProject: async () => {} });
  expect(r).toEqual({ kind: "none" });
});

it("does not mistake an unrelated container for cloudflared", async () => {
  const r = await detectRuntime({
    listContainers: async () => [{ id: "c9", image: "nginx:latest" }],
    writeProject: async () => {},
  });
  expect(r.kind).toBe("none");
});

it("deploys a host-network project carrying the token in .env", async () => {
  const written: Record<string, string> = {};
  const r = await deployTunnel(
    { listContainers: async () => [], writeProject: async (_s, files) => Object.assign(written, files) },
    "RUNTOKEN",
  );
  expect(r).toEqual({ kind: "deployed", projectSlug: "homestead-tunnel" });
  expect(written["compose.yaml"]).toContain("network_mode: host");
  expect(written["compose.yaml"]).toContain("x-homestead");
  expect(written[".env"]).toContain("RUNTOKEN");
});

it("keeps the run token out of the compose file", async () => {
  // compose.yaml is readable by anything that can read the projects directory
  // and is shown in the editor UI; .env is treated as a secret everywhere else.
  const written: Record<string, string> = {};
  await deployTunnel(
    { listContainers: async () => [], writeProject: async (_s, files) => Object.assign(written, files) },
    "RUNTOKEN",
  );
  expect(written["compose.yaml"]).not.toContain("RUNTOKEN");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/cloudflare/runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`detectRuntime` matches an image name containing `cloudflared`.

`deployTunnel` writes two files under the slug `homestead-tunnel`:

```yaml
# compose.yaml
x-homestead:
  system: true
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    network_mode: host
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
```

and `.env` containing `TUNNEL_TOKEN=<runToken>`.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/cloudflare && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/cloudflare/runtime.ts src/server/cloudflare/runtime.test.ts
git commit -m "feat(cloudflare): detect or deploy the cloudflared runtime"
```

---

## Task 8: The reachability monitor type

**Files:**
- Modify: `src/server/monitoring/checks.ts`, `src/shared/monitoring.ts`
- Test: `src/server/monitoring/checks.test.ts`

**Interfaces:**
- Consumes: the `CheckExecutor` contract from the monitoring plan —
  `(config: unknown, timeoutMs: number, ctx: CheckContext) => Promise<CheckResult>`.
- Produces: `MonitorType` gains `"reachability"`; `executors.reachability`.

`MonitorType` is a closed union, so `executors: Record<MonitorType, CheckExecutor>` will not compile until the new executor is registered. That is the intended safety net.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("reachability executor", () => {
  it("sends the Access service-token headers", async () => {
    const f = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await executors.reachability(
      { url: "https://app.example.com", clientId: "cid", clientSecret: "csecret" },
      1000,
      ctx(),
    );
    const init = f.mock.calls[0]?.[1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h["CF-Access-Client-Id"]).toBe("cid");
    expect(h["CF-Access-Client-Secret"]).toBe("csecret");
    vi.unstubAllGlobals();
  });

  it("is down when Access bounces the probe to a login page", async () => {
    // Without the service token this is what every probe would see, and calling
    // it up would report a crashed app behind a working tunnel as healthy.
    const f = vi.fn(
      async () =>
        new Response("", { status: 302, headers: { location: "https://x.cloudflareaccess.com/login" } }),
    );
    vi.stubGlobal("fetch", f);
    const r = await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "s" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/access/i);
    vi.unstubAllGlobals();
  });

  it("is up on a 2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const r = await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "s" },
      1000,
      ctx(),
    );
    expect(r.up).toBe(true);
    vi.unstubAllGlobals();
  });

  it("reports a bad config as a failed check, not a thrown error", async () => {
    const r = await executors.reachability({ url: 123 }, 1000, ctx());
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/config/i);
  });

  it("never puts the client secret in the error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const r = await executors.reachability(
      { url: "https://app.example.com", clientId: "c", clientSecret: "SEKRIT" },
      1000,
      ctx(),
    );
    expect(r.error ?? "").not.toContain("SEKRIT");
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/monitoring/checks.test.ts`
Expected: FAIL — `executors.reachability` is undefined.

- [ ] **Step 3: Implement**

Add `"reachability"` to `MonitorType` in `src/shared/monitoring.ts`. Add the
executor: parse `{ url, clientId, clientSecret }` with Zod, `fetch` with
`redirect: "manual"`, `AbortSignal.timeout(timeoutMs)`, and the two `CF-Access-*`
headers. A 2xx is up. A 3xx whose `location` host ends in `cloudflareaccess.com` is
down with an Access-specific message. Anything else is down with the status.
Measure `durationMs` with `performance.now()`.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/monitoring && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Prove the redirect test discriminates**

Remove the `cloudflareaccess.com` branch so a 302 falls through, confirm that test
fails, and revert. Checksum before and after. Report the message.

- [ ] **Step 6: Commit**

```bash
git add src/server/monitoring/checks.ts src/server/monitoring/checks.test.ts src/shared/monitoring.ts
git commit -m "feat(monitoring): add the reachability check through Access"
```

---

## Task 9: Setup routes

**Files:**
- Create: `src/server/routes/cloudflare.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/routes/cloudflare.test.ts`

**Interfaces:**
- Produces, all `[settings:write]` except the first, which is `[settings:read]`:
  - `GET /api/cloudflare/status` → `{ configured, accountId, tunnelId, runtime, idpId, syncState }`
  - `POST /api/cloudflare/token` → verifies, stores encrypted, returns `{ accounts }`
  - `POST /api/cloudflare/account` → `{ accountId }`, returns `{ zones, idps }`
  - `POST /api/cloudflare/setup` → `{ idpId }`; creates tunnel, both reusable policies, the service token, and the runtime; returns `{ tunnelId, runtime }`

- [ ] **Step 1: Write the failing tests**

Follow the harness in `src/server/routes/devices.test.ts`. Cover at minimum:

- A viewer is refused **every** route — one test per route, not one representative.
- `POST /api/cloudflare/token` with an invalid token returns 400 naming the missing scopes, and **stores nothing**.
- A stored token does not contain the plaintext:
  ```typescript
  const [row] = await db.select().from(settings).where(eq(settings.key, "cloudflare.apiToken"));
  expect(row?.value).not.toContain(PLAINTEXT_TOKEN);
  ```
- `POST /api/cloudflare/setup` with an account that has **no identity provider** returns 400 and creates no tunnel. This is the safety branch from spec §4.3: continuing would produce hostnames the UI calls protected while they are not.
- A successful setup stores the service-token secret encrypted, and the response body contains neither the API token nor the service-token secret.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/routes/cloudflare.test.ts`
Expected: FAIL — routes unregistered.

- [ ] **Step 3: Implement**

Register in `src/server/app.ts` alongside the existing modules, passing `db`,
`secretKey`, and an injectable `cloudflare` client factory defaulting to
`createCloudflareClient` so tests never reach the network.

**Verify before persisting**, as the Tailscale settings route already does: a token
is stored only after `verifyToken` succeeds, and setup is committed only after the
tunnel and both policies exist. Storing first leaves a broken credential the runner
retries forever.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Verify `permissions.ts` is untouched**

```bash
git diff --quiet HEAD -- src/server/auth/permissions.ts && echo UNCHANGED
```

Expected: `UNCHANGED`.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/cloudflare.ts src/server/routes/cloudflare.test.ts src/server/app.ts
git commit -m "feat(api): add Cloudflare setup routes"
```

---

## Task 10: Exposure routes

**Files:**
- Modify: `src/server/routes/cloudflare.ts`
- Test: `src/server/routes/cloudflare.test.ts`

**Interfaces:**
- Produces, all admin-only:
  - `GET /api/exposures` → `{ exposures: ExposureSummary[] }`
  - `POST /api/exposures` `[exposure:create]` → 201 `{ id }`
  - `PATCH /api/exposures/:id` `[exposure:update]` → `{ ok: true }`
  - `DELETE /api/exposures/:id` `[exposure:delete]` → `{ ok: true }`
  - `POST /api/exposures/reconcile` `[exposure:update]` → `{ ok: true } | { conflict: string }`

- [ ] **Step 1: Write the failing tests**

Cover at minimum:

- A viewer is refused every route, one test per route.
- Creating an exposure pushes the **entire** ingress array, and the assertion checks
  the whole array including the catch-all — asserting only that the new hostname
  appears would pass while silently dropping every other exposure.
- Creating with `accessEnabled: true` creates an Access application referencing the
  two stored policy ids, and **creates no new policy**.
- **Deleting an exposure deletes its app and DNS record but neither shared policy:**
  ```typescript
  await app.inject({ method: "DELETE", url: `/api/exposures/${id}`, headers: { cookie: adminCookie } });
  expect(fake.calls.every((c) => c.method !== "DELETE" || !c.path.includes("/access/policies"))).toBe(true);
  ```
- When remote ingress has drifted, a create returns a conflict and **does not push**.
- `PATCH` rejects an unknown key with 400 rather than ignoring it, and does not
  partially write.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/routes/cloudflare.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Each mutation runs inside a transaction: write SQLite, build `desiredIngress`, run
`checkForClobber` against remote, push, store the new fingerprint. A conflict aborts
the transaction and returns the reason.

Derive `serviceName` for the response from `docker compose config` when
`projectSlug` is set, falling back to `label`. Never store it.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/cloudflare.ts src/server/routes/cloudflare.test.ts
git commit -m "feat(api): add exposure routes with reconciliation"
```

---

## Task 11: Allow-policy sync

**Files:**
- Modify: `src/server/routes/cloudflare.ts`, `src/server/index.ts`
- Create: `src/server/cloudflare/sync-users.ts`
- Test: `src/server/cloudflare/sync-users.test.ts`

**Interfaces:**
- Produces: `syncAllowPolicy(db, client, accountId, policyId, idpId): Promise<{ synced: boolean; conflict?: string }>`

- [ ] **Step 1: Write the failing tests**

```typescript
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { settings, user } from "../db/schema.js";
import { fingerprint } from "./reconcile.js";
import { syncAllowPolicy } from "./sync-users.js";

/** Emails become `include` rules; the IdP is a `require` rule (never `include`). */
const policyBody = (emails: string[]) => ({
  include: emails.map((email) => ({ email: { email } })),
  require: [{ login_method: { id: "idp1" } }],
});

async function seedUsers(
  admins: string[],
  viewers: string[] = [],
): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db);
  let n = 0;
  for (const [role, list] of [
    ["admin", admins],
    ["viewer", viewers],
  ] as const) {
    for (const email of list) {
      n += 1;
      await db
        .insert(user)
        .values({ id: `u${n}`, name: email, email, role, emailVerified: true });
    }
  }
  return db;
}

async function setFingerprint(db: Db, emails: string[]): Promise<void> {
  await db.insert(settings).values({
    key: "cloudflare.lastPushedPolicy",
    value: fingerprint(policyBody(emails)),
  });
}

describe("syncAllowPolicy", () => {
  it("rewrites the policy to match Homestead's users", async () => {
    const db = await seedUsers(["a@example.com", "b@example.com"]);
    await setFingerprint(db, ["a@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody(["a@example.com"]),
    });
    const r = await syncAllowPolicy(db, c, "a", "p1", "idp1");
    expect(r.synced).toBe(true);
    const put = c.calls.find((k) => k.method === "PUT");
    const body = put?.body as ReturnType<typeof policyBody>;
    expect(body.include).toEqual([
      { email: { email: "a@example.com" } },
      { email: { email: "b@example.com" } },
    ]);
    expect(body.require).toEqual([{ login_method: { id: "idp1" } }]);
  });

  it("includes viewers as well as admins", async () => {
    // Access governs reaching the published app, not administering Homestead.
    const db = await seedUsers(["admin@example.com"], ["viewer@example.com"]);
    await setFingerprint(db, ["admin@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody(["admin@example.com"]),
    });
    await syncAllowPolicy(db, c, "a", "p1", "idp1");
    const put = c.calls.find((k) => k.method === "PUT");
    const emails = (put?.body as ReturnType<typeof policyBody>).include.map(
      (r) => r.email.email,
    );
    expect(emails).toContain("viewer@example.com");
  });

  it("refuses to overwrite a rule added by hand in Cloudflare", async () => {
    // Continuous sync asserts ownership of this policy. This guard is what makes
    // that safe: a foreign edit is surfaced, not destroyed.
    const db = await seedUsers(["a@example.com"]);
    await setFingerprint(db, ["a@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody([
        "a@example.com",
        "stranger@example.com",
      ]),
    });
    const r = await syncAllowPolicy(db, c, "a", "p1", "idp1");
    expect(r.synced).toBe(false);
    expect(r.conflict).toMatch(/changed outside/i);
    expect(c.calls.some((k) => k.method === "PUT")).toBe(false);
  });

  it("does not raise a conflict when only Homestead's own user list changed", async () => {
    // Adding a user locally changes desired state, not remote state. Reporting
    // that as foreign drift would make the conflict prompt meaningless noise.
    const db = await seedUsers(["a@example.com", "new@example.com"]);
    await setFingerprint(db, ["a@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody(["a@example.com"]),
    });
    const r = await syncAllowPolicy(db, c, "a", "p1", "idp1");
    expect(r.synced).toBe(true);
    expect(r.conflict).toBeUndefined();
  });

  it("stores the new fingerprint so the next run sees no drift", async () => {
    const db = await seedUsers(["a@example.com", "b@example.com"]);
    await setFingerprint(db, ["a@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody(["a@example.com"]),
    });
    await syncAllowPolicy(db, c, "a", "p1", "idp1");
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.lastPushedPolicy"));
    expect(row?.value).toBe(
      fingerprint(policyBody(["a@example.com", "b@example.com"])),
    );
  });
});
```

Reuse the same `fakeClient` helper shape as `tunnel.test.ts`: it records
`{ method, path, body }` on a `calls` array and returns canned results keyed by
`"METHOD /path"`.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/cloudflare/sync-users.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read remote, `checkForClobber` against the stored fingerprint, and on success PUT
the rebuilt policy and store the new fingerprint.

Call it after user create, delete and email change, and once at startup from
`src/server/index.ts`. **`buildApp` must not call it** — that would put a network
call into every route test.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Confirm the unit suite still exits promptly**

`pnpm test` must not hang. A suite that exits late is how a stray network call or
timer announces itself.

- [ ] **Step 6: Commit**

```bash
git add src/server/cloudflare/sync-users.ts src/server/cloudflare/sync-users.test.ts src/server/routes/cloudflare.ts src/server/index.ts
git commit -m "feat(cloudflare): keep the allow policy synced to Homestead users"
```

---

## Task 12: The exposures UI

**Files:**
- Create: `src/web/routes/Exposures.tsx`, `src/web/routes/exposures.test.tsx`
- Modify: `src/web/lib/queries.ts`, `src/web/App.tsx`

**Do not set `retry` or `refetchOnWindowFocus` on any hook.** They are client defaults from `createQueryClient`; re-adding them per hook is a defect this project has fixed twice. Reuse `isRefusal` from `queries.ts` for the 403 state.

- [ ] **Step 1: Write the failing tests**

Cover:

- The list renders a hostname with its service name and status.
- A 403 renders the shared refusal state.
- The empty state explains that Cloudflare is not configured yet and links to setup.
- **Turning Access off requires an explicit confirmation naming what will happen.**
  This is the one action that can put an unauthenticated service on the internet;
  spec §6.3 makes it deliberate rather than a quiet checkbox.
- A conflict response renders the adopt-or-overwrite prompt rather than a generic error.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web/routes/exposures.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Register `/exposures` inside the existing protected layout route in `App.tsx`,
keeping every current registration, and add a nav entry. Use the primitives from
`src/web/components/ui/index.js` and check their real signatures: `EmptyState` takes
`title`/`description`/`action`, `SegmentedControl` takes `items: { id, label }[]`,
`Input` already carries `border border-border` and `min-h-11`.

Every control is at least 44px in both dimensions. Any bordered element uses
`border border-border`, because Tailwind preflight zeroes `border-width`.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/Exposures.tsx src/web/routes/exposures.test.tsx src/web/lib/queries.ts src/web/App.tsx
git commit -m "feat(web): add the exposures list"
```

---

## Task 13: The setup wizard and the end-to-end sweep

**Files:**
- Create: `src/web/routes/CloudflareSetup.tsx`, `src/web/routes/cloudflare-setup.test.tsx`, `e2e/exposures.spec.ts`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Write the failing tests**

`cloudflare-setup.test.tsx` covers: the token step reports missing scopes by name;
the account step lists accounts; **the identity-provider step blocks with a clear
message and a link when the account has none**; and the token input is
`type="password"` and is cleared after submit.

`e2e/exposures.spec.ts` imports `test` from `./support/fixtures.js`, stubs the API,
and asserts the list and setup wizard render at both viewports. Run
`expectTappable` and `expectNoHorizontalScroll` on both routes — no existing sweep
visits them.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web && pnpm e2e`
Expected: FAIL.

- [ ] **Step 3: Implement**

Register `/cloudflare/setup`. The wizard is four steps: token, account, identity
provider, runtime. The token never round-trips to the client after submission.

- [ ] **Step 4: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm e2e`
Expected: PASS at both viewports.

- [ ] **Step 5: Confirm no host side effects**

```bash
docker ps -a --format '{{.ID}}' | sort > /tmp/before.txt
pnpm e2e
docker ps -a --format '{{.ID}}' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "no drift"
```

- [ ] **Step 6: Commit**

```bash
git add src/web e2e
git commit -m "feat(web): add the Cloudflare setup wizard"
```

---

## Definition of Done

- `pnpm typecheck`, `pnpm test`, `pnpm lint` clean; `pnpm e2e` green at **both** viewports.
- `src/server/auth/permissions.ts` changed in exactly one commit, adding one resource to `adminRole` and nothing to `viewerRole`.
- A viewer is refused every Cloudflare and exposure route.
- Emails are in `include` and the identity provider is in `require` — never the reverse.
- Deleting an exposure deletes its Access application and DNS record, and **neither shared policy**.
- Every ingress push contains the full array and ends with the catch-all.
- A remote edit made by hand halts the push and surfaces a conflict, for both ingress and the allow policy.
- Setup refuses to proceed when the account has no identity provider.
- The stored API token, tunnel run token and service-token secret contain no plaintext.
- No test reaches the network, opens a socket, starts a container, or uses a real timer.

## Handoff to the dashboard plan

- Tiles link to `exposures.hostname`, joined on `hostPort`.
- The `reachability` monitor type is the app's public probe.
- Status stays a three-state dot with the confidence tier as detail text.
- Apps come from managed project services and manual rows; container discovery is not planned.
