# Homestead Phase 2D — Expose and Deprovision

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an app on the internet behind Cloudflare Access, and take it off again without deleting anything Homestead did not create.

**Architecture:** Two step sequences on 2B's runner. Exposing is §6's four steps — ingress, DNS, Access application, probe — each idempotent, with reverse-order rollback. Deprovisioning reverses them and consults a per-resource created-by-us flag before deleting anything. One `Homestead Monitor` service token and one reusable policy serve every app, so rotation is a single operation. The one genuinely dangerous piece is the tunnel's ingress array: there is no add-one-rule endpoint, so every write replaces the whole array, and two concurrent writes silently erase each other's hostname.

**Tech Stack:** Fastify, Drizzle, zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` §6 — **Exposing an app**, **One service token, one reusable policy**, and **Deprovisioning, adoption, drift**.

**Carry-forwards:** 2A's, 2B's and 2C's, in `docs/superpowers/plans/`. **2C's is the important one** and its lesson is the spine of this phase.

**Server-side only.** The exposure UI, onboarding step 4 and drift flagging are 2F's.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`.
- Baseline **1500 tests**.
- **No test may make a real network call**, and none may create a real Cloudflare resource.
- **Never log or return the service token's secret, or the tunnel token.**
- **Once a migration may have been applied anywhere, add a new one — never rewrite it.** Drizzle's libsql migrator gates on journal timestamps, not content hashes. The test VM holds real data.
- **libSQL, measured:** `:memory:` rejects **any** statement during an open transaction.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, Biome clean **by exit code**:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain` empty at the end of each task. Scratch in `/tmp`.

## The lesson from 2C that governs this whole phase

2C's rollback deleted a Cloudflare tunnel it had merely *adopted*, because **adoption and deletion were authorised by the same match**. A user with a tunnel named `homestead` would have lost it.

Every resource in this phase has that exact structure, and §6 names it: deprovisioning "only deletes resources Homestead recorded creating — an adopted DNS record made by hand is left alone."

**The `exposures` table already has the columns for this** — `dnsRecordCreatedByUs`, `ingressRuleCreatedByUs`, `accessAppCreatedByUs` (`schema.ts:185-192`). They were designed in Phase 1A and have never been written. **Write them, and read them before every delete.** A test for each that fails if the flag is ignored is not optional.

## The ingress array is a read-modify-write race, and the spec calls it a correctness bug

There is no endpoint to add a single ingress rule. The whole array is replaced. §6:

> Two concurrent provisions would each read the old array, each append their own rule, and the second PUT would silently erase the first app's hostname.

So: **all tunnel-config writes go through a single mutex, and re-read immediately before each PUT.** Not read-then-lock — lock, read, modify, write, unlock. A re-read outside the lock is the same bug with extra steps.

The rule is spliced **before** the trailing `http_status:404` catch-all, never appended after it. A rule after the catch-all is unreachable, and the failure is silent: provisioning reports success and the hostname 404s.

## What is known about these Cloudflare endpoints, and what is not

**Relied on:** tunnel configuration at `/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` with `GET` and `PUT`, the ingress array living under `config.ingress`; DNS records at `/zones/{zone_id}/dns_records`; Access applications at `/accounts/{account_id}/access/apps`; Access policies at `/accounts/{account_id}/access/policies`; service tokens at `/accounts/{account_id}/access/service_tokens`. All use the v4 envelope 2A's client already parses. A DNS CNAME target for a tunnel is `<tunnel-id>.cfargotunnel.com` and must be **proxied**.

**Not verified — do not guess.** Whether a reusable policy is attached to an application by `{"id": "..."}` inside the app's `policies` array or through a separate endpoint; the exact field name for a service token's secret on creation, and that **it is returned only once**; and whether `client_secret_version` is a field on rotation or a separate call.

Where you need one of these: handle both plausible shapes, or fail loudly and legibly, and **say in your report which you did**. A silent `undefined` reaching a stored credential is the failure mode — Phase 1G shipped exactly that, and 2C's client already uses a `z.union` for precisely this reason.

---

### Task 1: The remaining Cloudflare endpoints

Batched deliberately: four endpoint groups of the same shape, all reusing 2A's transport.

**Files:** modify `src/server/cloudflare/client.ts` + test; `src/shared/cloudflare.ts` as needed.

**Interfaces** — added to `CloudflareClient`:
```ts
getTunnelConfig(tunnelId: string): Promise<{ ingress: IngressRule[] }>;
putTunnelConfig(tunnelId: string, config: { ingress: IngressRule[] }): Promise<void>;
createDnsRecord(zoneId: string, r: { name: string; content: string }): Promise<{ id: string }>;
deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
findDnsRecord(zoneId: string, name: string): Promise<{ id: string } | null>;
createAccessApp(a: { domain: string; name: string; policyIds: string[] }): Promise<{ id: string; aud: string }>;
deleteAccessApp(appId: string): Promise<void>;
findAccessApp(domain: string): Promise<{ id: string; aud: string } | null>;
createServiceToken(name: string): Promise<{ id: string; clientId: string; clientSecret: string; expiresAt: number | null }>;
rotateServiceToken(tokenId: string): Promise<{ clientId: string; clientSecret: string; expiresAt: number | null }>;
listServiceTokens(): Promise<Array<{ id: string; name: string; expiresAt: number | null }>>;
createMonitorPolicy(name: string, serviceTokenId: string): Promise<{ id: string }>;
```

- [ ] **Step 1: Write the failing tests**

Per group, the assertions that actually discriminate:

- **`createDnsRecord` sends `proxied: true` and `type: "CNAME"`.** Assert on the **request body**. An unproxied record points at a hostname that does not resolve publicly, and nothing else in the system would notice.
- **`createAccessApp` sends `type: "self_hosted"` and the policy ids.** Again on the request body.
- **`createServiceToken` raises if the secret is missing or empty** rather than returning `""`. The secret is returned once; an empty one is unrecoverable without rotation.
- **`createMonitorPolicy` sends `decision: "non_identity"` and the token in its include list.** A policy that is not `non_identity` demands a human login, which is precisely what the monitor probe cannot do — and the symptom would be every external probe failing with a redirect, not an obvious misconfiguration.
- `find*` return `null` for absent rather than throwing, since the idempotency checks call them.
- `delete*` on an absent resource is not an error — rollback calls them.
- **No method puts a secret in an error message.**

- [ ] **Step 2-4: Red, implement, green**

Reuse 2A's transport, envelope, retry and fault classification throughout. **Do not add a second request path.**

- [ ] **Step 5: Prove the bindings**

Drop `proxied: true`; drop `type: "self_hosted"`; drop `decision: "non_identity"`; return `""` for the service-token secret. Each must fail its test. Report all four.

- [ ] **Step 6: Gates and commit**

---

### Task 2: The monitor token and the reusable policy

One service token and one policy for every app, so rotation is a single operation.

**Files:** create `src/server/cloudflare/monitor-access.ts` + test; modify `src/server/routes/cloudflare.ts` + test.

**Interfaces:**
```ts
export type MonitorAccess = { tokenId: string; clientId: string; policyId: string; expiresAt: number | null };
export class MonitorAccessStore { get(): Promise<MonitorAccess | null>; set(v: MonitorAccess, clientSecret: string): Promise<void>; clear(): Promise<void>; }
export async function ensureMonitorAccess(deps: {...}): Promise<MonitorAccess>;
export async function rotateMonitorSecret(deps: {...}): Promise<MonitorAccess>;
```

`clientId` is not secret and is stored in `settings`; `clientSecret` goes in `secrets`. Both are needed by 2E's external probe as `CF-Access-Client-Id` and `CF-Access-Client-Secret`.

- [ ] **Step 1: Write the failing tests**

- `ensureMonitorAccess` creates the token and the policy on first call, and **is a no-op on the second** — it must not create a second token. This is the idempotency §6 requires and the thing that silently costs money and confusion if wrong.
- The secret is stored and **never returned to a caller that did not just create it**.
- Rotation replaces the secret and keeps the same token id and policy id — the whole point is that N apps keep pointing at one policy.
- **`expiresAt` is persisted.** §6: tokens return `duration: "8760h"` and a concrete expiry, and "a year after setup every external probe would begin failing simultaneously with nothing actually broken". 2F surfaces the warning; 2D must record the date or there is nothing to warn from.
- If policy creation fails after the token is created, the token is cleaned up — **or is deliberately kept and recorded.** Decide, implement, and say which and why: an orphaned service token is invisible in Homestead but real in Cloudflare.

- [ ] **Step 2-6: Red, implement, green, prove, commit**

Binding checks: make the second `ensureMonitorAccess` create a second token; drop `expiresAt` persistence. Each must fail.

---

### Task 3: Exposing an app

**Files:** create `src/server/cloudflare/expose.ts` + test, `src/server/cloudflare/ingress.ts` + test; modify `src/server/routes/cloudflare-expose.ts` (new) and `src/server/app.ts`.

`ingress.ts` is a **pure module** owning the splice: given an array and a new rule, return the array with the rule before the catch-all. Pure because it is the piece whose bugs are silent, and pure code can be tested exhaustively.

**Interfaces:**
```ts
export function spliceIngress(rules: IngressRule[], rule: { hostname: string; service: string }): IngressRule[];
export function removeIngress(rules: IngressRule[], hostname: string): IngressRule[];
export function exposeSteps(deps: {...}): Array<Step<ExposeCtx>>;
```

**The four steps, each with an `undo` and each recording a created-by-us flag:**

| | Step | Records | Undo |
|---|---|---|---|
| 1 | Splice the ingress rule, under the mutex | `ingressRuleCreatedByUs` | Remove it, under the mutex |
| 2 | Create the proxied CNAME | `dnsRecordCreatedByUs`, `dnsRecordId` | Delete it — **only if we created it** |
| 3 | Create the Access application | `accessAppCreatedByUs`, `accessAppId`, `accessAppAud` | Delete it — **only if we created it** |
| 4 | Create the `http_external` probe | — | Delete it |

- [ ] **Step 1: `spliceIngress` tests first — this is where silent failure lives**

- A rule is inserted **before** a trailing `{ service: "http_status:404" }` catch-all.
- With **no** catch-all present, the rule still lands somewhere reachable — decide the behaviour and state it. A tunnel config without a catch-all is unusual but not impossible.
- **Splicing a hostname that already exists replaces it rather than duplicating it.** Two rules for one hostname means the second is dead, and which one wins is not obvious from the UI.
- `removeIngress` removes only the named hostname and **leaves the catch-all**. Removing the catch-all breaks every other exposed app on the tunnel — the blast radius of this one is the whole tunnel.
- `removeIngress` on an absent hostname is a no-op.
- Order of the other rules is preserved.

- [ ] **Step 2: The mutex**

All tunnel-config writes serialise, and **the read happens inside the lock**. Test it by driving two concurrent exposes against one fake client and asserting **both hostnames survive** — that is the assertion the spec's correctness bug fails. A test that runs them sequentially proves nothing.

`AppLock` from 2B is per-app; this mutex is per-tunnel and global. **They are different locks** — say so in a comment, because the next reader will assume one is the other.

- [ ] **Step 3: The sequence tests**

The rollback tests matter more than the happy path. For each step, force its successor to fail and assert the **external effect** of the undo — the rule gone from the array, the DNS record deleted, the Access app deleted. Not that a spy was called.

And the 2C lesson, for each of steps 2 and 3: **when the resource already existed and was adopted rather than created, the undo must not delete it.** Seed a pre-existing DNS record for the hostname, fail a later step, and assert it survives. Same for the Access application. **These two tests are the most important in the phase.**

- [ ] **Step 4-6: Red, implement, green, prove, commit**

Binding checks: append the ingress rule after the catch-all instead of before; ignore `dnsRecordCreatedByUs` in the undo; take the mutex after the read instead of before. Each must fail its test.

---

### Task 4: Deprovisioning

**Files:** create `src/server/cloudflare/deprovision.ts` + test; modify the route file and `app.ts`.

Deprovisioning is not a rollback — it runs against a *successful* exposure, from the recorded `exposures` row, and the row is the only source of truth about what Homestead created.

- [ ] **Step 1: Write the failing tests**

- All four resources are removed in reverse order, and the `exposures` row is deleted last — **if the row goes first and a later delete fails, the remaining resources are unreachable forever.**
- **Every `*CreatedByUs: false` resource is left alone.** One test per flag. This is §6's explicit requirement and 2C's measured defect.
- A resource already gone in Cloudflare is not an error.
- A partial failure leaves the row in place with the flags updated for what *was* removed, so a retry does not try to delete what is already gone and does not skip what is not.
- The probe is deleted, so a deprovisioned app stops being probed externally.
- **A viewer gets 403**, and a scoped admin gets 404 for an app outside their scope rather than a 409.

- [ ] **Step 2-6: Red, implement, green, prove, commit**

Binding checks: delete the `exposures` row first; ignore one of the created-by-us flags. Each must fail.

---

## Self-Review

**1. Spec coverage.** §6's **Exposing an app** (all four steps, idempotent, reverse-order rollback, the serialised tunnel-config writes with a re-read inside the lock), **One service token, one reusable policy** (single token, single reusable `non_identity` policy attached by id, `expires_at` persisted, rotation via a single operation), and **Deprovisioning** (reverses all four, deletes only what Homestead recorded creating).

**Not here, by design:** the external probe consuming these credentials (2E), and the exposure UI, the expiry warning's presentation, onboarding step 4 and drift reconcile (2F). Adoption of pre-existing tunnels and Access applications by hostname scan remains deferred from 2A — **but note Tasks 3 and 4 already handle the adopted case correctly**, because the created-by-us flags make "this already existed" a first-class state rather than a special mode.

**2. Placeholder scan.** No "TBD". Five decisions are delegated with their grounds: the three unverified Cloudflare shapes (handle both or fail loudly), `spliceIngress` with no catch-all present, and whether a failed policy creation cleans up its token.

**3. Type consistency.** `IngressRule` is used by the client (Task 1), the pure splice module and the sequence (Task 3) — it belongs in `src/shared/cloudflare.ts` so all three agree. `MonitorAccess.policyId` from Task 2 is what Task 3 passes to `createAccessApp`. `ExposeCtx` carries the created-by-us flags that Task 3 writes and Task 4 reads — and they are persisted to `exposures`, so the two tasks communicate through the database rather than through a shared type, which is why Task 4's tests must seed rows rather than run Task 3.

**4. What a reviewer should attack hardest.** Two things. The concurrency test — two exposes against one tunnel, both hostnames surviving — is the only test in this phase that can catch the spec's named correctness bug, and it is trivially easy to write in a way that passes without any mutex at all by letting the two run sequentially. And the adopted-resource tests for DNS and Access: 2C proved this project gets that exact case wrong, and a test asserting the resource *was* deleted looks just as green and reasonable as one asserting it survived.
