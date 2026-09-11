# Phase 1E — carry-forward into 1F and beyond

Written at the end of Phase 1E, after the whole-branch review and its fix wave. The
per-task scratch workspace it was assembled from is git-ignored and has been deleted.

Phase 1A's through 1D's carry-forwards remain live except where noted.

## What 1E shipped

The admin surfaces: `POST /api/apps` with a scaffolded compose file (the spec's second
entry point, which had never existed), the inventory table, adopt-from-disk, create-app,
the tabbed edit page, overview with a working icon picker, containers, logs, the lifecycle
action bar with streamed job output, probe editing, image updates, and the viewer route
guard.

Also, quietly load-bearing: `DialogShell` and `ConfirmDialog`, extracted at the second and
third occurrence rather than the fifth.

## Closed from the 1D carry-forward

- **Probe mutations now publish.** Create, delete and an `enabled`-changing PATCH emit an
  `app-changed` frame on a channel separate from the transition channel, scope-filtered the
  same way. A label-only edit deliberately publishes nothing.
- **A status frame for an unknown *app* id now invalidates** rather than being dropped, so
  an app created in one tab appears in another.
- **Manual icon selection exists.** `GET /api/icons/search` was built in 1D and consumed by
  nothing; the picker now drives it.

**Not closed, and I dropped them rather than deciding against them** — four of the six "Do
these in 1E" items never reached the plan. That is a process failure worth naming: I wrote
the carry-forward and then did not read it when planning the next phase. The three still
outstanding are below.

## Do these in 1F

**1. `PATCH /api/probes/:id` with a new `intervalSeconds` leaves `nextRunAt` alone.**
Carried since 1C. An admin edits an interval and waits up to a day to see it take effect.
Now more visible, because 1E shipped the UI that edits it.

**2. The client stamps `statusSince` with receipt time**, not the server's transition time.
Off by delivery latency — milliseconds — but it means a tile's age comes from two different
clocks depending on whether it arrived by fetch or by patch.

**3. `target="_blank"` from a standalone PWA** may eject to a full browser. Worth ten
minutes on a real phone.

**4. Inventory row actions and right-rail metadata.** Both are spec §8 items my plan's
Self-Review wrongly claimed as delivered. Every action is reachable from the edit page, so
this is convenience rather than capability — but the spec asks for it and the Self-Review
should not have said it was done.

**5. A startup sweep of `jobs` rows left at `status='running'`.** Carried since 1B-ii and
still the Dockerfile task's. 1E made the consequence visible: `ActionBar` resumes from such
a row, so a crash-orphaned job makes every page load flash a phantom running job before
self-healing. Nothing ever fixes the row.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | The SSE inventory patch has no in-flight-fetch guard | A `GET /api/apps` resolving *after* a status frame overwrites the patched row with pre-transition data. Narrow: 15s `staleTime`, no polling on that screen, and it self-heals on the next frame. `sse-patch-store` already solves exactly this for the launcher and is the machinery to reuse. |
| 2 | `create` / `adopt` / `delete` do not invalidate `launcherKey` | Cross-tab only, bounded by the 15-minute stream cap. |
| 3 | A partial-failure adopt invalidates nothing | The successful directories appear on the next navigation. |
| 4 | Two concurrent `POST /images/check` for one app both sweep | Unchanged from 1B-ii; consistent via `onConflictDoUpdate`, only wasteful. |
| 5 | `PATCH /api/apps/:id` has no optimistic-concurrency guard | Two admins editing the *same* field is silent last-write-wins. Only touched fields are sent, so untouched ones survive. Acceptable at single-household scale. |
| 6 | Three SSE connections per tab against the browser's six-per-origin HTTP/1.1 budget | Only `/api/events` counts against the server's five-per-user cap; measured worst realistic case is 2 of 5. |
| 7 | A 503 from the logs route surfaces as the generic fallback | Rare, and the generic message is not wrong. |
| 8 | `act()` warnings in the suite output | Noise, not failure. |
| 9 | `ReconnectingFakeEventSource` protects `useSseText` only | It does not model backoff or a retry cap, and does not protect `useEventStream` or a future SSE consumer from the same class of mistake. |

## Things that must not be "simplified" later

Each closes a defect that was measured, not hypothesised.

- **`useSseText` closes its `EventSource` on `done` and on `error`.** Without it the browser
  does what `EventSource` is specified to do — reconnects — and the server finishes again,
  forever. Measured against a real loopback server and a real Node `EventSource`: four
  connections in twelve seconds, the log pane duplicating its tail every three seconds while
  showing "Stream ended", and the NAS paying a project-name resolve plus a `listContainers`
  plus a `container.logs()` each time. **No jsdom `FakeEventSource` can see this** unless it
  models reconnect, which is why `ReconnectingFakeEventSource` exists.
- **`inGraceWindow` lives in `src/server/apps/grace.ts` and both `statusFor` and
  `applyTransition` call it.** One function, not two mirrors. Before it, the inventory read
  `down` / "0/1 services up, 1 missing" at the same instant the probe pipeline read
  `starting` — so a red chip appeared above a clean `docker compose up` log for two minutes
  after every successful deploy.
- **`EditApp` resolves its slug through `GET /api/apps/:id`, which accepts a slug.** It used
  to resolve through `useAdminApps()`, which made the expensive list query *active* on every
  edit page: one Deploy → done then refetched the whole rollup, up to sixty
  `docker compose config` spawns to update one chip. Measured 68ms per spawn, 1403ms for
  sixty at concurrency 4 on a dev machine, 7–14 seconds on NAS-class hardware.
- **A status frame patches the cached inventory row; it never invalidates `adminAppsKey`.**
  Invalidating it on a frame turns a flapping probe into a load generator against the one
  endpoint that spawns compose processes.
- **`adminAppsKey` is `["admin","apps","list"]`.** Bare `["admin","apps"]` prefix-matched
  every per-app subview, so adopting one app refetched the containers, jobs, images and
  probes of every app whose page was open. `adminAppKey(id)` keeps its prefix relationship
  deliberately — after a lifecycle action that app's containers really have changed.
- **`GET /api/apps` is keyed separately from `GET /api/launcher`.** Sharing a key would let
  the expensive live rollup overwrite the cheap denormalised one, and the launcher would
  start depending on Docker by accident — the single thing its design exists to prevent.
- **`Host.createAppDirectory` exists and the create route calls it.** `PathGuard.resolveForWrite`
  requires the parent directory to exist, so without it `POST /api/apps` could never create
  a new app in production — only the 409 path could succeed. Measured against a real
  `LocalHost`: `PathEscapeError`. Every test used `FakeHost`, an in-memory `Map` with no
  filesystem, which is why the suite was green.
- **`mkdir` is `recursive: true`, after the single-segment check.** Idempotent, so a retry
  after a later failure does not die on `EEXIST`. It cannot create nested paths because the
  segment check has already run.
- **The create route wraps its transaction in `retryOnBusy`.** Two concurrent creates for
  *different* directories otherwise gave one 201 and one raw 500 from an uncaught
  `TRANSACTION_ACTIVE`. The unique constraint never fires first, because the shared client
  rejects the second transaction before the constraint is evaluated.
- **`scaffoldCompose` sanitises the display name before it reaches the comment header.**
  A newline broke out and injected a top-level `services:` block — two `services:` keys in
  one document.
- **The adoption icon suggestion stays exact-match only.** Carried from 1D; a bidirectional
  prefix gave `plex-backup` Plex's logo.
- **`GET /api/apps/:id/containers` returns `{ containers, dockerReachable }`.** It used to
  discard `containersFor`'s `ok` one line before returning, so an unreachable Docker looked
  identical to an empty stack — sending an admin to restart something that was probably
  running fine.
- **`ConfirmDialog` stays open while `onConfirm` is pending and shows a rejection in
  place**, and `DialogShell`'s `closeDisabled` stops Escape and the backdrop dismissing it
  mid-request. Stopping a stack can 409, and that is worth seeing.
- **`apiFetch` has a 30-second default timeout composed with any caller signal**, and
  `POST /api/apps/:id/images/check` takes a 120-second override because it does sequential
  per-service registry lookups at up to 3×10s each. Before the timeout existed, a hung
  request plus `closeDisabled` meant a dialog with no way out at all.
- **The image-update badge requires both digests known and matched by repository.** Carried
  from 1B-ii: a badge that never clears teaches the user to ignore every badge.
- **`GET /api/jobs/:jobId` checks scope against the *app*, not the job row.** Deleting that
  line left all 885 tests green. Without it a scoped admin reads any job's raw output, which
  carries compose stderr with filesystem paths and interpolated `.env` values.

## Toolchain notes

Additions to the earlier lists, which all still hold.

- **Node 24 has no global `EventSource`** without `--experimental-eventsource`, and nothing
  in this repo sets that flag. A test needing real reconnect semantics must either model
  them in a fake or drive a real loopback server with a hand-rolled client.
- **RTL's `act()` can mask TanStack's `notifyManager` deferral entirely.** `notifyManager`'s
  default scheduler really is `setTimeout(fn, 0)` (verified in the installed
  `query-core@5.102.8`), but `useSyncExternalStore`'s post-commit consistency effect forces
  a synchronous re-render that `act()`-flushed `fireEvent` picks up. The consequence: some
  binding checks **cannot be made to fail** even against a genuinely worse implementation.
  When one comes back green, suspect the harness before believing the code.
- **A `waitFor` whose first synchronous check passes against stale DOM reports green for a
  broken implementation.** Assertions about a state *transition* need a macrotask flush;
  assertions about the initial synchronous render do not.
- **`pnpm exec biome check . | tail -1` hides the exit code.** Redirect and check `$?`.
- Editor diagnostics in this repo go stale constantly and contradicted a clean `tsc` a dozen
  times this phase. Trust `tsc`.

## The failure pattern that dominated this phase

Same shape as 1D's, one layer out: **a test double simpler than the real thing in exactly
the dimension that matters.**

- `FakeHost` is an in-memory `Map`, so it could not model `PathGuard`'s requirement that a
  parent directory exist — and `POST /api/apps` shipped unable to create an app at all.
- `FakeEventSource` has no reconnect, so a hook that never closed a finished stream looked
  perfectly well-behaved while reconnecting every three seconds in a browser.

Both were caught by leaving the double behind: a real `LocalHost` over a `mkdtemp` root, and
a real loopback server with a real `EventSource`. The 1B-ii carry-forward already said this
about `FakeHost.streamLogs` — *"this is why the socket leak survived a task review, a scoped
re-review and 333 tests"* — and it happened twice more.

**The counter-measure, again, is mechanical: break the line and require the test to go red.**
This phase's whole-branch review found five of twenty-four mutations surviving, and one of
them was live security code. Where a mutation stays green, that is the finding.
