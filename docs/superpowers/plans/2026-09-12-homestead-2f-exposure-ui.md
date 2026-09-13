# Homestead Phase 2F — Exposure UI, Onboarding Step 4, and Drift

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make everything Phase 2 built reachable by a human, and close the last gap that has been deferred three times.

**Architecture:** Eleven Cloudflare routes exist and exactly one has a UI consumer. This phase is mostly wiring them to surfaces that already have shapes to follow — an edit tab, a settings panel, a wizard step. Two things are not wiring: detaching the long-running provision and expose requests so they return immediately, and marking Homestead as its own `self` app, which is what finally makes 2E's database-backed Access settings reachable in production.

**Tech Stack:** React, TanStack Query, react-router-dom 7 (data router), Fastify, Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — §6 **Deprovisioning, adoption, drift**, §8 for the UI, §9 step 4 for onboarding.

**Carry-forwards:** 2A's through 2E's. **2E's names all three of this phase's carried items.**

**This is the last sub-phase of Phase 2.**

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`.
- Baseline **1666 tests**.
- **No test may make a real network call.** An unmocked `fetch` throwing has already produced a false pass in this project — if a test asserts rejection, confirm it rejects for the reason you intend.
- **Add a new migration only if needed; never rewrite `0000`–`0003`.** Drizzle's libsql migrator gates on journal timestamps, not content hashes, and **the test VM holds real data: one user, one adopted app, and a completed setup wizard.**
- **Never render a secret.** The Cloudflare API token, the tunnel token and the monitor service-token secret are all write-only.
- **The initial chunk is ~420 kB** and `ComposeTab`/`EnvTab` must stay separate lazy chunks. Report it after every task touching `src/web`.
- `.tsx` test files need `// @vitest-environment jsdom` as line 1.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, Biome clean **by exit code**:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain --untracked-files=all` empty at the end of each task; no scratch files.

## Harness traps, all measured in this repo

- **TanStack's `notifyManager` defers re-renders through `setTimeout(0)` and RTL's `act()` can mask that deferral.** If a binding check comes back green, suspect the harness before believing the code, and say so.
- **jsdom 30 does not implement `HTMLDialogElement.showModal`/`.close`** — `DialogShell` works around it; follow that.
- **jsdom gives zero geometry** and does not move focus on synthetic `keyDown`.
- **A test helper supplying a convenient value silently removes the production value from coverage** — 2E shipped a trusted-proxy default that no test exercised because every test routed through a synthetic address `test-helpers.ts` appends.

---

### Task 1: Detach the long-running requests

Carried from 2C and still open. `stepJobs.start` awaits the whole sequence, so `POST /api/cloudflare/tunnel` and `POST /api/apps/:id/expose` return only when the work finishes.

That is not merely slow. **It dies at a 524 once Homestead is itself behind this tunnel** — and Task 2 is what makes that configuration possible, so this must land first. It also causes two known limitations: the initiating tab sees no streamed output until the request resolves, and 2C had to move its audit row ahead of the sequence to exist at all.

**Files:** modify `src/server/apps/step-job-runner.ts`, `src/server/routes/cloudflare-tunnel.ts`, `src/server/routes/cloudflare-expose.ts`, and their tests.

- [ ] **Step 1: Write the failing tests**

- `start` returns a job id **without waiting** for the sequence. Assert by timing against a deliberately slow step, or by asserting the row is still `running` when `start` resolves.
- The job still reaches a terminal state afterwards, with the same output and the same rollback behaviour. **Every existing step-runner test must still pass** — detaching must not change what a sequence does, only when the caller learns of it.
- The `AppLock` is still held for the sequence's duration, not just until `start` returns. A detached sequence that releases its lock early is worse than a blocking one.
- **Shutdown still waits.** Phase 2B added `stepJobs` to `Closeable` with a `shutdown()` that waits precisely so a killed sequence does not orphan Cloudflare resources. A detached sequence must still be awaited there — confirm with the existing test, and if it now passes vacuously, fix it.
- A failure in a detached sequence is still recorded, and `undoFailures` still reach the job output.

- [ ] **Step 2-4: Red, implement, green**

Once detached, revisit 2C's audit-ordering workaround and 2C's renamed test about the initiating tab. **Both were shaped by this limitation.** If either can now be made true, make it true and say so; if not, say why.

- [ ] **Step 5: Prove the bindings**

1. Re-await the sequence in `start` → the timing test fails.
2. Release the lock when `start` returns → the lock test fails.

- [ ] **Step 6: Gates and commit**

---

### Task 2: Homestead knows which app is itself

**Deferred three times.** Phase 1I dropped it as a design question, 2B settled what `systemKind: "self"` *means* without assigning who sets it, and 2E resolves Access settings from a `self` app that cannot exist — so 2E's database path is unreachable in production and only the environment override works.

**Files:** modify `src/server/apps/adoption.ts` and/or the adopt route, `src/server/routes/apps.ts`, and tests.

- [ ] **Step 1: Decide how Homestead recognises itself, and write down the reasoning**

Two honest options:

- **Self-detection.** Homestead runs in a container; the Docker socket is already mounted and `dockerode` is already a dependency. `HOSTNAME` inside a container is its own container id, from which the container's compose project and working directory can be read. If a discovered directory's project matches, it is us.
- **An explicit admin choice** in the exposure or settings UI.

**Detection is better if it is reliable and cheap, because the admin cannot get it wrong** — and getting it wrong means either Homestead can stop itself, or its own Access settings never resolve. But it must degrade honestly: running outside a container (development, `pnpm dev`) it must simply find nothing, not guess.

**Pick one, implement it, and state the reasoning and the failure mode in a comment.** If you choose detection, an explicit override must still be possible, because a detection that is wrong and unoverridable is worse than no detection.

- [ ] **Step 2: Write the failing tests**

- An adoption scan of the directory Homestead itself runs from marks it `systemKind: "self"`.
- Every other directory is unaffected.
- **Running outside a container finds nothing and marks nothing** — no guessing.
- Once marked, 2B's guards apply: lifecycle actions refused, delete refused. Those tests exist; confirm they now fire against a real marked app rather than a seeded one.
- Exposing the `self` app writes its `aud` and team domain as the Access settings, so 2E's database path resolves. **This is the assertion that closes the three-times-deferred gap** — write it end to end.

- [ ] **Step 3-6: Red, implement, green, prove, commit**

---

### Task 3: The exposure tab

**Files:** create `src/web/routes/edit/ExposureTab.tsx` + test; modify the edit page's tab list and `src/web/api/cloudflare.ts`.

Read `src/web/routes/edit/OverviewTab.tsx` and `ProbesPanel.tsx` first and follow their shape. The tabs are child routes of the edit page — `App.tsx` uses a data router since Phase 1I.

- [ ] **Step 1: Write the failing tests**

- **With no tunnel provisioned, the tab explains that and links to Settings rather than offering Expose.** Offering an action that cannot succeed is a trap; 2C made the same call for Provision.
- With a tunnel and no exposure: a hostname field, a zone picker populated from `GET /api/cloudflare/zones`, and an Expose button.
- While an expose job runs, the button is disabled and `JobOutput` streams it. **Reuse `JobOutput`** — it already streams a job and is used by `ActionBar` and `AdminApps`.
- With an exposure: the hostname, a link to it, the Access application, and a Remove button behind `ConfirmDialog`.
- **A failed expose shows what was rolled back and, prominently, what was not.** `undoFailures` is the list of real Cloudflare resources now orphaned, and it is the only way a user learns to go clean up by hand.
- **A deprovision refusal explains the actual reason and what to do**, and — per 2D — a retry after the user acts must be able to succeed. 2D shipped a refusal whose instructions could not unblock it; do not reintroduce that in the copy.
- **A viewer never sees this tab**, and navigating to its URL directly sends them to the launcher. Phase 1G proved the viewer boundary by navigation, not by link visibility; follow that.

- [ ] **Step 2-5: Red, implement, green, prove**

Binding check: render Expose with no tunnel → its test fails.

- [ ] **Step 6: Gates and commit.** Report the initial chunk size.

---

### Task 4: Settings — monitor token, expiry warning, tunnel

**Files:** modify `src/web/routes/settings/CloudflarePanel.tsx` + test, `src/web/api/cloudflare.ts`.

- [ ] **Step 1: Write the failing tests**

- The monitor service token's state is shown: configured or not, and **its expiry with advance warning.** §6: tokens return a concrete `expires_at`, and "a year after setup every external probe would begin failing simultaneously with nothing actually broken". 2D persisted the date; this is what makes it useful.
- **The warning appears before expiry, not after.** Choose a threshold, state it, and test the boundary on both sides — a warning that appears the day it breaks is not a warning.
- Rotation is offered, goes through `ConfirmDialog`, and afterwards the new expiry is shown.
- **Never render the client secret.** Assert it is absent from the DOM.
- The Access sign-in state is shown — resolved from the database, from the environment, or inert — because "inert" is a state an admin will otherwise not understand. 2E's `GET /api/cloudflare/access` serves this.

- [ ] **Step 2-6: Red, implement, green, prove, commit.** Report the initial chunk size.

---

### Task 5: Onboarding step 4

§9 step 4 is Cloudflare, and Phase 1G explicitly left it out. `SETUP_STEPS` is `["admin", "host", "import", "users"]` (`src/shared/setup.ts:21`).

**Files:** modify `src/shared/setup.ts`, `src/server/routes/setup.ts`, `src/web/routes/setup/SetupWizard.tsx`; create `StepCloudflare.tsx` + test.

- [ ] **Step 1: The migration hazard, before any code**

**Adding a step changes a persisted allow-list, and the test VM has a completed wizard.** An installation with `completedAt` set must **not** be dragged back into onboarding by the appearance of a new incomplete step.

`App.tsx` gates on `completedAt`, so this should already hold. **Verify it rather than assuming** — write the test first: an installation with `completedAt` set and no `cloudflare` in `completedSteps` stays out of the wizard. Phase 1G's carry-forward records that a comparable assumption produced a Critical lockout.

- [ ] **Step 2: Write the failing tests**

- The step follows the contract the other four implement — `SetupStepProps` with `state`, `pending`, `onComplete`, `onFail`, `skippable`.
- **It is skippable**, and skipping completes the wizard. §6 and §10 both say Cloudflare "can be completed later from settings"; a first-run wizard that requires a Cloudflare account to finish would block every user who does not have one.
- Completing it stores credentials and offers to provision the tunnel.
- Resuming lands on this step when it is the first incomplete one.

- [ ] **Step 3-6: Red, implement, green, prove, commit**

---

### Task 6: Drift

§6: "A periodic reconcile compares recorded state against live Cloudflare state and **flags drift in the UI rather than silently correcting it**; a tool that fights dashboard edits is worse than one that reports them."

**Files:** create `src/server/cloudflare/reconcile.ts` + test; modify a route and the exposure tab.

- [ ] **Step 1: Write the failing tests**

- An exposure whose DNS record is gone in Cloudflare is flagged, **not recreated.**
- An ingress rule missing from the tunnel config is flagged.
- An Access application deleted in the dashboard is flagged — **this one matters most**, because it means a hostname is routed and no longer protected.
- A hostname routed to a different service than recorded is flagged.
- **Nothing is ever written to Cloudflare by the reconcile.** Assert the client's write methods are never called. This is the whole design decision and it is one line away from being violated by a well-meaning fix.
- Drift on one exposure does not stop the others being checked.

- [ ] **Step 2-6: Red, implement, green, prove, commit**

Binding check: make the reconcile repair a missing DNS record → the "flags, not recreates" test fails.

---

## Self-Review

**1. Spec coverage.** §6's drift reconcile and its flag-don't-correct rule; §6's service-token expiry warning; §9 step 4; §8's per-app exposure surface. Combined with 2A–2E, **§6 is then complete except for adoption of pre-existing tunnels and Access applications by hostname scan**, deferred in 2A because the account is a clean slate — though note that 2C and 2D already handle the *adopted* case correctly wherever a resource turns out to pre-exist, so what remains unbuilt is the discovery scan, not the safety.

**2. Placeholder scan.** No "TBD". Three decisions are delegated with their grounds: how Homestead recognises itself, the expiry warning threshold, and whether 2C's audit-ordering workaround and renamed test can be undone once Task 1 lands.

**3. Type consistency.** `SetupStepProps` in Task 5 is the existing contract the other four steps implement — do not widen it for one step. `SETUP_STEPS` is both a type source and a persisted allow-list, which is exactly why Task 5 step 1 exists. The exposure DTO Task 3 renders is what 2D's routes already return; if the tab needs a field they do not carry, that is a server change and should be called out rather than smuggled into a component.

**4. What a reviewer should attack hardest.** Task 2 and Task 6, for opposite reasons. Task 2 changes what Homestead believes about itself, and a false positive means an app an admin cannot stop, while a false negative means Access settings that silently never resolve — and the second is invisible. Task 6's single most important property is a **negative**: that the reconcile never writes. Negative properties are the ones this project has repeatedly failed to test, and a reconcile that quietly repairs drift would look like it was working perfectly right up until it fought an admin's deliberate dashboard edit.
