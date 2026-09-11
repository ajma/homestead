# Phase 1C — carry-forward into 1D and beyond

Written at the end of Phase 1C, after the whole-branch review and its fix wave. The
per-task scratch workspace it was assembled from is git-ignored and has been deleted.

Phase 1A's, 1B-i's and 1B-ii's carry-forwards remain live except where noted below.

## Closed from the 1B-ii carry-forward

- **`statusFor` is out of the `appRoutes` closure**, in `src/server/apps/status-for.ts`,
  and the scheduler uses the same computation the routes do.
- **The resolved compose project name now wins over the stored one.** An out-of-band
  `COMPOSE_PROJECT_NAME=media` in `.env` no longer makes a running container report
  `down`. `currentProjectName(deps, row)` is the single place that decides.
- **`ImageUpdateChecker.check` is scheduled** alongside the probe scheduler.

Still deferred from that document: `runCompose` passes no `-p`; `JobRunner.cancel` is
implemented and unreachable; `FakeHost.streamLogs` yields a fixed array and cannot model an
open-ended stream; the config cache ignores `include:` and `extends:`; two concurrent
`POST /images/check` for one app both run the sweep.

## Do these in 1D

**1. Graceful shutdown — now more urgent than 1B-ii judged it.**

Still no SIGTERM handler, no `app.close()` on signal, and no startup sweep of `jobs` rows
left at `status='running'`. 1C made the deferral worse: a job stream ended when its job
ended, but a **launcher SSE stream is permanent**, and `app.close()` measurably does not
resolve while one is open. The pieces now exist and are reachable; the handler must call
them in this order, which is recorded in a comment in `index.ts`:

```
scheduler.stop()  →  retentionTimer.stop()  →  events.closeAll()  →  app.close()
```

**2. The web surfaces have to agree on what status means.**

`/api/events` carries the **debounced** status from `applyTransition`; `/api/apps` computes
a **live** rollup. During a grace window they legitimately disagree — `starting` against
`down`. Latent today because no web consumer reads both. The first UI that renders a
launcher tile from the list and then patches it from the stream will flicker. Decide which
one the UI trusts before writing that component, not after.

**3. `PATCH /api/probes/:id` with a new `intervalSeconds` leaves `nextRunAt` alone.**

Change a probe from daily to every 30s and the first new-interval run is still up to a day
out. Harmless until an admin edits an interval expecting to see the effect — which is
exactly what they will do the first time the edit UI ships.

**4. Probe suggestions do not dedup a port published by two services.** Cosmetic, but the
suggestion list is a 1D affordance and this is where it becomes visible.

## Known gaps, consciously left

| # | Gap | Why it is acceptable for now |
|---|---|---|
| 1 | `retryOnBusy` is a bounded retry (3 attempts, ~25ms backoff), not an application-wide single-writer gate | Measured against a real file-backed collision: the write recovers on retry, and when the hold outlasts the budget it surfaces the error with zero rows written — no silent loss, no partial write. A gate every query funnels through is a large change to every route; revisit only if 500s appear under real load. |
| 2 | `Promise.allSettled` in `runAll` is defence-in-depth with no reachable path today | `runOne`'s try now wraps every await *and* its own `onProbeError` call, so it cannot reject. Keep it: the reason it was added is that `Promise.all` abandoned seven workers the one time `runOne` could reject. |
| 3 | The external HTTP probe exists but has no Cloudflare Access credentials to use | Phase 2. The runner and its classification table are in place, which is the point — Phase 2 adds a service token, not a scheduler change. |
| 4 | No cap on total SSE streams across all users | Capped at 5 per user, which is the reachable abuse case on a household NAS. |

## Things that must not be "simplified" later

Each closes a defect that was measured, not hypothesised.

- **`check_results.status` stores the observed status; `probes.lastStatus` stores the
  debounced one.** Storing the debounced value in samples made a flapping probe read as an
  uninterrupted `up` and uptime as 100%. Verified by reverting: `['up','up']` against
  `['up','down']`.
- **The rollup's `HAVING NOT EXISTS` correlates on the bucket expression, not on
  `hour_start`.** An unqualified `hour_start` inside `SELECT … FROM check_rollups r`
  resolves to `r.hour_start`, making the predicate `r.hour_start = r.hour_start` —
  always true, so the clause degrades to "this probe has no rollup rows at all". Measured:
  rolling four consecutive hours in separate calls gave `[1,0,0,0]` and one bucket. With
  the 48h prune running regardless, the 90-day history was permanently one hour long.
  **A test that rolls several hours in ONE call passes either way** — that is why this
  shipped through a task review. The test must roll hour by hour in separate invocations.
- **`runOne` awaits `reschedule` INSIDE its try.** Outside it, a `SQLITE_BUSY` from a route
  holding a transaction escaped the per-probe catch, rejected `Promise.all`, and landed in
  `tick`'s catch. Measured: 6 due probes, `tick()` returned 0, `onProbeError` fired 0
  times, and 4 workers kept running after `ticking` was already `false`. After the fix, the
  same input gives tick 6, 6 reported, 0 detached.
- **Every DB statement in the scheduler goes through `serialise()`.** Before it, twelve
  probes ran, the runner was called twelve times, and ZERO samples survived — every write
  lost to `TRANSACTION_ACTIVE` and swallowed by the per-probe catch. No test caught it
  because none asserted N probes → N samples.
- **`listContainers()` is bounded by a timeout, and a timeout yields `null`, not `[]`.**
  Unbounded, a wedged Docker socket left `ticking` true forever and every later tick
  returned 0 silently, with stale green statuses on screen. `[]` would report every app
  down at once; a false mass-outage is worse than no alert.
- **`sampleBody` streams and does NOT slice the decoded text.** `response.text()` buffered
  an unbounded body and *hung* the test rather than failing it. Slicing at the byte cap cut
  the `1033` marker at the boundary, decoding `…1` and misattributing a tunnel outage as
  `fault: 'app'`. The read loop already bounds memory.
- **The HTTP runner uses `redirect: 'manual'` and checks the scheme itself.** Following
  redirects hides an Access login bounce as a 200. Without the scheme check
  `file:///etc/passwd` went out — the API validates too, and both layers stay.
- **`ctx.containers === null` means the Engine API failed; `[]` means an empty host.**
  Collapsing them blames every app for one socket error.
- **The SSE scope filter runs per event, inside the subscriber closure.** A scoped viewer
  must not learn that an app they cannot see exists, let alone that it just went down.
- **`closeForUser` fires on any edit to `role`, `scopeAllApps` or `disabled` — not just
  `role`.** `AuthContext` is resolved once in `preHandler`, which for a never-ending SSE
  request means once ever. Measured: `scopeAllApps: false` and `disabled: true` both left
  the stream open and still delivering. `disabled` is the sharper one — `app.ts:130`
  rejects a disabled user on every *new* request, so the lockout looks complete everywhere
  except the one channel that never re-checks. A name-only PATCH must still leave the
  stream open; that negative stops a later tidy-up from reconnecting every tab on a rename.
- **Do not detect whether a scope change widens or narrows.** A widening edit costs one
  reconnect; a predicate that decides direction is a second, untested scope boundary.
- **`matchesStatusPattern` fails closed.** An unparseable pattern must not mean "accept
  anything".
- **`inScope` / `visibleAppsWhere` is the only scope predicate.** Confirmed still true at
  the end of 1C. A second one is how the SSE path and the REST path drift apart.

## Toolchain notes

Additions to 1B-ii's list, which all still hold.

- **`process._getActiveHandles()` does not track timers** on Node 24.15.0. Use
  `process.getActiveResourcesInfo()` filtered for `"Timeout"`. Still the only way to see a
  leaked interval, and 1C added several.
- **`vitest` does not typecheck.** `pnpm exec tsc --noEmit` is a separate gate, and it is
  the one that finds a changed signature's call sites.
- **libSQL transaction behaviour differs by backend — measured:**

  | during an open transaction | `:memory:` (tests) | file-backed (production) |
  |---|---|---|
  | another transaction | `TRANSACTION_ACTIVE` | `SQLITE_BUSY` |
  | a plain read | rejected | fine |

  Tests are strictly harsher, so a green suite does not prove production safety — and the
  reverse trap is real: the route-versus-scheduler contention only reproduces on a file.
  Reproduce production-only failures against a file-backed database in `/tmp`.
- **A single green run proves nothing here.** Run the suite at least three times.
- **Editor diagnostics go stale constantly in this repo** — `Property 'events' does not
  exist on type 'AppDeps'` appeared throughout 1C against a clean `tsc`. Trust `tsc`.

## The failure patterns this phase kept producing

Worth reading before writing 1D, because all three recurred after being named.

1. **A guarantee stated in a comment the code does not provide.** "libSQL holds a single
   connection" was true of `:memory:` and misleading for production; "only a role change
   forces the reconnect" was wrong about two of the four fields PATCH accepts.
2. **A swallowing catch making systemic failure indistinguishable from success.** Three
   separate defects, and *three separate times* a reporting channel took down the thing it
   reports on — an `onProbeError` hook that itself threw re-opened the concurrent-tick race
   it existed to expose. Every error hook is now wrapped; keep it that way.
3. **Tests asserting things they cannot observe.** A body-size test that ran against a
   runner which reads no body. An idempotence test that passed with the idempotence
   removed, because the composite PK rejected the duplicate and a catch hid it. A
   concurrency test asserting `peak <= 8` that passes at peak 0. The counter-measure that
   actually worked: break the line under test and require the test to go red.
