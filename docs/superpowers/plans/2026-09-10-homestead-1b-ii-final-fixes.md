# Phase 1B-ii — final review fix wave

The whole-branch review returned **NOT READY**: three Criticals, four Importants, two
Minors. This is what gets fixed, what gets deferred, and why. Everything here was
confirmed before being written down.

Where this document and the phase plan disagree, this document wins.

---

## 1. Critical — a failed job write takes down the whole server

`JobRunner.start` assigns `job.done = this.finish(...)`. `finish()` has a `try/finally`
and **no `catch`**, and its two `db.update` calls can reject. The only code that ever
attaches a handler to `job.done` is the SSE stream route.

So: click Deploy, do not open the log pane, and let the `jobs` status update hit
`SQLITE_BUSY` or a full disk. The rejection is unhandled, `index.ts` installs no
`unhandledRejection` handler, and Node's default is to terminate the process. Homestead
exits, every session drops, and any in-flight compose child is orphaned.

This is the same class as the defect the Task 9 fix wave closed inside `check()` — one
layer up, and worse, because the consequence is the whole process rather than one sweep.

**Fix, two parts.**

- `finish()` gets a `catch` that logs and swallows. A job whose bookkeeping failed is a
  job with a stale row; that is a much smaller problem than an exit.
- `index.ts` installs `process.on('unhandledRejection')` and `process.on('uncaughtException')`
  handlers that log. **Not** to make swallowing errors a habit — the `catch` above is the
  real fix — but because a single-process appliance on a NAS should log and keep serving
  rather than vanish, and because the next unhandled rejection someone introduces should
  produce a log line rather than a mystery restart.

**Test.** Patch `db.update` to reject, start a job, never touch `job.done`, and assert the
process records the failure without an unhandled rejection. Use
`process.on('unhandledRejection')` inside the test to detect one, and remove the listener
afterwards.

---

## 2. Critical — `check()`'s "never throws" is false, for the fifth time this phase

`ImageUpdateChecker.check` opens with an unguarded `await this.deps.composeConfig.resolve(...)`.
That reaches `inputHash`, whose `.env` read and override-file reads each carry a `.catch`
and whose **compose file read does not**. Rename `compose.yaml` over SSH, or let the SMB
mount return `EIO`, and `check()` throws — despite the doc-block directly above it saying
it never does, and despite `statusFor` in `apps.ts` wrapping the identical call with a
comment noting that a moved file is ordinary operation.

Consequence for Phase 1C: the scheduled sweep dies at the first app with a moved compose
file and never reaches the rest. Today: `POST /api/apps/:id/images/check` returns 500.

**Fix.** Wrap the `resolve` call. A compose file that cannot be read is the same outcome as
one that will not resolve — return without writing anything.

**Test.** `FakeHost.readTextFileErrors` already exists; set an error for the compose path
and assert `check()` resolves.

---

## 3. Critical — an abandoned log stream holds a Docker socket open indefinitely

`logs.ts` breaks its loop when `disconnected` is set, but `disconnected` is only consulted
**when a chunk arrives**. On an idle container with `follow: true` no chunk ever arrives,
so the loop stays parked inside `for await`, the generator never resumes, its `finally`
never runs, and the Docker socket stays open. One socket, one `ChunkQueue` and one request
object per closed tab, for the life of the process.

I ruled this acceptable twice during the phase, on the grounds that it "holds one request
object, a few KB, for the remainder". That reasoning was wrong for logs. It holds for the
*job* stream, where the job finishes and bounds the wait. For `follow: true` on a healthy
quiet service there is no remainder — a user who opens the logs pane on Jellyfin at rest
and closes the tab leaks until Homestead restarts.

Note this is why my own verification missed it: I measured with a container printing 2000
lines, where the next chunk arrives in milliseconds and the break fires immediately.

**Fix.** Stop relying on the loop noticing. `LogOptions` gains `signal?: AbortSignal`;
`streamLogs` destroys the Docker stream and closes the queue when it fires; the route
passes a signal it aborts from `sse.closed`.

```ts
// in LogOptions
signal?: AbortSignal

// in LocalHost.streamLogs, after the stream exists
const onAbort = () => {
  if (!Buffer.isBuffer(stream)) stream.destroy()
  queue.close()
}
if (opts.signal?.aborted) onAbort()
else opts.signal?.addEventListener('abort', onAbort, { once: true })
```

and in the route:

```ts
const abort = new AbortController()
void sse.closed.then(() => abort.abort())
// …
for await (const line of host.streamLogs({ containerId, tail, follow, signal: abort.signal })) {
```

`FakeHost.streamLogs` honours the signal too, or the test below cannot exist.

**Tests.** Two. A `FakeHost` whose `streamLogs` yields one line and then never yields
again, with an aborted signal ending the iteration — proving the route does not park
forever. And a `LocalHost` integration test, gated on Docker, against a container that
prints one line then sleeps: break out, abort, and assert the process's active handle
count returns to its baseline. **The chatty-container version of this test passes without
the fix** — use an idle container, or the test proves nothing.

---

## 4. Important — 503 and 404 disagree three lines apart

`containers.ts` returns 503 when `listContainers` fails, then catches **every**
`inspectContainer` error as 404 immediately below. A socket that wedges between the two
calls reports "container not found" for a container that exists — the same condition, two
answers, three lines apart.

`inspectImage` already discriminates on `statusCode === 404`; use the same test here. A
genuine 404 stays 404; anything else is 503.

---

## 5. Important — three assertions survive their subject being deleted

Mutation testing found these, and each corresponds to a defect this phase already fixed
once. A regression would be silent.

| Mutation | Tests still passing |
|---|---|
| Delete the terminal `done` event from `logs.ts` | 6/6 log tests |
| Gut `sse.ts`'s `finish()` so the heartbeat is never cleared | 16/16 SSE route tests |
| Remove the `HostPort === ""` NaN guard | 20/20 container tests |

**Fix.** One test each: assert the log stream emits exactly one `done`; assert the
heartbeat interval is cleared when a stream closes; assert an exposed-but-unpublished port
projects to `host: null` rather than `0`.

---

## 6. Minor — the two SSE routes disagree on error-body policy

`logs.ts` sends the raw `error.message`; `jobs.ts` sends a fixed string. Both are
admin-only so neither leaks today, but they should agree. Take the log route's shape —
an admin debugging a log stream wants the real message — and make the job route match,
logging server-side in both cases as it already does.

---

## Deferred, with reasons

- **`apps.projectName` goes stale after an SSH edit to `.env`, and four routes key off
  it.** Real: a running container then reports `down`, `GET .../containers` returns `[]`,
  and the logs route 404s. 1B-i already reconciles after writes *through Homestead*; this
  is the out-of-band case, the same class as the `include:`/`extends:` gap already carried
  forward. The fix is to prefer `resolved.resolved.projectName` — which `statusFor`
  already holds — over the stored copy, and it touches every route that reads
  `row.projectName`. That is a coherent change of its own and it belongs with the
  scheduler in 1C, which is what makes the drift persistent rather than momentary.
- **No graceful shutdown and no stuck-job reconciliation.** No SIGTERM handler, no
  `app.close()`, no startup sweep of `status='running'` rows. Genuinely missing, but it
  belongs with the Dockerfile and the container lifecycle, neither of which exists yet.
  Carried forward as a deployment item.
- **`JobRunner.cancel` is implemented and unreachable.** No route exposes it, so a hung
  `pull` is bounded only by the 30-minute timeout. The endpoint needs a UI affordance to
  be worth anything; it lands with 1D.
- **`FakeHost.streamLogs` ignores `follow` and never splits a chunk**, which is why
  finding 3 survived a task review, a scoped re-review and 333 tests. Fixing the fake
  properly means modelling an open-ended stream, which is most of what fix 3 needs anyway
  — the signal-aware fake is the first half. Full fidelity carries forward.
