# Phase 1B-ii — carry-forward into 1C and beyond

Written at the end of Phase 1B-ii, after the whole-branch review and its fix wave. The
per-task scratch workspace it was assembled from is git-ignored and has been deleted.

Phase 1A's and 1B-i's carry-forwards remain live except where noted below.

## Closed from the 1B-i carry-forward

- **`runCompose` returns a `JobHandle`** — streaming, cancellable, with `result` that always
  settles. A `pull` is no longer killed at 60 seconds.
- **`FakeHost` emits multi-chunk compose output.** Not fully closed for `streamLogs`; see
  below.
- **The Docker-gated tests** that held the only compose-root confinement coverage now run
  without a daemon.

Still deferred from that document: `runCompose` passes no `-p`, and `statusFor` still lives
inside the `appRoutes` closure. Both are 1C's, and both are recorded there.

## Do these in 1C

**1. Prefer the resolved project name over the stored one.**

`apps.projectName` is written at adoption and reconciled after writes made *through*
Homestead, but not after an SSH edit to `.env`. Measured: adding `COMPOSE_PROJECT_NAME=media`
out of band makes a running container report `status: "down"` with `"0/1 services up,
1 missing"`, `GET /api/apps/:id/containers` return `[]`, and the logs route 404. `statusFor`
already holds the correct name in `resolved.resolved.projectName` and uses the stale stored
copy anyway. Four routes key off it. This becomes persistent rather than momentary once a
scheduler is reading it, which is why it belongs with 1C.

**2. Extract `statusFor` from the `appRoutes` closure.** The scheduler needs the same
computation. Additive.

**3. `ImageUpdateChecker.check(app)` is ready to be scheduled.** It never throws — verified
against an unreadable compose file, a wedged Docker socket, an unreachable registry and a
failing database write. Run it daily; the registry client bounds each request at 10s.

**4. Graceful shutdown and stuck-job reconciliation.** There is no SIGTERM handler, no
`app.close()`, and no startup sweep of `jobs` rows left at `status='running'`. `docker stop`
mid-`pull` leaves such a row forever while the in-process mutex is gone, so a new job can
start against a stack an orphaned `docker compose pull` is still mutating. This belongs with
the Dockerfile, which does not exist yet.

## Known gaps, consciously left

| # | Gap | Why it is acceptable for now |
|---|---|---|
| 1 | `JobRunner.cancel` is implemented and unreachable — no route exposes it | A hung `pull` is bounded by the 30-minute timeout. The endpoint needs a UI affordance to be worth anything; it lands with 1D. |
| 2 | `FakeHost.streamLogs` yields a fixed array and ignores `follow` | It honours the abort signal now, which is what the leak fix needed, but it still cannot model an open-ended stream. This is why the socket leak survived a task review, a scoped re-review and 333 tests. Full fidelity before 1D builds a log pane on it. |
| 3 | The config cache still ignores `include:` and `extends:` targets | Unchanged from 1B-i. |
| 4 | Two concurrent `POST /images/check` for one app both run the sweep | The outcome is consistent via `onConflictDoUpdate`; only wasteful, and there is no `up`/`down` collision to prevent. |
| 5 | A client that leaves during a silent stretch of a job stream is noticed at the next chunk | Bounded by the job finishing. The *log* stream, which has no such bound, is now aborted explicitly — that distinction is the whole point of the difference. |

## Things that must not be "simplified" later

Each closes a defect that was measured, not hypothesised.

- **`ChunkQueue` is a broadcast queue with a per-consumer cursor.** Consuming by shifting off
  a shared buffer split the output between two readers and hung the second after one chunk.
  Two browser tabs watching one deploy is the normal case.
- **`JobRunner.start` takes its mutex slot before any `await`.** With the row insert first,
  two calls in the same tick both passed the busy check and both spawned `docker compose up`
  on one stack — a double-click on Deploy is enough.
- **`streamLogs` takes an `AbortSignal`, and the log route aborts it on disconnect.** The
  route only consults `disconnected` when a chunk arrives, so on an idle container it never
  notices; the generator stays parked and the Docker socket stays open for the life of the
  process. **The integration test for this must use an idle container** — one that keeps
  printing passes without the fix, which is how the defect survived three reviews.
- **The log demultiplexer fails loudly above 16 MB.** A raw TTY stream reaching the frame
  parser reads ordinary log text as a length; without the cap it waits forever for a payload
  that never comes, and misframing never resynchronises.
- **Each log stream gets its own `StringDecoder` per stream.** A UTF-8 character straddling
  two frames becomes replacement characters otherwise, and a half-finished character on
  stdout must not be completed by the first byte of a stderr frame.
- **Both SSE routes send exactly one terminal event, and a generic error payload.** A client
  tearing down on `done` hung when only `error` arrived. The payload is generic because a
  database error's text can carry bound SQL parameters — the same reason Phase 1A had to move
  `setErrorHandler` above every `register()`.
- **`updateAvailable` requires both digests known and matched by repository.** An unknown
  reported as an update, or a Docker Hub digest compared against a private-registry one,
  produces a badge that never clears — which teaches the user to ignore every badge.
- **`ImageUpdateChecker.check` guards the database writes, not just the network calls.** The
  guard originally covered the two calls least likely to need it.
- **`process.on('unhandledRejection')` is registered in `index.ts`.** A failed job bookkeeping
  write rejects a promise nobody awaits unless the log pane is open; Node's default is to
  terminate the process, dropping every session and orphaning in-flight compose children.

## Toolchain notes

- **`process._getActiveHandles()` does not track timers.** Verified on Node 24.15.0: a live
  `setInterval` leaves the count unchanged. A test watching it for a leaked timer watches a
  number that never moves and passes against any implementation. Use
  `process.getActiveResourcesInfo()` and filter for `Timeout`. Sockets *are* tracked, which is
  why the log-leak integration test works.
- **`vitest` does not typecheck.** Still true, still a separate gate.
- **A single green run proves nothing here.** One test in this phase failed roughly one run in
  five. Run the suite at least three times before believing it.
