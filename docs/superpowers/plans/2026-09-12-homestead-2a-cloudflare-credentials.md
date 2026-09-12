# Homestead Phase 2A — Cloudflare Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin pastes a Cloudflare API token and account ID into Settings, Homestead verifies them against the real API, and lists the zones it can see.

**Architecture:** A Cloudflare API client owning transport, the v4 response envelope, error classification and bounded retry — with exactly one endpoint group for now, zones. Credentials go in the two flat key-value tables that already exist: the token encrypted in `secrets`, the account ID in `settings`. No migration. Verification is done by **exercising a permission we actually need** rather than by a dedicated verify endpoint, so a token that passes has demonstrably worked.

**Tech Stack:** Fastify, Drizzle, zod 4, TanStack Query, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — §6 is Phase 2's authority. This plan implements its **Credentials** subsection only.

**Recon:** `docs/superpowers/plans/2-recon.md`. **Read it before Task 1.** It is accurate, has `file:line` throughout, and corrected the spec in three places.

## Where Phase 2A sits

Phase 2 decomposes into six sub-phases, each producing working software on its own:

| | Delivers |
|---|---|
| **2A** | **Credentials and the API client. This plan.** |
| 2B | Resolve the `isSystem` conflict; a step-sequence job runner with reverse-order rollback |
| 2C | Tunnel provisioning and the managed `cloudflared` app |
| 2D | Expose / deprovision, the service token and the reusable policy |
| 2E | Wire the external probe's credentials; mount the dormant Access JWT path |
| 2F | Exposure UI, onboarding step 4, drift flagging |

**Deferred from §6 deliberately, to be planned only if wanted:** adoption of pre-existing tunnels, ingress rules and Access applications by hostname match. The user's Cloudflare account is a clean slate with nothing built, so create-only covers the real case; adoption is meaningful work serving a situation that does not exist yet.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`. Node 24 has global `fetch`; zod 4 is already here.
- **Never send the API token to the client after it is stored.** Not in a response body, not in a query cache, not in a log line, not in an error message. Phase 1F learned this expensively with `.env` secrets — raw mode left every secret in the TanStack cache for five minutes. The UI shows *whether* a token is configured, never the token.
- **The token is admin-only.** Reading or writing it requires an admin capability, and a viewer must get 403 with no hint that credentials exist.
- **Every credential change is audited.** `audit()` in `src/server/audit.ts`; follow how existing mutations call it.
- Baseline **1351 tests**.
- `.tsx` test files need `// @vitest-environment jsdom` as line 1; `src/web/test-environment.test.ts` enforces it.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, and Biome clean **by exit code**, never piped to `tail`:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- **No test may make a real network call.** Inject `fetch`; the codebase already does this in `src/server/apps/registry.ts` and `src/server/monitoring/http-runner.ts`.
- `git status --porcelain` empty at the end of each task. Scratch in `/tmp`.

## What is known about the Cloudflare API, and what is not

State this distinction rather than blurring it — getting it wrong is the most likely way this phase ships something that works against a fake and fails against Cloudflare.

**Known and safe to rely on:**
- Base URL `https://api.cloudflare.com/client/v4`.
- Bearer auth: `Authorization: Bearer <token>`.
- Every response uses the v4 envelope: `{ success: boolean, errors: [{ code: number, message: string }], messages: [...], result: ... }`. A non-2xx still returns this shape, and `errors` is where the reason lives.
- `GET /zones` lists zones the token can see, paginated, with `result_info` carrying `page`, `per_page`, `total_count`.
- §6's permission table, reproduced verbatim below.

**Not verified and must not be guessed:** the exact path for verifying an account-owned token. §6 says these tokens are account-owned, created under Manage Account, and carry a `cfat_` prefix. **This plan deliberately does not use a verify endpoint at all** — see Task 2.

§6's required permissions, verbatim:

| Scope | Permission | Level | Needed for |
|---|---|---|---|
| Account | Cloudflare Tunnel | Edit | Create/adopt tunnel, write ingress rules |
| Account | Access: Apps and Policies | Edit | Create Access applications and the monitor policy |
| Account | Access: Service Tokens | Edit | Create and rotate the monitor token |
| Zone | DNS | Edit | CNAME to `<tunnel-id>.cfargotunnel.com` |
| Zone | Zone | Read | List zones for selection |

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/server/cloudflare/client.ts` | Transport, envelope parsing, error classification, retry. The only place that knows Cloudflare's wire format. |
| `src/server/cloudflare/client.test.ts` | Its tests |
| `src/server/cloudflare/errors.ts` | `CloudflareError` and the fault classification |
| `src/server/cloudflare/credentials.ts` | Load and store the token and account ID |
| `src/server/cloudflare/credentials.test.ts` | Its tests |
| `src/server/routes/cloudflare.ts` | `GET/PUT/DELETE /api/cloudflare/credentials`, `GET /api/cloudflare/zones` |
| `src/server/routes/cloudflare.test.ts` | Its tests |
| `src/shared/cloudflare.ts` | DTOs shared by server and client |
| `src/web/api/cloudflare.ts` | Query keys and fetchers |
| `src/web/routes/settings/CloudflarePanel.tsx` | The Settings surface |
| `src/web/routes/settings/CloudflarePanel.test.tsx` | Its tests |

**Modify:** `src/server/app.ts` (register the route), `src/web/routes/Settings.tsx` (mount the panel).

---

### Task 1: The Cloudflare API client

**Files:**
- Create: `src/server/cloudflare/errors.ts`, `src/server/cloudflare/client.ts`, `src/server/cloudflare/client.test.ts`

**Interfaces:**
- Consumes: an injected `fetch`, following `src/server/apps/registry.ts`'s pattern — **read that file first** and match how it takes `fetch` and reports errors.
- Produces:
  ```ts
  export type CloudflareFault = "auth" | "permission" | "rate_limit" | "network" | "cloudflare" | "client";

  export class CloudflareError extends Error {
    readonly fault: CloudflareFault;
    readonly status: number | null;
    readonly codes: number[];
  }

  export type CloudflareClient = {
    listZones(): Promise<Array<{ id: string; name: string }>>;
  };

  export function createCloudflareClient(opts: {
    token: string;
    accountId: string;
    fetch: typeof globalThis.fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }): CloudflareClient;
  ```

`now` and `sleep` are injected so retry timing is testable without real delays — `Scheduler` already does this with `now` and `random` (`src/server/monitoring/scheduler.ts`). **Follow that precedent rather than inventing another.**

- [ ] **Step 1: Write the failing tests**

Create `src/server/cloudflare/client.test.ts`. Cover, at minimum:

**Envelope and success**
- A 200 with `{ success: true, result: [{id, name}, …] }` returns the zones.
- **A 200 with `success: false` is an error, not a success.** Cloudflare can return HTTP 200 with `success: false`; trusting the status code alone is the classic mistake with this API.
- A response whose body is not the v4 envelope at all — HTML from a proxy, an empty body — raises a `CloudflareError` with fault `cloudflare`, rather than surfacing `undefined` as a result. Phase 1F shipped a defect of exactly this shape: a malformed 200 body overwrote a real verdict with `undefined`.

**Fault classification** — each of these is a different sentence in the UI, which is the whole point of the enum:
- 401, or error code 10000 → `auth`
- 403 → `permission`
- 429 → `rate_limit`
- 5xx → `cloudflare`
- `fetch` rejecting → `network`
- 400 with a validation code → `client`

**Retry**
- 429 is retried, honouring `Retry-After` when present.
- 5xx is retried with backoff.
- **401 and 403 are never retried.** A permission error does not improve by being asked again, and retrying it three times just delays the message the user needs.
- Retries are bounded, and the error raised after exhaustion carries the *last* fault, not a generic one.
- **Assert the number of `fetch` calls**, not just the outcome. A test that only checks the final error passes against no retry at all.

**Secrets**
- **The token never appears in a thrown error's `message` or `stack`.** Write this test. A token in an error message ends up in logs, and this project's audit trail records error text.

**Pagination**
- `listZones` follows pagination via `result_info` and returns every zone, not only the first page. Assert against a two-page fixture; a single-page test passes against an implementation that ignores paging entirely.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/server/cloudflare/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `errors.ts` then `client.ts`. Keep `client.ts` the only file that knows the wire format: callers get typed results and `CloudflareError`, never a `Response`.

Validate the envelope with zod rather than trusting its shape — the project does this for the Docker daemon's response (`src/server/host/local-host.ts`, `parseDockerVersion`) precisely because a missing field silently became `undefined`.

Give the retry policy a doc comment stating **which faults retry and why the others do not.** That is the part a future reader will otherwise "simplify".

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm exec vitest run src/server/cloudflare/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the bindings**

Three mutations, each reported as "broke X → test Y failed → restored → green":

1. Make the client trust the HTTP status and ignore `success: false`. The `success: false` test must fail.
2. Make 403 retry. The call-count assertion must fail.
3. Return only the first page from `listZones`. The pagination test must fail.

If any comes back green, the test is not binding — say so and fix the test, not the mutation.

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add src/server/cloudflare/
git commit -m "Add a Cloudflare API client that classifies its failures

Cloudflare answers a failed request with HTTP 200 and success:false, so
status alone is not the signal. The fault enum exists because an expired
token, a missing permission and a rate limit are three different
sentences in the UI, and only one of them is worth retrying."
```

---

### Task 2: Credentials, and verifying by doing

**Files:**
- Create: `src/server/cloudflare/credentials.ts` + test, `src/server/routes/cloudflare.ts` + test, `src/shared/cloudflare.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Consumes: `SecretStore` (`src/server/crypto/secrets.ts` — `set`/`get`/`delete` on a flat name), the `settings` table (`schema.ts:257`, flat key→value), `createCloudflareClient` from Task 1, `requireCapability` and `audit`.
- Produces:
  ```ts
  // src/shared/cloudflare.ts
  export type CloudflareStatus =
    | { configured: false }
    | { configured: true; accountId: string; tokenHint: string; verifiedAt: number | null };
  export type CloudflareZone = { id: string; name: string };
  ```
  `tokenHint` is the **last four characters only** — enough to tell two tokens apart, useless if leaked.

**No migration is needed.** `secrets` and `settings` are both flat key-value tables that already exist. Use `secrets` for the token and `settings` for the account ID and the last-verified timestamp.

- [ ] **Step 1: Decide the verification strategy, and write it down**

**Verification is `listZones()`, not a dedicated verify endpoint.** The reasoning belongs in a comment because it is not obvious:

A verify endpoint tells you a token is *live*. Listing zones tells you the token is live **and** carries Zone:Read **and** that our transport, auth header and envelope parsing all work against the real API. It exercises a permission §6 actually requires. And it avoids depending on a path this plan could not verify.

**State its limit honestly in the same comment:** a token passing this check has Zone:Read and nothing more is proven. The four account-scoped permissions in §6's table are not exercised until the sub-phase that needs them, and a token missing `Cloudflare Tunnel:Edit` will verify happily here and fail later in 2C. The client's `permission` fault exists so that later failure reads as "the token lacks a permission" rather than as an outage. **Do not write a comment claiming the token is fully validated** — that is the defect shape this project has hit in seven consecutive phases.

- [ ] **Step 2: Write the failing tests**

For `credentials.ts`: storing round-trips through `SecretStore`; the account ID lands in `settings`; `status()` reports `configured: false` on an empty database; `tokenHint` is the last four characters and **the test asserts the full token is not present anywhere in the returned object**; deleting clears both the secret and the setting.

For the routes:
- `PUT /api/cloudflare/credentials` with a token and account ID verifies by listing zones, stores on success, and returns the status.
- **A token that fails verification is not stored.** Assert the store is still empty afterwards. Storing an unverified token means every later phase fails confusingly instead of here, clearly.
- Verification failure surfaces the fault: an `auth` fault reads differently from a `network` fault, and the test asserts which.
- `GET /api/cloudflare/credentials` returns the status, **never the token.** Assert the token string does not appear in the serialised response body.
- `GET /api/cloudflare/zones` returns zones when configured, and a clean error when not configured — not a 500.
- **A viewer gets 403 from all four routes**, and the 403 body reveals nothing about whether credentials exist.
- Every mutation writes an audit row, and **the audit row does not contain the token.**

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm exec vitest run src/server/cloudflare src/server/routes/cloudflare.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

Register the route in `src/server/app.ts` alongside the existing route registrations — read how its neighbours are registered and match.

Where the route needs a client, build it from the stored credentials at request time. **Do not cache a client across credential changes**; a rotated token must take effect immediately, and a stale client holding the old token is a bug that would only appear during an incident.

- [ ] **Step 5: Run them and watch them pass**

Run: `pnpm exec vitest run src/server/cloudflare src/server/routes/cloudflare.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the bindings**

1. Store the token *before* verifying. The "not stored on failure" test must fail.
2. Return the full token in `status()`. The leak test must fail.
3. Drop the `requireCapability` call on one route. The viewer test must fail.

Report each.

- [ ] **Step 7: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Store Cloudflare credentials, verified by using them

Verification lists zones rather than calling a verify endpoint: that
proves the token is live, carries Zone:Read, and that our transport and
envelope parsing work against the real API. What it does not prove —
the four account-scoped permissions — is written down beside it."
```

---

### Task 3: The Settings panel

**Files:**
- Create: `src/web/api/cloudflare.ts`, `src/web/routes/settings/CloudflarePanel.tsx` + test
- Modify: `src/web/routes/Settings.tsx`

**Interfaces:**
- Consumes: the DTOs from Task 2, and the existing settings page structure. `HostCheckPanel` was added to Settings in Phase 1G — **read `Settings.tsx` and `HostCheckPanel` and follow how a panel is composed there.**
- Produces: `cloudflareStatusKey` and `cloudflareZonesKey`. Follow `adminAppsKey`'s lesson from Phase 1E: **key it specifically enough that it cannot prefix-match a sibling.** Bare `["admin","apps"]` once invalidated every per-app subview.

- [ ] **Step 1: Write the failing tests**

- Not configured: the panel offers a token field and an account ID field.
- Configured: it shows the account ID and the four-character hint, **and no full token field pre-filled with anything.**
- Saving a bad token surfaces the fault's message and **stays on the form with the entered value intact** — retyping a 40-character token because the account ID had a typo is a bad experience.
- Saving a good token shows the zones.
- The token input is `type="password"` and has `autoComplete="off"`.
- Removing credentials goes through `ConfirmDialog` — it is destructive and, after 2C, would strand a provisioned tunnel. **Do not write a second confirmation UI**; `ConfirmDialog` exists and is used across the admin surfaces.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/web/routes/settings`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Mount it in `Settings.tsx` beside the host-check panel.

**The token must never enter the query cache.** It is write-only: the mutation sends it, the component clears it from local state on success, and nothing reads it back. Phase 1F's carry-forward is explicit that reveal is per-key and uncached because raw mode had left every secret in the TanStack cache for five minutes.

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm exec vitest run src/web/routes/settings`
Expected: PASS.

- [ ] **Step 5: Prove the binding, and mind the harness**

Mutate the panel to render the token from state into a visible field; the "no full token" test must fail.

**If a binding check comes back green, suspect the harness before believing the code.** TanStack's `notifyManager` defers re-renders through `setTimeout(0)` and RTL's `act()` can mask that deferral entirely — this project has measured binding checks that could not be made to fail against a genuinely worse implementation. Say so rather than declaring the test good.

- [ ] **Step 6: Gates and commit**

Report the initial chunk size — 411.16 kB currently, with `ComposeTab` a separate ~586 kB lazy chunk.

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Add the Cloudflare credentials panel to Settings

The token is write-only: the mutation sends it, the field clears on
success, and nothing reads it back. The panel shows four characters of
it, which distinguishes two tokens and is useless if leaked."
```

---

## Self-Review

**1. Spec coverage.** This plan implements §6's **Credentials** subsection and nothing else. Every other §6 subsection — the managed `cloudflared` stack, cloudflared networking, exposing an app, the service token and reusable policy, deprovisioning, adoption and drift — is assigned to a named later sub-phase in the table above. **Adoption is explicitly deferred rather than forgotten**, with the reason stated.

One §6 requirement is deliberately only partly met here and is flagged in the code as well as here: the permission table lists five permissions, and Task 2 verifies one. The alternative — probing each permission at setup — means writing calls against four endpoint groups this phase has no other reason to touch, and getting them wrong in a way that rejects a valid token. The `permission` fault carries the diagnosis to wherever it surfaces instead.

**2. Placeholder scan.** No "TBD" or "handle errors appropriately". The one genuinely open item — the account-owned-token verify endpoint — is handled by *not depending on it*, with the reasoning given, rather than by leaving a gap for the implementer to guess at.

**3. Type consistency.**
- `createCloudflareClient(opts) → CloudflareClient` defined in Task 1, consumed in Task 2.
- `CloudflareError.fault` is the same `CloudflareFault` union in Tasks 1, 2 and 3; Task 3 renders its message, so the enum must reach the client — `src/shared/cloudflare.ts` is where it belongs, not `src/server/`.
- `CloudflareStatus` is a discriminated union on `configured`, so the panel cannot read `accountId` off an unconfigured status.
- `CloudflareZone` is shared between the route's response and the panel.
- `now`/`sleep` injection matches `Scheduler`'s existing `now`/`random` convention rather than introducing a second one.

**4. The risk I want a reviewer to look hardest at.** Every test here runs against an injected `fetch`, which means **the whole phase is verified against my own belief about Cloudflare's wire format.** That belief is stated explicitly in "What is known and what is not" so a reviewer can challenge it rather than absorb it. The mitigation is structural: verification exercises a real permission, so the first time an admin saves a token, the transport, auth header, envelope parsing and pagination are all exercised against the real API at once — and they fail loudly at the moment a human is watching, rather than silently in a later sub-phase.
