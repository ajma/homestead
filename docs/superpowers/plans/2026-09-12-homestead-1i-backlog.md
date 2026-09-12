# Homestead Phase 1I — Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five carried items worth closing, and say plainly why the sixth is not one of them.

**Architecture:** Four of the five are small and independent. The fifth — migrating `react-router-dom` from the declarative `<BrowserRouter>` to `createBrowserRouter` — is the only structural change, and it exists solely to make `useBlocker` available, because `useBlocker` throws under a plain `BrowserRouter`. It is split into two tasks: a behaviour-preserving migration, then the feature it unlocks. A reviewer can reject either without the other.

**Tech Stack:** react-router-dom 7.18.3, TanStack Query, Fastify, Drizzle, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md`. This phase implements no new spec section; it closes debt from 1E–1H. Where the spec bears on an item it is cited inline.

**Recon:** `docs/superpowers/plans/1i-recon.md`. **Read it before Task 1.** It has `file:line` throughout and it corrected two of my assumptions.

**Carry-forwards:** `2026-09-11-homestead-1e-carry-forward.md` through `2026-09-12-homestead-1h-carry-forward.md`.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force` or `pnpm exec tsx`. `react-router-dom@7.18.3` is already installed and already exports `createBrowserRouter`, `RouterProvider`, `createMemoryRouter` and `useBlocker`.
- **The initial chunk must not regress.** It is 355.62 kB. `ComposeTab` and `EnvTab` are lazy-loaded behind per-tab error boundaries and CodeMirror must stay in its own ~586 kB chunk — a viewer opening the launcher must not pay for an admin-only editor. `pnpm build` is the only gate that would notice. **Report the initial chunk size after every task that touches `src/web`.**
- `.tsx` test files need `// @vitest-environment jsdom` as line 1; `src/web/test-environment.test.ts` enforces it and each new file adds a row to its sweep.
- Baseline **1315 tests**.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, and Biome clean **by exit code**, never piped to `tail`:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain` empty at the end of each task. Scratch in `/tmp`.

## Harness traps, all measured in this repo

- **TanStack's `notifyManager` defers re-renders through `setTimeout(0)`, and RTL's `act()` can mask that deferral entirely.** Some binding checks cannot be made to fail even against a genuinely worse implementation. When one comes back green, suspect the harness before believing the code, and say so.
- **jsdom gives every element zero geometry** and does not move focus on a synthetic `keyDown`.
- **Editor diagnostics in this repo contradict a clean `tsc` constantly** — seven times in the last phase alone, including claiming a module that exists cannot be found. Trust `tsc`.

## One item deliberately dropped

**Nothing creates the self-managed Homestead row.** `isSystem` protects deletion and every lifecycle action, but no flow sets it. Recon found the reason this is not a bug-fix: **the two guards disagree about what `isSystem` means.** `apps.ts:599` says it marks "the managed cloudflared stack, which Phase 2 owns"; `jobs.ts:33-38` says it marks a self-adopted Homestead. Those imply different setters, different UI and different rules — cloudflared is provisioned by Homestead, while Homestead is adopted by a human.

Deciding that here would be guessing at Phase 2's design. **Carried to Phase 2 as a design question, not a defect.** The protection being unreachable is the safe direction: nothing is currently marked system, so nothing is wrongly blocked.

---

### Task 1: Two tests that should exist

Both are pure test work. Neither changes production code, and if either turns out to need a production change, that is a finding — **report it rather than making the change quietly.**

**Files:**
- Modify: `src/web/routes/setup/SetupWizard.test.tsx`
- Modify: `src/server/routes/apps.test.ts`

**Interfaces:** Consumes and produces nothing. Test-only.

- [ ] **Step 1: Resolve the blind `SetupWizard` test**

Carried from 1G. `SetupWizard.test.tsx` has a "does not double-fire" test written against a `StepPlaceholder` that this project deleted; it now drives the real `StepImport`, whose Skip button disables itself, so the test passes for a reason unrelated to the `pendingRef` guard it is named for. A newer test backstops the guard properly.

Recon found the old test is **not** fully redundant: it still checks the Skip button's DOM-disable behaviour, which the new test does not.

So do not simply delete it. **Rename it to what it actually verifies** — the button's disabled state — and make its body assert only that. Leave a one-line comment pointing at the test that covers the `pendingRef` guard, so the next reader does not re-derive the same confusion.

Verify the split is real: delete the `pendingRef` guard from `SetupWizard.tsx` and confirm the *new* test fails and the *renamed* one does not. Then restore. Report both results. If the renamed test also fails, the two are not as separable as recon thought — say so.

- [ ] **Step 2: Cover the delete route's scope-before-system ordering**

Found in Phase 1H. `src/server/routes/apps.ts:599-600` guards `DELETE /api/apps/:id` on `isSystem`. `loadApp` scopes via `visibleAppsWhere` first, so an out-of-scope system app correctly 404s **today, by construction** — recon confirmed this is a missing test, not a live bug.

It is worth a test anyway, because the ordering is invisible: a future refactor that hoists the `isSystem` check above `loadApp` turns a 404 into a 409, which tells a scoped admin that an app they cannot see exists.

Write it against a scoped admin, following the existing scope tests in `src/server/routes/apps-scope.test.ts` — **read that file and put the test wherever its neighbours live**, rather than adding it to `apps.test.ts` if that is the wrong home.

```ts
it("tells a scoped admin nothing about a system app outside their scope", async () => {
  // Create a system app the scoped admin cannot see.
  // DELETE it as that admin.
  // Expect 404 — never 409. A 409 confirms the app exists.
});
```

Prove it binds: move the `isSystem` check above `loadApp` (re-querying the row without the scope filter), confirm this test fails with 409, and restore.

- [ ] **Step 3: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add src/web/routes/setup/SetupWizard.test.tsx src/server/routes/apps-scope.test.ts
git commit -m "Name two tests after what they actually verify

One was written against a component that has since been deleted and kept
passing against its replacement for an unrelated reason. The other never
existed: the delete route's scope check runs before its system check, so
an out-of-scope system app 404s by construction, and nothing would notice
a refactor that reversed them."
```

---

### Task 2: One query for the whole inventory's running jobs

Carried from 1G. `RowActions` → `useAppActions` → `useJobs(app.id)` hits `GET /api/apps/:id/jobs` **per row**, fetching each app's full job history to find whether one row has `status: "running"`. A twenty-app inventory fires twenty requests on load.

Recon confirmed no existing endpoint carries this, **and found the pattern to copy**: `GET /api/apps` already does exactly this for deploy history via `deployTimestamps` (`src/server/apps/deploy-timestamps.ts`, called at `apps.ts:490-495`), with a comment explaining the reasoning — "one grouped query for the whole page's deploy history … the per-row alternative is one query per app on the screen that lists every app."

Follow that pattern. Do not invent a second one.

**Files:**
- Create: `src/server/apps/running-jobs.ts`
- Create: `src/server/apps/running-jobs.test.ts`
- Modify: `src/server/routes/apps.ts` (near the `deployTimestamps` call at 490-495, and the serialisation that follows)
- Modify: `src/server/apps/serialize.ts`, `src/shared/admin.ts`
- Modify: `src/web/routes/AdminApps.tsx` (`RowActions`)
- Modify: the corresponding tests

**Interfaces:**
- Consumes: `Db`; the `jobs` table (`db/schema.ts:214-231`); the `detailed` flag already gating `deployTimestamps` at `apps.ts:490`.
- Produces: `runningJobs(db: Db, appIds: string[]): Promise<Map<string, string>>` — app id to running job id, following `deployTimestamps`' shape exactly. Read that file first and mirror it.
- The admin app DTO in `src/shared/admin.ts` gains `runningJobId: string | null`.

- [ ] **Step 1: Write the failing server tests**

Create `src/server/apps/running-jobs.test.ts`. **Read `src/server/apps/deploy-timestamps.test.ts` first and mirror its structure and its setup helpers** — this is a sibling of that module and should look like one.

Cover:
- An app with a `running` job returns that job's id.
- An app with only `succeeded` and `failed` jobs is absent from the map.
- An app with no jobs at all is absent from the map.
- An empty `appIds` array returns an empty map without querying.
- **Only the requested apps appear** — seed a running job on an app id that is not in `appIds` and assert it is absent. This is the one that catches a missing `inArray` filter.
- Two apps each with a running job both appear, with their own job ids. This catches a `Map` built with a single overwritten key.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/server/apps/running-jobs.test.ts`
Expected: FAIL — `Failed to resolve import "./running-jobs.js"`.

- [ ] **Step 3: Implement `runningJobs`**

Mirror `deploy-timestamps.ts`. One grouped query filtered by `inArray(jobs.appId, appIds)` and `eq(jobs.status, "running")`, returning a `Map<string, string>` of app id to job id.

A doc comment carrying the reasoning, in the same voice as its sibling:

```ts
/**
 * The running job for each of `appIds`, or absence when there is none.
 *
 * One grouped query for the whole page, same reasoning as `deployTimestamps` beside it:
 * the per-row alternative is one request per app on the screen that lists every app, and
 * every row was fetching that app's entire job history to answer a yes-or-no question.
 *
 * There is at most one running job per app — `JobRunner` holds a per-app mutex
 * (`job-runner.ts:49`) — so a `Map` rather than a list of lists is not a simplification,
 * it is the shape of the data.
 */
```

**If you find that invariant does not hold** — that the schema permits two running rows for one app, and the startup sweep is the only thing that cleans them — say so and decide what the map does with the second. Do not let a silent overwrite stand as if it were designed.

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm exec vitest run src/server/apps/running-jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `GET /api/apps`**

Call it beside `deployTimestamps` at `apps.ts:490-495`, gated on the same `detailed` flag — **a viewer must not pay for it**, exactly as the existing comment says of deploy history. Thread it through `toAdminApp` in `src/server/apps/serialize.ts` and add `runningJobId: string | null` to the admin DTO in `src/shared/admin.ts`.

Add a route test asserting the field appears for an app with a running job, is null otherwise, and **is absent from the viewer DTO**. That last one is the security-shaped assertion and it is the one worth writing carefully.

- [ ] **Step 6: Change the client to stop asking per row**

In `src/web/routes/AdminApps.tsx`, `RowActions` should read `runningJobId` from the row it already has instead of mounting `useJobs(app.id)`.

**Read `useAppActions` before changing it.** If it is shared with the edit page's `ActionBar`, do not change its contract — `ActionBar` is a single-app view where a per-app query is correct, and Phase 1G's carry-forward is explicit that a row action and the edit page must not diverge on what an action means. Pass the already-known state in, or give the row its own thin path; say which you chose.

- [ ] **Step 7: Prove the binding, which is about requests, not the DOM**

The DOM looks identical either way, so assert on the requests — the same technique Phase 1G's Task 9 used for the `.env` table save.

Write a test that renders the inventory with several apps and asserts **zero** calls to `/api/apps/:id/jobs`. Then revert `RowActions` to `useJobs` and confirm it fails with N calls. Restore, confirm green, and report the numbers.

- [ ] **Step 8: Gates and commit**

Report the initial chunk size.

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Fetch the inventory's running jobs in one query, not one per row

Every row was fetching its app's entire job history to answer whether one
job was running. Follows deployTimestamps beside it, which already solved
exactly this for deploy history and carries the reasoning."
```

---

### Task 3: Migrate to a data router, changing no behaviour

`src/web/App.tsx:174` renders `<BrowserRouter>`. `useBlocker` exists in react-router-dom 7.18.3 but is tagged data-router-only and **throws under a plain `BrowserRouter`** — so Task 4 is impossible without this. Recon found the blast radius is smaller than the 1F carry-forward implied: **11 routes, all in one file** (`App.tsx:132-167`), and of 8 test files that build a router, only 2 need converting.

This task changes **no behaviour**. Its whole success criterion is that the suite is still green and the app still works. Resist improving anything while you are in here.

**Files:**
- Modify: `src/web/App.tsx:132-174`
- Modify: test files only as the migration forces

**Interfaces:**
- Consumes: the 11 route definitions as they exist.
- Produces: a `createBrowserRouter` router, so `useBlocker` is available to Task 4.

- [ ] **Step 1: Read all 11 routes and write down what each does**

Before changing anything, enumerate them with their guards. Several are wrapped in `isAdmin ? <X /> : <Navigate to="/" replace />`, and the edit page has tabs as **child routes**. Phase 1G's carry-forward is explicit that the viewer boundary is tested by navigation, not by nav-link visibility, and that breaking the `isAdmin` guards fails eight tests — those eight are your safety net for this migration and they must all still pass, unchanged.

Write the list into your report. A migration that silently drops a route is the failure mode here, and 11 is few enough to check by hand.

- [ ] **Step 2: Convert**

Move the route tree to `createBrowserRouter` and render `<RouterProvider router={...} />`. Keep the element structure, the guards, the nesting and the `index` routes identical.

**Build the router outside the component, or memoise it.** A router recreated on every render remounts the whole tree — this is the single most common way this migration goes wrong, and its symptom is state that vanishes on unrelated updates.

If the guards depend on `me` from a hook, that forces a decision: either the router is created inside the component and memoised on the values the guards read, or the guards move into route elements that read context themselves. **Pick one and say which and why.** The second is usually cleaner but is a bigger diff; the first is smaller but must get its dependency list exactly right.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm exec vitest run`
Expected: green. Any failure here is the migration changing behaviour — fix the migration, not the test, unless the test was asserting something only the old router could do. **If you change a test assertion, say exactly which and why.**

- [ ] **Step 4: Convert only the test files that force it**

Recon says only `ComposeTab.test.tsx` and `EnvTab.test.tsx` will need `createMemoryRouter`/`RouterProvider`, and only because Task 4 will add blocking to those components. The other 6 `MemoryRouter` files can stay.

**Leave them.** Converting all 8 for uniformity is a larger diff with no behaviour behind it, and this task's value is being small enough to review.

- [ ] **Step 5: Verify by hand, because the suite cannot see everything**

jsdom cannot tell you the browser back button works. Build and click through:

```bash
pnpm build
# serve it however the repo's dev flow does; check the repo's package.json scripts
```

Check: a deep link to `/apps/<slug>/compose` loads; the back button returns to the previous tab rather than leaving the app; a viewer hitting `/apps` lands on the launcher. **Report what you checked and what you saw.** If you cannot run a browser in this environment, say so plainly rather than implying you checked.

- [ ] **Step 6: Gates and commit**

Report the initial chunk size — a router change can move it.

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Move to a data router, changing nothing else

useBlocker is data-router-only and throws under BrowserRouter, so in-SPA
unsaved-changes protection is unreachable without this. Eleven routes,
one file, same elements and same guards."
```

---

### Task 4: Warn before navigating away from unsaved edits

Carried from 1F. `ComposeTab.tsx:168-182` installs a `beforeunload` listener, which covers closing the tab and reloading — and nothing else. Clicking another tab inside the app discards a half-written compose file silently.

Recon found `beforeunload` exists **only** in `ComposeTab`. `EnvTab` has unsaved state and no protection at all, which is worse: it edits credentials.

**Files:**
- Modify: `src/web/routes/edit/ComposeTab.tsx`, `src/web/routes/edit/EnvTab.tsx`
- Create: `src/web/lib/use-unsaved-changes.ts` and its test
- Modify: `ComposeTab.test.tsx`, `EnvTab.test.tsx`

**Interfaces:**
- Consumes: `useBlocker` from react-router-dom, available only after Task 3.
- Produces: `useUnsavedChanges(dirty: boolean): { blocked: boolean; proceed: () => void; cancel: () => void }` — one hook wrapping both `useBlocker` and the `beforeunload` listener, so a caller declares dirtiness once and gets both protections.

- [ ] **Step 1: Write the hook's tests first**

Extract the decision into a hook and test the hook, rather than testing through two components. This project's carry-forwards say this repeatedly: where a guard cannot be mutation-tested through the component, extract it into something that can be.

Cover: clean state does not block; dirty state blocks; `proceed` lets the navigation through; `cancel` leaves you where you are; going clean while blocked releases the block (a save completing mid-dialog must not trap the user).

That last case is the one that bites. A user clicks away, gets the dialog, and the in-flight save resolves — the block must lift.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/web/lib/use-unsaved-changes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Wrap `useBlocker` and keep the existing `beforeunload` behaviour, which `ComposeTab.tsx:168-180` implements with a ref read by a listener installed once on mount — **preserve that ref pattern and its comment.** It exists because rebuilding the listener on every keystroke was the alternative.

- [ ] **Step 4: Use it in both editors**

Present the block with `ConfirmDialog`, which already exists and is already used for destructive confirms across the admin surfaces. Do not write a second confirmation UI.

Copy matters here: the choice is discard-and-leave versus stay-and-keep-editing, and the destructive option must be the one that is harder to hit by reflex.

- [ ] **Step 5: Run and watch them pass**

Run: `pnpm exec vitest run src/web/lib src/web/routes/edit`
Expected: PASS.

- [ ] **Step 6: Prove the binding**

Make `useUnsavedChanges` always report clean — `useBlocker(() => false)` — and run the editor tests. They must fail. Restore.

Then the harness check this repo requires: if a binding check comes back **green**, do not conclude the code is fine. `act()` can mask TanStack's `notifyManager` deferral and has produced false greens here before. Say so and find another way to observe it.

- [ ] **Step 7: Gates and commit**

Report the initial chunk size. The hook must not pull CodeMirror into the main chunk — it lives in `src/web/lib`, imported by lazy-loaded tabs, so check rather than assume.

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Warn before navigating away from unsaved compose or env edits

beforeunload covered closing the tab and nothing else, so switching tabs
inside the app discarded a half-written compose file silently. EnvTab had
no protection at all, and it edits credentials."
```

---

### Task 5: A drift signal for the pinned compose schema

Carried from 1F. The compose schema is vendored at a pinned SHA and refreshed by hand. Nothing notices when it falls behind, and the failure is silent in the direction that trains users to ignore the feature: keys compose adds upstream read as unknown and draw a warning, and a gutter that cries wolf is one people stop reading.

**Recon confirmed there is no CI in this repo** — no `.github/workflows`, nothing. So a drift check has nowhere to run automatically, and **building CI is out of scope for this phase.**

That makes this the same shape as Phase 1H's `verify-mount-preflight.sh`: a written, runnable manual gate for something no in-process test can check. That precedent was reviewed and accepted, and the reasoning holds — a manual gate that runs beats an automated test that cannot fail. **Do not add a test that fetches from the network at test time**; a suite that fails when GitHub is slow is a suite people learn to re-run rather than read.

**Files:**
- Create: `scripts/check-schema-drift.ts` (or `.sh` — match whatever `scripts/vendor-compose-schema.ts` already is)
- Modify: `src/shared/schema/PINNED.md`, `package.json` (a script entry)

- [ ] **Step 1: Read the existing tooling**

`scripts/vendor-compose-schema.ts` already fetches and pins. **Reuse its fetch and its URL construction** rather than writing a second one that can drift from it. Read `src/shared/schema/PINNED.md` for how the pin is recorded.

- [ ] **Step 2: Write the check**

It should report, in a form a human can act on:
- the pinned SHA and the current upstream SHA on the default branch;
- whether they differ;
- **if they differ, which top-level service keys are new upstream** — that is the actionable part, because a schema commit that only touches formatting is not worth a refresh, and one that adds three service properties is.

Exit non-zero on drift so it can become a CI step later without modification.

- [ ] **Step 3: Run it**

Against the real upstream. Report the pinned SHA, the current SHA, whether they differ, and any new keys. **If the pin has drifted, do not refresh it as part of this task** — report it. Refreshing the schema changes editor behaviour and deserves its own review.

- [ ] **Step 4: Document it**

Add to `PINNED.md`: how to check for drift, how to refresh, and what the failure looks like if you do not — unknown-key warnings on correct files, which is the failure that teaches people to ignore the gutter.

Add the script to `package.json`. Name it consistently with the existing scripts there.

- [ ] **Step 5: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Add a drift check for the pinned compose schema

The pin is refreshed by hand and nothing notices when it falls behind.
The failure is silent and self-defeating: keys compose adds upstream read
as unknown and draw a warning on a correct file, and a gutter that cries
wolf is one people stop reading. No CI exists to run this, so it is a
manual gate, exiting non-zero so it can become a CI step unchanged."
```

---

## Self-Review

**1. Coverage.** Six carried items were in scope. Five have tasks: the blind `SetupWizard` test and the missing delete-route test (Task 1), the per-row jobs query (Task 2), the router migration and the unsaved-changes protection it unlocks (Tasks 3 and 4), and the schema drift signal (Task 5). The sixth — nothing setting `isSystem` — is dropped with its reasoning stated above, because recon found an unresolved design disagreement between the two guards' own comments, and settling it here would be guessing at Phase 2.

Two carried items are **not** in this plan and should not be: `target="_blank"` from a standalone PWA needs a real phone, and Phase 2 is a phase, not a backlog item.

**2. Placeholder scan.** No "TBD" or "handle errors appropriately". Five places delegate a decision, and each names the decision, the options and the grounds: Task 1 step 1 (whether the two tests are truly separable), Task 2 step 3 (what the map does if the one-running-job-per-app invariant does not hold), Task 2 step 6 (whether `useAppActions` is shared with `ActionBar`), Task 3 step 2 (where the guards live after the migration), and Task 5 step 3 (report drift, do not fix it). Task 4's copy requirement is stated as a constraint — the destructive option must be harder to hit by reflex — rather than as literal strings, because it is a UX judgment.

**3. Type consistency.**

- `runningJobs(db, appIds) → Promise<Map<string, string>>`: defined Task 2 step 3, consumed step 5. Mirrors `deployTimestamps(db, ids) → Promise<Map<string, number>>`, which recon confirms exists and is called at `apps.ts:491`. The value type differs deliberately — a job id, not a timestamp.
- `runningJobId: string | null` added to the admin DTO in Task 2 step 5, read by `RowActions` in step 6. Consistent, and explicitly absent from the viewer DTO.
- `useUnsavedChanges(dirty) → { blocked, proceed, cancel }`: defined Task 4 step 1, used step 4. `proceed`/`cancel` match `useBlocker`'s own vocabulary in react-router-dom 7, which reduces the chance of a wrapper that inverts its own semantics.
- Task 3 produces the data router that Task 4 consumes; Task 4 cannot start before Task 3 lands, and Task 4's step 1 says so.

**4. Ordering risk.** Tasks 1, 2 and 5 are independent of everything. Tasks 3 and 4 are strictly ordered. Nothing else shares a file: Task 2 touches `AdminApps.tsx`, Tasks 3 and 4 touch `App.tsx` and the edit tabs. The only common file is `package.json` (Task 5 adds a script), and only if Task 2's implementer also edits it, which nothing in Task 2 requires.
