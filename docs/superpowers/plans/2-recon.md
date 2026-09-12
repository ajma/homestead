# Phase 2 recon

Spec read: `docs/superpowers/specs/2026-09-09-homestead-design.md:410-508` (§6).

## Where §12 is wrong

§12 (pre-Phase-1) claims the external probe is "a new `ProbeRunner` plus a migration, not a
change to the scheduler, history schema, or status UI." That much held — `createHttpRunners`
(`src/server/monitoring/http-runner.ts:69-212`) already ships an `external` runner, the scheduler
takes `runners: Record<ProbeRow["kind"], ProbeRunner>` (`src/server/monitoring/scheduler.ts:47`)
and is already wired with `http_external: httpRunners.external` (`src/server/index.ts:68`). So
the *scheduler* claim is right.

But §12 undersold what else Phase 2 actually touches, in three ways the spec doesn't call out:

1. **`isSystem` is a genuine conflict, not a slot Phase 2 "owns" cleanly.** Two guards already
   read it with contradictory doc comments — `src/server/routes/apps.ts:620` ("marks the managed
   cloudflared stack, which Phase 2 owns") vs `src/server/routes/jobs.ts:33-38` ("a self-adopted
   Homestead"). Nothing sets `isSystem: true` anywhere outside tests (verified: no production
   `insert(apps)` or `update(apps)` call sets it — `src/server/routes/apps.ts:340,443`). Phase 2
   can't just "flag" it; it must first settle what the flag means, because a future
   self-adoption feature and the cloudflared app would otherwise collide on the same boolean.
2. **`createHttpRunners` is only structurally wired, not functionally complete.** It's called as
   `createHttpRunners({ fetch })` with no `accessCredentials` (`src/server/index.ts:59`), so
   every `http_external` probe today permanently returns `degraded` / "no Access service token
   configured" (`src/server/monitoring/http-runner.ts:144-153`). §12's "not a change to the
   scheduler" is true, but it implies more completeness than exists — there is real work left
   (wiring a credentials source) inside the interface it praises as already-done.
3. **The job runner has no multi-step, non-compose concept at all** (see Q5) — the expose flow's
   "four idempotent steps with reverse-order rollback" has no home in the current `JobRunner`,
   which is hardwired to exactly one `docker compose` child process per job. This is a bigger
   gap than a migration.

## Answers

**1. External probe.** Runner exists and is scheduler-wired (`src/server/index.ts:59-68`), and is
fully reachable today: `src/server/routes/probes.ts:23` accepts `kind: "http_external"` in the
create body, and `src/web/routes/edit/ProbesPanel.tsx:28` lists it in `CREATABLE_KINDS`. It does
send `cf-access-client-id` / `cf-access-client-secret` headers (`http-runner.ts:156-157`), but the
credential source (`deps.accessCredentials`) is never supplied, so it always resolves to `null`
and the probe always reports `degraded`. An admin can create one right now; it will never work.

**2. Credentials storage.** `SecretStore` (`src/server/crypto/secrets.ts:33-63`) is a flat
key→AES-256-GCM-blob table (`secrets.key` is the only key, no app scoping —
`src/server/db/schema.ts` secrets table has just `key, ciphertext, iv, tag, updatedAt`). It is
generic by construction — any string name, so it *can* hold account-level secrets (e.g.
`cloudflare_api_token`) today with zero schema change. It is also currently **unused**: grep
finds no `.get`/`.set` call anywhere outside DI wiring (`src/server/index.ts:101`,
`src/server/app.ts:71`) — Phase 1 built the store but nothing calls it yet. No table holds
`HOMESTEAD_ACCESS_TEAM_DOMAIN`/`HOMESTEAD_ACCESS_AUD`'s database-backed successor; `settings`
(`schema.ts`, key/value, used for setup flags) is the closest existing shape but nothing populates
Access config into it today.

**3. Dormant Access path.** `src/server/auth/access-plugin.ts` has `verifyAccessJwt` (JWKS fetch,
signature, `exp`, and **required** `aud` check — `access-plugin.ts:44-48`) and
`isAccessEnabled(config) => config.accessEnabled` (`access-plugin.ts:106-107`), which is exactly
`config.ts:84`'s `accessTeamDomain !== null && accessAud !== null`. It is exercised only by its
own unit test (`access-plugin.test.ts`) — no route, plugin registration, or Better-Auth wiring
calls `isAccessEnabled` or `verifyAccessJwt` in `src/server` outside the test file. It's a pure
function sitting unregistered; Phase 2 (or 1's remaining auth work) has to actually mount it as a
Fastify preHandler/plugin and hand it a live JWKS fetcher.

**4. `isSystem`.** `apps.ts:620-621` blocks `DELETE /api/apps/:id` ("system_app") reasoning it's
the cloudflared stack Phase 2 owns; `jobs.ts:33-43` blocks all lifecycle actions
(`up`/`down`/`restart`/`pull`) reasoning it's a self-adopted Homestead process that can't
gracefully restart itself. Both guards behave identically (409 `system_app`) but justify it with
different futures. Nothing sets the flag in production code today (only tests). Needs one
resolution before Phase 2 ships: either two distinct flags, or one flag whose semantics are
written down and both comments updated to match.

**4b.** No file references `network_mode` or container networking mode in application logic —
only `config.ts:19` (a comment) and JSON-schema/editor-completion files for the compose YAML
editor. Nothing branches on it. Homestead's own move to host networking is safe as far as the
codebase is concerned; nothing currently assumes otherwise.

**5. Jobs/rollback.** `JobRunner.start` (`src/server/apps/job-runner.ts:99-162`) always spawns
exactly one `host.runCompose(...)` child process for one of `JOB_KINDS = ["up","down","restart",
"pull"]` (`job-runner.ts:8,12-17`) and writes one `jobs` row. There is no concept of a job with
multiple ordered steps, no per-step success/failure tracking, and no rollback mechanism anywhere
in this file. A four-step idempotent-with-rollback expose flow cannot run inside this runner as
written — it needs a materially different runner (a step-sequence executor that records each
step's outcome, e.g. as job "chunks" or a `job_steps` table) rather than an extension of
`ARGS`/`JOB_KINDS`, since those are fundamentally "one compose verb" abstractions. On the mutex:
`running` is keyed by `appId` (`job-runner.ts:49,100`), and an expose job is naturally scoped to
one app too, so a *separate* runner keyed the same way composes fine — but if expose reuses
`JobRunner` itself, its mutex would also block a concurrent `up`/`restart` on the same app, which
may or may not be desired and isn't discussed in §6.

**6. HTTP client pattern.** No shared helper exists. `registry.ts` (`src/server/apps/
registry.ts`) is a bespoke, well-hardened one-off: inline `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
per call (lines 152,165,178), a single hand-rolled retry after a 401 challenge (lines 155-180),
and an `onError` callback for classification — no retry/backoff library, no shared timeout
wrapper. `http-runner.ts` duplicates the same `AbortSignal.timeout` pattern independently
(line 111). `scheduler.ts` has its own one-off `withTimeout` (`scheduler.ts:19-33`) for a
*different* problem (racing a non-abortable dockerode promise). Three call sites, three
independent timeout mechanisms, zero shared abstraction — a Cloudflare API client would be a
fourth bespoke implementation unless one is extracted first.

**7. Schema.** More exists than §12 implies: `src/server/db/schema.ts` already has an `exposures`
table (per-app: `hostname`, `zoneId`, `dnsRecordId`, `tunnelId`, `ingressService`, `accessAppId`,
`accessAppAud`, three `*CreatedByUs` booleans, `state`, `lastError`, `lastSyncedAt`), explicitly
commented "Unused in Phase 1. Present because the data model cannot be phased." Missing: no table
for the account-level API token/account ID (the `secrets` KV can hold the token; account ID has
no home), no table for the tunnel itself as a first-class row (only `exposures.tunnelId`, a
string — fine for one tunnel, awkward if adoption/rotation needs tunnel metadata), no service
token row with `expires_at` or the reusable policy ID anywhere. Migrations: single generated file
`drizzle/migrations/0000_tiny_zzzax.sql` via `pnpm db:generate` (`drizzle-kit generate`,
`package.json:21`) — standard drizzle-kit flow, nothing bespoke.

**8. UI surfaces.** Per-app edit tabs live in `src/web/routes/edit/` (`OverviewTab.tsx`,
`ComposeTab.tsx`, `EnvTab.tsx`, `ContainersTab.tsx`, `LogsTab.tsx`, `ProbesPanel.tsx`) — an
`ExposureTab.tsx` slots in beside these. `src/web/routes/Settings.tsx` currently has only "Host
check" and `UserManager`; its own comment ("Spec §9's 'can be completed later from settings'
promise covers this the same way it covers Cloudflare") signals the authors already expected a
Cloudflare credentials section here, but none exists yet. Onboarding: `SETUP_STEPS` in
`src/shared/setup.ts:21` is `["admin", "host", "import", "users"]` — **only four steps, no
placeholder slot at all** for a fifth "expose" step; `SetupWizard.tsx` derives its current step
purely from `SETUP_STEPS.find(...)` (`SetupWizard.tsx:156`), so adding step 4 means extending the
tuple and adding a new step component, not filling in a stub.

## Proposed decomposition

1. **2A — Credentials & Cloudflare API client** (small-medium). Account token/ID storage
   (reuse `SecretStore` + one new `settings`/small table for account ID), a real HTTP client
   wrapper with timeout+retry+error classification (finally extracting the pattern `registry.ts`
   already half-built), and a `/settings` Cloudflare section to enter/validate the token. No
   tunnel or DNS work yet — just "can Homestead talk to Cloudflare and remember how."
2. **2B — `isSystem` resolution + job-runner step-sequence support** (medium). Settle the
   `isSystem` semantics conflict (design-only + guard/comment fix), and build the generic
   multi-step/rollback job execution Phase 2 needs, proven against something inert first (e.g. a
   fake two-step job) before Cloudflare touches it. This is the riskiest infra piece and should
   be validated in isolation.
2C. **2C — Tunnel provisioning + managed cloudflared app** (medium). Create/adopt the tunnel,
   write the `isSystem`-flagged cloudflared app, wire host networking. Depends on 2A (API client)
   and 2B (isSystem meaning).
3. **2D — Expose/deprovision job** (largest). The four-step ingress/DNS/Access-app/probe job with
   serialised tunnel-config mutex and reverse rollback, using 2B's step-runner and 2C's tunnel.
   Includes the service token + reusable policy (one-time setup, not per-app).
4. **2E — External probe activation** (small). Wire `accessCredentials` into
   `createHttpRunners`, finishing the already-built runner from Q1.
5. **2F — Access JWT sign-in path** (small-medium). Mount `verifyAccessJwt`/`isAccessEnabled`
   as an actual Fastify plugin/Better-Auth path — currently just a tested, unregistered function.
6. **2G — Onboarding step 4 + drift reconciliation + UI polish** (medium). Extend `SETUP_STEPS`,
   build the wizard step and `ExposureTab.tsx`, add the periodic drift-flagging reconcile job and
   service-token expiry warning UI.

Build **2A first** — everything else calls the Cloudflare API through it, and it's cheap to prove
correct in isolation (mock the API, no tunnel/DNS side effects to unwind).

Defer/drop candidates: the periodic drift-reconcile in §6's "Deprovisioning, adoption, drift" is
described as UI-flagging only, not auto-fixing — fine to defer to a later sub-phase (2G) or even
past Phase 2, since it's read-only reporting, not exposure functionality. Existing-tunnel/Access
"adoption by hostname match" is meaningfully complex and separable from first-provision — consider
dropping it from the initial cut and shipping create-only first, adding adoption once provisioning
is proven.
