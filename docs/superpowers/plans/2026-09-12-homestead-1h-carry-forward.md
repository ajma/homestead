# Phase 1H — carry-forward. Phase 1 is complete.

Written at the end of Phase 1H, after the whole-branch review, its fix wave, a scoped
re-review and a residual round. The per-task scratch workspace it was assembled from is
git-ignored and has been deleted.

Phase 1A's through 1G's carry-forwards remain live except where closed below.

## What 1H shipped

Homestead runs in a container. A four-stage build on `node:24-alpine`, with the Docker CLI
and the Compose plugin in the runtime image because mutations shell out, and with production
dependencies installed *inside* Alpine — which is the only thing that makes the libSQL native
binding resolve to musl rather than the build host's glibc.

And the three things that make a restart survivable: a shutdown sequence `index.ts` had
described in a comment since Phase 1C and never implemented, a startup sweep repairing jobs
a crash stranded, and an `isSystem` guard so Homestead cannot stop itself out of existence.

**The result that mattered most:** a deliberately misconfigured mount was refused, in a real
container, with a `PreflightError` naming the mismatch. Spec §10's central concern is a
failure that is silent — Docker creates an empty directory for a bind source that does not
exist on the host, so a wrong mount produces stacks that come up looking freshly installed,
indistinguishable from data loss until somebody checks. Two independent reviewers reproduced
the refusal, one across five different misconfigurations.

## Closed from earlier carry-forwards

- **The startup sweep of `jobs` rows stuck at `running`.** Carried since 1B-ii through four
  carry-forwards. 1E made the consequence visible: `ActionBar` resumes from such a row, so
  every page load after a crash flashed a phantom running job before self-healing, and
  nothing ever fixed the row.
- **Graceful shutdown.** Carried since 1C as a comment specifying the order.
- **Spec §10 in full.** Three consecutive carry-forwards pointed at it.

**Still open from 1E:** `target="_blank"` from a standalone PWA may eject to a full browser.
It needs ten minutes on a real phone and cannot be settled from a terminal. This is now the
oldest open item in the project and the only one that needs the user rather than an agent.

**Still open from 1F:** the compose editor has no in-SPA unsaved-changes protection — it
covers `beforeunload` only, and real coverage needs `createBrowserRouter` and `useBlocker`,
a router migration rather than a component change. And the vendored compose schema pin has
no drift signal.

**Still open from 1G:** `RowActions` mounts `useJobs` per row, so a twenty-app inventory
fires twenty `/jobs` requests on load — measured, DB-only, bounded, and needing a batch
endpoint to fix. And `SetupWizard`'s original "does not double-fire" test is still blind.

## Do these next

**1. Phase 2 — exposure.** Spec §6 and §12: the Cloudflare API client, `cloudflared` as a
managed app, tunnel/ingress/DNS, Access apps and policies, service token and rotation, the
external probe, exposure UI, drift reconcile, and onboarding step 4. The spec says Phase 2
slots into interfaces Phase 1 already defines — the external probe is a new `ProbeRunner`
plus a migration, not a change to the scheduler, the history schema or the status UI. That
claim is now worth checking rather than trusting; it was written before any of Phase 1 existed.

**2. Nothing creates the self-managed Homestead row.** `isSystem` now protects deletion and
every lifecycle action, but no adoption flow sets it. Homestead can be adopted like any other
app, and then nothing marks it as system — so the protection exists and is unreachable. Small,
and worth doing before anyone adopts Homestead by hand and stops it.

**3. There is a ~1–1.5 second window at Node startup with no signal handler.** Documented in
`startup.ts` rather than left silent. Closing it needs an init wrapper — `tini` as PID 1 —
which is a Dockerfile change nobody asked for during this phase.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | `preflight.ts`'s token check survives mutation — replacing `if (!output.includes(token))` with `if (false)` leaves all seven tests green | No in-process test can fail it; the guard's real behaviour needs a container. `scripts/verify-mount-preflight.sh` is the honest answer: a written, runnable manual gate covering four scenarios, verified working and leaving no volumes behind. A manual gate that runs beats an automated test that cannot fail. |
| 2 | The image is 629 MB | `node:24-alpine` plus the Docker CLI, the Compose plugin and an unbundled `node_modules`. A number to watch, not a problem yet. |
| 3 | `shutdown.ts`'s abandoned `run()` promise keeps executing after its stage times out | If it later rejects, the global `unhandledRejection` logger catches it. A duplicate log line, not a defect. |
| 4 | The same untested scoped-admin ordering gap exists on the delete route at `apps.ts:599-600` | Found while testing the new lifecycle guard. The new route is covered; the old one behaves correctly and is merely untested. |

## Things that must not be "simplified" later

Each closes a defect that was measured, not hypothesised.

- **Production dependencies are installed inside the Alpine stage, not copied from the build
  host.** `@libsql/client` resolves a native binding by platform and libc. A `node_modules`
  built on glibc produces a container that starts and then dies at `createClient()`. This is
  the entire reason the `prod-deps` stage exists and it looks like duplication until it
  isn't.
- **`WORKDIR` and the Dockerfile's copy list agree with four `process.cwd()`-relative paths**
  — the database, the icon cache, the migrations folder and the SPA static root. `drizzle/`
  in particular lives at the repo root, outside `dist/`. A missing `dist/web` does not crash:
  `spa.ts:8-10` logs a warning and the SPA 404s silently.
- **The exception handlers are registered *after* `listen()` resolves.** Registered before,
  `uncaughtException` swallowed `EADDRINUSE`. Measured in a container: `running exit=0` at
  t+45s, timers ticking, nothing listening — and because the container never exits,
  `restart: unless-stopped` never fires. A NAS appliance that silently serves nothing is
  worse than one that crash-loops visibly. A failed `listen` now exits 1.
- **The shutdown order is timers, then jobs, then streams, then server, then database.**
  Jobs cancel while their output streams are still attached, so a user watching a deploy sees
  it end rather than go silent. `events.closeAll()` precedes `server.close()` because
  Fastify's close does not resolve while an SSE stream is open, and this app's launcher
  streams stay open as long as a tab is.
- **Only `server.close()` is bounded, not the whole sequence.** An outer whole-sequence race
  at the same duration can fire before the inner one and skip `db.close()` — the very bug,
  made probabilistic. Every other stage is independently bounded, so the sequence stays
  bounded and `db.close()` is unconditionally reached.
- **`events.closeAll()` guards each subscription individually**, matching `closeUser` two
  methods below it. One throwing `onClose` aborted the loop, leaving later streams open and
  stalling `server.close()` for the full budget — undermining the ordering above.
- **`JobRunner`'s `done` promise is truthful from the instant the slot is taken.** It used to
  stay a placeholder `Promise.resolve()` until after the insert await, so `shutdown()`
  returned in about a millisecond while the row was still `running`. The insert-failure path
  must settle it too, or `shutdown()` hangs its full timeout on a job that never ran.
- **`sweepStrandedJobs` runs before `listen` and before `JobRunner` is constructed.** Its
  safety argument is that every `running` row it finds belongs to a previous life, and that
  is true only because of where it is called. It rewrites `status`, `finishedAt` and `output`
  unconditionally on every matching row.
- **`stop_grace_period` is 45s against a 30s worst-case budget** (jobs 10s + server 20s). It
  was 30s — exactly equal, zero margin — while the docs claimed 20s. Compose's own default is
  10 seconds, so deleting the line is not "keeping the default behaviour", it is arranging to
  be SIGKILLed mid-sequence.
- **The `isSystem` lifecycle guard sits after `loadApp` and before `runner.start`.** After, so
  a scoped admin gets 404 rather than a 409 confirming the app exists; before, so nothing
  spawns.

## Toolchain notes

- **Editor diagnostics contradicted a clean `tsc` seven more times this phase**, including
  repeatedly claiming a module that exists cannot be found, and twice reporting a symbol
  unused that was used twenty lines down. Trust `tsc`.
- **`pnpm exec biome check . | tail -1` hides the exit code.** Redirect and check `$?`.
- **A ref'd timer does not block a signal.** The plan predicted a handler-less process would
  hang on SIGTERM because the scheduler's interval is deliberately ref'd. Measured: ~100 ms,
  exit 143. A ref'd timer blocks Node's exit-when-idle, nothing more.
- **`docker rm -f` without `-v` leaks the container's anonymous volumes.** The manual
  preflight gate leaked one per run before this was caught.

## The failure pattern, six phases running

Same shape, and this phase produced its purest instance yet: **`src/server/index.ts` had no
tests at all, and nothing noticed.** A reviewer made the mount preflight log instead of throw,
moved the destructive startup sweep to *after* `app.listen()`, and deleted both signal
handlers — three changes, any one of which breaks the phase's central guarantees — and got
`tsc` clean, Biome exit 0, and 1307 of 1307 tests green.

It was untestable rather than untested: a top-level-await module with real side effects has
nowhere to put a test. The fix was to extract the composition root into `startup.ts` so the
ordering properties could be asserted at all, which is the same answer 1F reached for a guard
nothing could observe — **when a line cannot be mutation-tested where it lives, move it
somewhere it can be.**

The second instance is subtler and worth remembering. The shutdown tests asserted a sequence
of stages and could not distinguish *invoked* from *completed*: dropping the `await` on
`jobs.shutdown()` left everything green. The first attempt to fix it — deferring each fake by
one microtask — **also stayed green**, because every fake then resolved in the same microtask
round and FIFO preserved the expected order by accident. It took strictly decreasing microtask
hops per stage before all five mutations went red. A test harness can be wrong in the same
direction as the code it is testing, and the only way to find out is to break each line and
require red for each one separately.
