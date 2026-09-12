# Phase 1I recon — six carry-forward items

Read-only reconnaissance. No code changed.

## 1. The router migration

**Current setup.** `src/web/App.tsx:174` wraps everything in the declarative `<BrowserRouter>` component, not `createBrowserRouter`. `Routed()` (`App.tsx:71-169`) renders plain `<Routes>`/`<Route>` trees — two different trees depending on setup state (`App.tsx:132-135` pre-setup, `App.tsx:144-167` post-setup).

**Every route, file:line** (all in `App.tsx`, nowhere else — `Settings.tsx` and `AppLayout` have no nested `<Route>`s of their own):
- `/setup` → `SetupWizard` (`App.tsx:133`, pre-setup tree) and a redirect-to-`/` version (`App.tsx:151`, post-setup)
- `*` → redirect to `/setup` (`App.tsx:134`, pre-setup only)
- `/` → `Launcher` (`App.tsx:153`)
- `/apps` → `AdminApps` (`App.tsx:154`)
- `/apps/:slug/*` → `EditApp`, with children (`App.tsx:155-163`):
  - index → redirect to `overview` (`App.tsx:156`)
  - `overview` → `OverviewTab` (`App.tsx:157`)
  - `containers` → `ContainersTab` (`App.tsx:158`)
  - `logs` → `LogsTab` (`App.tsx:159`)
  - `probes` → `ProbesTab` (`App.tsx:160`)
  - `compose` → lazy `ComposeTab` (`App.tsx:161`)
  - `env` → lazy `EnvTab` (`App.tsx:162`)
- `/settings/*` → `Settings` (`App.tsx:164`)
- `*` → redirect to `/` (`App.tsx:165`, post-setup catch-all)

11 route entries total, all declared in one file — enumeration itself was cheap; the carry-forward's "spend most of your effort here" pays off on cost, not on locating routes.

**Version:** `package.json` pins `"react-router-dom": "^7.18.3"`; lockfile resolves exactly `7.18.3`. `useBlocker` exists in this version (`node_modules/.../react-router@7.18.3/.../index.d.ts:876`) and its doc tags it `@mode framework` / `@mode data` only — it is not usable under a plain `<BrowserRouter>`; it requires a data router (`createBrowserRouter`/`createMemoryRouter` + `RouterProvider`).

**Test-file cost — the real number.** 8 files construct their own router tree with `MemoryRouter` + `<Routes>/<Route>` (grep for `MemoryRouter|BrowserRouter|RouterProvider|createMemoryRouter`):
`AdminApps.test.tsx`, `edit/ContainersTab.test.tsx`, `edit/ComposeTab.test.tsx`, `EditApp.test.tsx`, `edit/LogsTab.test.tsx`, `edit/OverviewTab.test.tsx`, `edit/EnvTab.test.tsx`, `setup/SetupWizard.test.tsx`. Every one builds its tree as `<MemoryRouter initialEntries={[...]}><Routes><Route .../></Routes></MemoryRouter>` — the same declarative shape as `App.tsx`. Migrating the app router to a data router makes `useBlocker` available in production code, but doesn't *require* touching these tests unless the components under test start calling `useBlocker` themselves (only `ComposeTab`/`EnvTab` would) — however, any component that calls `useBlocker` will throw inside a declarative `MemoryRouter`, so at minimum `ComposeTab.test.tsx` and `EnvTab.test.tsx` (2 of the 8) must convert to `createMemoryRouter`/`RouterProvider`; the other 6 only need to change if the plan wants one consistent router-construction helper across the suite. `App.test.tsx` renders `<App/>` itself (`App.test.tsx:123`) and needs no change beyond whatever `App.tsx` internally does.

**Verdict:** the carry-forward is directionally right (a real migration, not a component tweak) but overstates the blast radius. The route tree is small and centralized (11 routes, one file), so converting `App.tsx` to `createBrowserRouter` is mechanical. The unavoidable test cost is 2 files (`ComposeTab.test.tsx`, `EnvTab.test.tsx` — the only two with unsaved state), not all 8; the other 6 can stay as-is unless the plan chooses uniformity. **Smaller than implied.**

## 2. Per-row jobs query

`RowActions` (`AdminApps.tsx:56`) doesn't call `useJobs` directly — it calls `useAppActions(app)` (`useAppActions.ts:52`), which calls `useJobs(app.id)` (`useAppActions.ts:54`) to find any `running` job for busy-state and to pick up a job already in flight on mount. `useJobs` (`admin.ts:96`) hits `GET /api/apps/:id/jobs`, which returns the full job history for that app, newest first (`jobs.ts:78-90`) — the row only needs one bit of it (`jobs?.find(j => j.status === "running")`, `useAppActions.ts:60`), not the list.

**No existing batch endpoint carries this.** `GET /api/apps` (`apps.ts:482`) already does one grouped rollup per page-load — `deployTimestamps` (`deploy-timestamps.ts:18-39`), a single `GROUP BY jobs.appId` query keyed on `status = "succeeded"` — but nothing analogous exists for "is a job currently running." `AdminApp`/`ViewerApp` (`dto.ts:8-33`) carry no running-job field. This is **not** a client-only fix: it needs a small server addition (a sibling grouped query, e.g. `runningJobIds(db, appIds)` filtering `status IN ('running','queued')`, following exactly the `deployTimestamps` pattern) plus a new field on `AdminApp`, then `RowActions`/`useAppActions` read it from the already-fetched `useAdminApps()` data instead of mounting `useJobs` per row.

## 3. Nothing creates the self-managed Homestead row

Confirmed: `isSystem` defaults to `false` (`schema.ts:96`) and neither the adopt insert (`apps.ts:339-353`) nor the create insert (`apps.ts:~430+`) ever sets it — grep across `src/server` and `src/web` for `isSystem` turns up only the two lifecycle guards (`apps.ts:600`, `jobs.ts:38`) and one read-only badge in the UI (`AdminApps.tsx:165`). No self-identification exists anywhere: no `dockerode` call inspects the running container, no read of `HOSTNAME`, nothing. **Worth flagging directly:** the two guard comments disagree on what the flag is *for* — `apps.ts:599` says `isSystem` "marks the managed cloudflared stack, which Phase 2 owns," while `jobs.ts:33-38` says it protects "a self-adopted Homestead." These are two different apps (a Cloudflare tunnel sidecar vs. Homestead's own container) with two different self-identification problems and no code addressing either. The plan needs to pick one meaning before scoping the fix — this is bigger and vaguer than the one-line carry-forward implies, closer to a small design decision than a bug fix.

## 4. Compose schema drift signal

`PINNED.md` (`src/shared/schema/PINNED.md:1-13`) records source repo, pinned commit SHA, and vendor date, refreshed by hand via `pnpm exec tsx scripts/vendor-compose-schema.ts <ref>` (`vendor-compose-schema.ts:1-56`), which fetches, validates, and rewrites both the schema JSON and this file. No CI exists in this repo at all — `find` for `.github/workflows` and other CI config comes up empty. As the carry-forward implies, a drift check has nowhere to run today; adding one is a two-part task (a script/test that pings upstream, *and* the CI wiring to run it on a schedule), not a one-line addition.

## 5. The blind SetupWizard test

Both tests are in `SetupWizard.test.tsx`. The old one (`:170-202`, "does not double-fire...") and the new one (`:204-244`, "guards markComplete itself...") each carry an in-repo comment already stating the diagnosis: the old test's own comment (`:171-177`) says jsdom disables the Skip button before the second click ever reaches the handler, so it "proves nothing about `markComplete`'s own `pendingRef` guard." The new test's comment (`:205-219`) explains it defeats that masking by firing both clicks inside one `act()` call, reaching the handler while the DOM is still enabled. **Not fully redundant**: the old test still exercises a real, separate behavior — that `StepImport`'s Skip button disables itself in the DOM on `pending` — which the new test doesn't check (it fires both clicks synchronously before any disable can render). Dropping it loses that one assertion; keeping it is cheap. Effort here is near zero either way — the diagnosis is already written down, just needs a decision to delete-or-rename.

## 6. Untested delete ordering

`DELETE /api/apps/:id` (`apps.ts:593-600`) calls `loadApp` (`apps.ts:597`, defined `apps.ts:140-146`) before the `isSystem` check (`apps.ts:599-600`). `loadApp`'s query already applies `visibleAppsWhere(ctx)` (`context.ts:49-53`) in its `WHERE` clause, so a system app outside a scoped admin's `appIds` returns `undefined` from `loadApp` and hits the 404 branch (`apps.ts:598`) — the `isSystem` 409 check is structurally unreachable for an out-of-scope row. The ordering is correct by construction, not by accident. Confirmed no test covers this combination: `apps.test.ts:265-287` ("refuses to delete a system app") uses a full-scope admin (`signUpAdmin`), never a scoped one. This is a missing regression test for already-correct behavior, not a live bug.

## Rankings

**By effort, ascending:** (5) blind test — near zero, diagnosis already written; (6) missing test — near zero, add one scoped-admin delete test; (2) per-row jobs — small, one grouped query following an existing pattern plus a client read change; (1) router migration — moderate, contained to one file plus 2 required test conversions; (4) drift signal — moderate-to-open-ended, needs both a check and CI infrastructure that doesn't exist yet; (3) self-managed row — largest, blocked on an actual design decision (which "system" app, and how it identifies itself) before any code.

**By risk, ascending:** (5) and (6) — zero risk, test-only; (4) — low risk but the CI-from-scratch part touches deploy/build tooling, not app code; (2) — low-moderate, touches the admin inventory's hot path but follows an established, already-reviewed pattern; (1) — moderate, touches the app's top-level routing and is easy to get subtly wrong (auth/setup guards in `Routed()` are intricate); (3) — highest, because doing it wrong (e.g., guessing container identity via `HOSTNAME`) could either fail to protect the real target or, worse, wrongly self-protect the wrong app.

**Do first:** (6), immediately, then (5) — both are trivial and clear the two "not actually a problem, just undertested" items off the backlog before touching anything riskier. If capacity allows one substantive item this phase, (2) is the best next pick: small, well-understood, follows a pattern already in the codebase.

**Consider dropping / deferring:** (3). It is not a bug fix — it is an unresolved design question (which app "isSystem" even means) wearing a bug-shaped carry-forward note. Planning implementation work now would mean guessing at a decision that should be made explicitly first; better to convert it into a design question for Phase 2 (where `apps.ts:599`'s own comment already says cloudflared belongs) rather than a 1I task.
