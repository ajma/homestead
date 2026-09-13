# Homestead Phase 3A — Access Policies, User Sync, and Exposure Ergonomics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloudflare setup creates both Access policies it needs, the human one stays in step with Homestead's users, exposing an app sets up internal *and* external monitoring, and the expose form stops asking for a URL it can work out itself.

**Architecture:** Four changes to the exposure flow built in Phase 2, none of them new subsystems. The one with teeth is keeping the human policy's email list synced: it is an outward-facing write on the path of every user mutation, and it is the boundary that decides who on the internet can reach your apps.

**Tech Stack:** Fastify, Drizzle, zod 4, React, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` §6. This phase extends §6's "One service token, one reusable policy" to two policies and adds the sync §6 does not describe.

**Carry-forwards:** 2A's through 2F's. 2F's records what §6 still leaves open.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`.
- Baseline **1816 tests**.
- **No test may make a real network call**, and none may create a real Cloudflare resource.
- **Never log or return the service token's secret.**
- **Add a new migration if needed; never rewrite `0000`–`0004`.** Drizzle's libsql migrator gates on journal timestamps, not content hashes. **The test VM holds real data** — an admin account and a fresh onboarding in progress.
- **libSQL, measured:** `:memory:` rejects **any** statement during an open transaction.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, Biome clean **by exit code**:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain --untracked-files=all` empty at the end of each task; no scratch files.

## Two rulings already made — state them, do not relitigate

**1. One shared human policy containing every enabled user, ignoring per-app scope.**

Homestead has per-app viewer scope, and this deliberately does not honour it: a viewer scoped only to Jellyfin will be admitted by Cloudflare Access to every exposed app. Homestead's own UI still hides the others, so the launcher and the API remain correctly scoped — **the gap is that the tunnel is more permissive than the app.**

The cost was put to the user explicitly and this is their call. **Write it down where a reader will find it** — in the policy-building code and in `docs/deployment.md` — as a known property, not a bug. Per-app policies remain the upgrade path if it ever matters.

**2. Removing or disabling a user must succeed in Cloudflare or fail locally.**

If the Access policy cannot be updated, the user mutation returns an error and the user is **not** removed from Homestead. You cannot revoke someone during a Cloudflare outage — accepted — but you are never told someone is gone while they still have internet access to your apps.

**The crucial exception:** this applies only when Access is actually configured. An installation that has never touched Cloudflare must be able to delete users normally. A deployment that cannot remove a user because of a feature it does not use would be a bad bug, and it is the obvious way to get this wrong.

## What is known about these Cloudflare endpoints, and what is not

Same discipline as Phase 2, which caught three assumptions that had leaked into code.

**Relied on:** Access policies live at `/accounts/{account_id}/access/policies` and are attached to an application by id; `decision: "non_identity"` with a `service_token` include is the probe policy (built in 2D and working); the v4 envelope 2A's client parses.

**Not verified — do not guess.** The exact include shape for an email list (`include: [{ email: { email } }]` is the likely form, but confirm the API's actual response rather than assuming the request was understood); whether updating a policy is `PUT` of the whole object or a `PATCH`; and whether a reusable policy's updates propagate to attached applications without touching the applications.

Where you need one: handle both plausible shapes, or fail loudly and legibly, and **say which you did**. Phase 2C's client already uses a `z.union` for exactly this.

**An assumption to state rather than test:** the identity provider itself — one-time PIN, Google, GitHub — is configured in Cloudflare's dashboard, not by Homestead. An email include works against whatever login methods the account has enabled. This phase does not configure an IdP.

---

### Task 1: Policy endpoints on the client

**Files:** modify `src/server/cloudflare/client.ts` + test; `src/shared/cloudflare.ts` as needed.

**Interfaces** — added to `CloudflareClient`:
```ts
createEmailPolicy(name: string, emails: string[]): Promise<{ id: string }>;
updateEmailPolicy(policyId: string, name: string, emails: string[]): Promise<void>;
getPolicy(policyId: string): Promise<{ id: string; name: string } | null>;
```

- [ ] **Step 1: Write the failing tests**

- `createEmailPolicy` sends `decision: "allow"` and one include per email. **Assert the request body** — nothing else in the system would notice a wrong decision, and `non_identity` here would silently admit the probe's token instead of a human.
- `updateEmailPolicy` sends the **full** desired list, not a delta. There is no add-one-email endpoint any more than there was an add-one-ingress-rule endpoint, and 2D's whole mutex exists because of that shape.
- An empty email list is **not** silently sent as an allow-nobody policy without saying so — decide whether that is an error or a legitimate state, implement it, and say which. An Access policy with no includes may fail open or closed depending on Cloudflare, and guessing is how a policy ends up admitting everyone.
- `getPolicy` returns `null` for a missing policy rather than throwing — the reconcile and the sync both need to ask.
- Faults classify through the existing `CloudflareError`; no method puts a secret in a message.

- [ ] **Step 2-4: Red, implement, green.** Reuse 2A's transport; **do not add a second request path.**

- [ ] **Step 5: Prove the bindings.** Drop `decision: "allow"`; send a delta instead of the full list. Each must fail its test.

- [ ] **Step 6: Gates and commit**

---

### Task 2: Both policies at setup

Today `ensureMonitorAccess` creates the service token and its policy, triggered by a **button** in Settings. Both policies should exist as a consequence of setting Cloudflare up.

**Files:** modify `src/server/cloudflare/monitor-access.ts` (or rename it — it is no longer only about the monitor) + test; `src/server/routes/cloudflare.ts` + test; the wizard's Cloudflare step from 2F.

**Interfaces:**
```ts
export type AccessPolicies = {
  monitorPolicyId: string; tokenId: string; clientId: string; expiresAt: number | null;
  humanPolicyId: string;
};
export async function ensureAccessPolicies(deps: {...}): Promise<AccessPolicies>;
```

- [ ] **Step 1: Write the failing tests**

- First call creates **both** policies and the service token; a second call creates nothing. 2F found `ensureMonitorAccess` was a check-then-create race that made **two real Cloudflare service tokens** on a double-click — **the existing dedup must still hold and must now cover both policies.**
- The human policy is seeded with **every enabled Homestead user's email** at creation time.
- **Disabled users are excluded.** A disabled user who keeps internet access is the whole point of the disable.
- Partial failure is cleaned up or recorded, never left half-made: if the human policy fails after the token policy succeeded, say what happens. 2D's `ensureMonitorAccess` deletes an orphaned token on policy failure — follow that precedent.
- Setting up Cloudflare in the wizard triggers it; **Settings no longer needs a separate button**, though rotation stays.

- [ ] **Step 2-6: Red, implement, green, prove, commit**

Binding checks: make the second call create a second token; include a disabled user's email. Each must fail.

---

### Task 3: Keep the policy in step with the users

**Files:** create `src/server/cloudflare/sync-access-users.ts` + test; modify `src/server/routes/users.ts` and `src/server/routes/setup.ts` + tests.

**Interfaces:**
```ts
export async function syncAccessUsers(deps: {...}): Promise<void>;
```
It reads every enabled user's email and calls `updateEmailPolicy` with the full list. **Rebuild from the database each time; never diff.** A delta computed against what we think Cloudflare holds drifts the first time anything else edits it.

- [ ] **Step 1: Write the failing tests, which are mostly about failure**

The ordinary cases:
- Creating a user adds their email; deleting removes it; disabling removes it; re-enabling restores it; changing an email replaces it.
- `POST /api/setup/admin` seeds the first admin.

The cases that matter:
- **Cloudflare unreachable during a delete → the delete fails and the user still exists.** Assert both halves. A route that reports failure but deleted the row anyway is the worst outcome.
- **Cloudflare unreachable during a disable → the disable fails and the user is still enabled.**
- **Cloudflare unreachable while *adding* a user → decide and state it.** Ruling 2 covers removal specifically. Adding is not a security risk, so failing the whole operation may be the wrong trade — but two code paths behaving differently needs a comment saying why.
- **Access not configured → every user mutation works normally and calls Cloudflare not at all.** This is the one most likely to be got wrong and the most damaging: an installation that never touched Cloudflare must not lose the ability to manage users. Test it for create, patch and delete.
- Email comparison is **case-insensitive and normalised**. Phase 2E fixed a first-run lockout caused by comparing a raw body email against Better-Auth's lowercased storage; the same normalisation applies to what is sent to Cloudflare.

- [ ] **Step 2-6: Red, implement, green, prove, commit**

Binding checks: make the delete path ignore a Cloudflare failure; make the sync run when Access is unconfigured. Each must fail its test.

---

### Task 4: Both probes, and an internal URL Homestead works out

§6: "The same published ports serve three consumers: LAN devices, the `http_internal` probe, and the launcher's internal URL. One fact about an app rather than three." This task makes that true of exposure too.

**Files:** modify `src/server/cloudflare/expose.ts` + test, `src/server/routes/cloudflare-expose.ts` + test.

- [ ] **Step 1: Change what expose is given**

The route currently takes `ingressService` as a URL. It should take **the compose service name and the published port**, and construct `http://localhost:<port>` itself. `ComposeConfigCache` already resolves `ResolvedService { name, image, restart, publishedPorts }` (`compose-config.ts:3-8`) — read it rather than re-running `docker compose config`.

Validate the chosen service and port **against the resolved compose file**, so a typo cannot produce a tunnel pointing at a port nothing serves. A service that publishes no ports cannot be exposed: say so clearly rather than constructing a URL to nowhere.

**Keep the constructed URL's shape in one function** shared with whatever the launcher and the internal probe already use, if such a thing exists — if it does not, this is the second caller, which is the right time to extract it.

- [ ] **Step 2: Create both probes**

Expose currently creates only `http_external`. It should also create `http_internal` targeting the same constructed URL.

- Both are created, and both are recorded so deprovision removes exactly what it made. 2D's carry-forward: probes are deleted **by recorded id, not by `(appId, kind)`** — that defect destroyed an admin's own probe and its check history. **The internal probe has the same exposure now.**
- An app that **already has** an `http_internal` probe is the adoption case again, and 2F ruled on the external one: refuse rather than retarget, because overwriting a target the admin set and restoring it later needs persisted state that carries its own silent-wrong-URL risk. **Follow that ruling for consistency**, or argue why internal differs.
- Rollback removes both.

- [ ] **Step 3-6: Red, implement, green, prove, commit**

Binding checks: construct the URL from an unvalidated port; delete probes by `(appId, kind)` instead of id. Each must fail.

---

### Task 5: The UI catches up

**Files:** modify `src/web/routes/edit/ExposureTab.tsx` + test, `src/web/routes/settings/CloudflarePanel.tsx` + test, `src/web/api/cloudflare.ts`.

- [ ] **Step 1: Write the failing tests**

- The expose form offers a **service picker and a port picker** drawn from the resolved compose file, not a URL field. With exactly one service and one port, both are preselected — the common case should be one click.
- **The Access policy id field is gone.** Both policies now exist from setup; asking an admin to paste a policy id was always a leak of internal plumbing.
- A service with no published ports is shown as not exposable, with the reason.
- Settings shows both policies' state, and **no longer offers a "set up monitor token" button** — it happens at setup. Rotation stays.
- **The shared-policy scope property is stated in the UI**, not only in a doc: exposing an app admits every Homestead user, including viewers scoped to other apps. One sentence where the admin is making the decision.

- [ ] **Step 2-5: Red, implement, green, prove**

**Harness traps, measured here:** TanStack's `notifyManager` defers re-renders through `setTimeout(0)` and RTL's `act()` can mask it — if a binding check comes back green, suspect the harness and say so. jsdom 30 lacks `HTMLDialogElement.showModal`/`.close`; `DialogShell` works around it. jsdom gives zero geometry.

- [ ] **Step 6: Gates and commit.** Report the initial chunk size — 440.54 kB, with `ConfigTab` a separate ~606 kB lazy chunk.

---

## Self-Review

**1. Coverage.** All four of the user's requirements: both policies created at setup rather than by a button (Tasks 2, 5); the human policy's emails kept in step with Homestead's users (Task 3); internal and external probes both created on exposure (Task 4); and the expose form taking a service and port instead of a URL (Tasks 4, 5).

This **extends** §6 rather than implementing it — §6 describes one service token and one reusable policy, and says an Access application's policy list contains "the chosen human policy plus the shared monitor policy". It never says where the human policy comes from. Phase 2 made it a field the admin pasted; this makes Homestead own it. **Update §6 to match**, or the spec and the code disagree from here on.

**2. Placeholder scan.** No "TBD". Five decisions are delegated with their grounds: the three unverified Cloudflare shapes, what an empty email list means, and whether *adding* a user should fail when Cloudflare is unreachable.

**3. Type consistency.** `AccessPolicies` in Task 2 supersedes 2D's `MonitorAccess` — it is the same record plus `humanPolicyId`, so renaming rather than adding a parallel type is the point; two stores for one concept is the defect this project keeps finding. `syncAccessUsers` takes the store and a client factory rather than a client, because it must be a no-op when Access is unconfigured and building a client requires credentials. Task 4's constructed URL is a `string` in the same shape `exposures.ingressService` already stores, so nothing downstream changes.

**4. What a reviewer should attack hardest.** Task 3's unconfigured case. Every other failure in this phase is visible — a policy that did not update, a probe that did not appear. But if `syncAccessUsers` throws or blocks when Cloudflare was never set up, **an installation that does not use this feature loses the ability to delete users**, and it would pass every test written by someone thinking about the Cloudflare path. It is the exact shape of Phase 2E's first-run lockout: a code path nobody exercised because the tests all configured the thing first.
