# Homestead Phase 1B-ii — Compose Lifecycle and Observability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `up`/`down`/`restart`/`pull` as persisted jobs whose output streams to the browser, stream container logs correctly, expose a read-only container detail panel, and detect available image updates without downloading layers.

**Architecture:** `runCompose` stops being a promise of a finished result and becomes a `JobHandle` — a bounded async iterable of output chunks, a promise of the exit code, and a cancel. A job runner serialises work per app behind a mutex, persists the output tail, and sets the post-deploy grace window. Two SSE endpoints fan that out: one per job, one per container log stream. Log frames are demultiplexed by a stateful parser because Docker interleaves stdout and stderr on one connection for non-TTY containers.

**Tech Stack:** TypeScript (strict, ESM), Fastify, Drizzle + libSQL, dockerode, `node:child_process.spawn`, `node:string_decoder`, zod 4, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — sections 3 (`jobs`, `image_status`), 4 (Host interface, Lifecycle, Logs, Container detail panel, Image update detection), 8 (Live updates).

**Prior phase:** `docs/superpowers/plans/2026-09-09-homestead-1b-i-carry-forward.md`. Read it before Task 1 — it names the four things this phase must do first and the list of measured defects whose fixes must not be simplified away.

## Global Constraints

- **TypeScript:** ESM only, `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: "bundler"`, `target: "ES2022"`, `lib` includes `ES2023`. No CommonJS, no `require`. Local imports inside `src/server` use relative paths with `.js` extensions; tests import via `@server/*` and `@shared/*`.
- **TypeScript 7 removed `baseUrl`.** Never add it; `paths` targets stay relative with `./`.
- **`vitest` does not typecheck.** `pnpm exec tsc --noEmit` is a separate gate and a green suite says nothing about it. A previous fix wave reported a clean typecheck with six real errors outstanding.
- **zod 4.** `z.string().url()` and `z.string().email()` are deprecated; use `z.url()` / `z.email()`.
- **No new dependencies.** Everything here is buildable from the existing stack plus Node built-ins.
- **`docker compose` is invoked with an argument array, never a shell string.** `spawn` with `shell: false` (the default).
- **Every non-2xx response body carries an `error` slug**, with `message` optional and human-facing.
- **`loadApp(ctx, id)` in `src/server/routes/apps.ts` is the only way a route loads an app by id.** It composes `visibleAppsWhere(ctx)`; out of scope is 404, not 403. Any new route that loads an app uses it.
- **Viewers hold only `app:read`.** Lifecycle needs `app:lifecycle`; logs, container detail and image updates need `app:config`. No new route serves a viewer.
- **Raw tool output never reaches a viewer-facing field.** `AppStatusSummary` splits `detail` from `adminDetail` for this reason; anything new that carries stderr follows the same split.
- **Biome clean** (`pnpm exec biome check .`) and **the full suite green twice** before any task is called done. 235 tests exist at the start of this phase.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/host/chunk-queue.ts` | Bounded, drop-oldest async queue. The backpressure primitive shared by job output and log streaming. |
| `src/server/host/log-demux.ts` | Stateful parser for Docker's 8-byte multiplexed stream framing. Pure; no I/O. |
| `src/server/host/types.ts` | `JobHandle`, `JobChunk`, `LogOptions`, `LogLine`, `ContainerInspect`, `ImageInspect`; `runCompose`/`streamLogs`/`inspectImage` signatures. |
| `src/server/host/local-host.ts` | `spawn`-based `runCompose`, `streamLogs`, typed `inspectContainer`, `inspectImage`. |
| `src/server/apps/job-runner.ts` | Per-app mutex, job row lifecycle, output cap, grace window. No HTTP. |
| `src/server/sse.ts` | One SSE response helper: headers, heartbeat, disconnect cleanup. |
| `src/server/routes/jobs.ts` | `POST /api/apps/:id/actions/:kind`, `GET /api/jobs/:jobId`, `GET /api/jobs/:jobId/stream`. |
| `src/server/routes/logs.ts` | `GET /api/apps/:id/containers/:containerId/logs` (SSE). |
| `src/server/routes/containers.ts` | `GET /api/apps/:id/containers`, `GET /api/apps/:id/containers/:containerId`. |
| `src/server/apps/registry.ts` | Registry digest lookup: `WWW-Authenticate` → token → `HEAD` manifest. Injectable `fetch`. |
| `src/server/apps/image-updates.ts` | Compare local `RepoDigests` against the registry; write `image_status`. |
| `src/server/routes/images.ts` | `GET /api/apps/:id/images`, `POST /api/apps/:id/images/check`. |
| `src/server/test-helpers.ts` | `FakeHost` gains multi-chunk `runCompose`, scripted `streamLogs`, `inspectImage`. |

---

### Task 1: `JobHandle` — streaming, cancellable `runCompose`

**Files:**
- Create: `src/server/host/chunk-queue.ts`, `src/server/host/chunk-queue.test.ts`
- Modify: `src/server/host/types.ts`, `src/server/host/local-host.ts`, `src/server/apps/compose-config.ts`, `src/server/routes/apps.ts`, `src/server/test-helpers.ts`
- Test: `src/server/host/run-compose.test.ts` (exists; extend)

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
export type JobChunk = { text: string; stream: 'stdout' | 'stderr' }

export type JobHandle = {
  /** Bounded, drop-oldest. Safe to ignore entirely; the process is not slowed by a slow reader. */
  output: AsyncIterable<JobChunk>
  result: Promise<ComposeResult>
  /** Idempotent. SIGTERM to the compose process; `result` still resolves. */
  cancel(): void
}

runCompose(target: ComposeTarget, args: string[], opts?: ComposeOptions): JobHandle
// ComposeOptions is now { timeoutMs?: number } — `onOutput` is replaced by `output`.
export class ChunkQueue implements AsyncIterable<JobChunk> {
  constructor(limit?: number)   // default 2000
  push(chunk: JobChunk): void
  close(): void
  readonly dropped: number
}
```

This is the carry-forward's item 1. The current signature returns a settled `ComposeResult`, so a
`pull` cannot be watched or cancelled, and `execFile`'s 60-second timeout kills a real one
mid-flight. Every later task in this phase depends on the new shape, which is why it is first.

`execFile` also becomes `spawn`. `execFile` buffers the whole output *and* we would be reading
it chunk by chunk — two copies of a `pull`'s output in memory, with `maxBuffer` killing the
process at 16 MB. `spawn` takes the same argument array with no shell, so the injection-resistance
invariant is unchanged.

- [ ] **Step 1: Write the failing test for the queue**

`src/server/host/chunk-queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ChunkQueue } from '@server/host/chunk-queue'

const drain = async (queue: ChunkQueue) => {
  const seen: string[] = []
  for await (const chunk of queue) seen.push(chunk.text)
  return seen
}

describe('ChunkQueue', () => {
  it('yields everything pushed before iteration started', async () => {
    const queue = new ChunkQueue()
    queue.push({ text: 'a', stream: 'stdout' })
    queue.push({ text: 'b', stream: 'stdout' })
    queue.close()
    expect(await drain(queue)).toEqual(['a', 'b'])
  })

  it('wakes an iterator that is waiting when a chunk arrives', async () => {
    const queue = new ChunkQueue()
    const collected = drain(queue)
    await new Promise((r) => setTimeout(r, 5)) // let the iterator reach its await
    queue.push({ text: 'late', stream: 'stderr' })
    queue.close()
    expect(await collected).toEqual(['late'])
  })

  it('terminates an iterator that is waiting when the queue closes', async () => {
    const queue = new ChunkQueue()
    const collected = drain(queue)
    await new Promise((r) => setTimeout(r, 5))
    queue.close()
    expect(await collected).toEqual([])
  })

  it('drops the OLDEST chunks past the limit, keeping the newest', async () => {
    // Drop-oldest, not drop-newest: a phone on poor LTE must not balloon server memory,
    // and when output is truncated the end is the part that says what went wrong.
    const queue = new ChunkQueue(3)
    for (const text of ['1', '2', '3', '4', '5']) queue.push({ text, stream: 'stdout' })
    queue.close()
    expect(await drain(queue)).toEqual(['3', '4', '5'])
    expect(queue.dropped).toBe(2)
  })

  it('gives every concurrent consumer the whole stream', async () => {
    // Two browser tabs watching one deploy. A queue that shifts off a shared buffer
    // splits the output between them, and with one stored waiter the second hangs after
    // the first chunk — measured against the first implementation.
    const queue = new ChunkQueue()
    const first = drain(queue)
    const second = drain(queue)
    await new Promise((r) => setTimeout(r, 5))
    queue.push({ text: 'a', stream: 'stdout' })
    queue.push({ text: 'b', stream: 'stdout' })
    queue.close()
    expect(await first).toEqual(['a', 'b'])
    expect(await second).toEqual(['a', 'b'])
  })

  it('lets a consumer that fell behind resume at the oldest retained chunk', async () => {
    const queue = new ChunkQueue(2)
    queue.push({ text: '1', stream: 'stdout' })
    queue.push({ text: '2', stream: 'stdout' })
    queue.push({ text: '3', stream: 'stdout' })
    queue.close()
    // '1' is gone; the consumer picks up from what is still retained rather than stalling.
    expect(await drain(queue)).toEqual(['2', '3'])
  })

  it('survives a consumer that breaks out early', async () => {
    const queue = new ChunkQueue()
    queue.push({ text: 'a', stream: 'stdout' })
    for await (const _ of queue) break
    queue.push({ text: 'b', stream: 'stdout' })
    queue.close()
    // The abandoned waiter must not wedge later pushes or a later consumer.
    expect(await drain(queue)).toEqual(['a', 'b'])
  })

  it('ignores pushes after close rather than throwing', async () => {
    const queue = new ChunkQueue()
    queue.close()
    queue.push({ text: 'ignored', stream: 'stdout' })
    expect(await drain(queue)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/host/chunk-queue.test.ts`
Expected: FAIL — cannot find module `@server/host/chunk-queue`.

- [ ] **Step 3: Write `src/server/host/chunk-queue.ts`**

```ts
import type { JobChunk } from './types.js'

/**
 * A bounded async queue with drop-oldest backpressure.
 *
 * The producer is a subprocess or a Docker stream; neither slows down for a slow reader,
 * so an unbounded queue turns one phone on poor LTE into unbounded server memory. Dropping
 * the oldest rather than the newest is deliberate: when output is truncated, the end is the
 * part that says what went wrong.
 *
 * Iterating is optional. Nothing here requires a consumer, and `push` after `close` is a
 * no-op rather than an error, because the process can emit a final chunk as it exits.
 */
export class ChunkQueue implements AsyncIterable<JobChunk> {
  private readonly buffer: JobChunk[] = []
  /** Stream index of `buffer[0]`. Rises as chunks are dropped, so cursors stay meaningful. */
  private base = 0
  private readonly waiters = new Set<() => void>()
  private closed = false
  private droppedCount = 0

  constructor(private readonly limit = 2000) {}

  push(chunk: JobChunk): void {
    if (this.closed) return
    this.buffer.push(chunk)
    while (this.buffer.length > this.limit) {
      this.buffer.shift()
      this.base++
      this.droppedCount++
    }
    this.signal()
  }

  close(): void {
    this.closed = true
    this.signal()
  }

  get dropped(): number {
    return this.droppedCount
  }

  private signal(): void {
    // Copy and clear: a waiter re-registers on its next loop, and resolving while
    // iterating the live set would skip entries.
    const waiting = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiting) wake()
  }

  /**
   * Each iterator gets its OWN cursor, so two consumers both see every chunk.
   *
   * Consuming by shifting off a shared buffer looks simpler and is wrong here: two browser
   * tabs watching one deploy would split the output between them, and with a single
   * stored waiter the second would hang after the first chunk. A job's stream is watched
   * by however many tabs the user has open.
   *
   * A cursor that falls behind the retained window jumps to `base` — it has been dropped
   * past, which is the backpressure working, not an error.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<JobChunk> {
    let cursor = this.base
    while (true) {
      if (cursor < this.base) cursor = this.base
      while (cursor < this.base + this.buffer.length) {
        const next = this.buffer[cursor - this.base]
        cursor++
        if (next) yield next
      }
      // Drained. Ending only here, not on `closed` alone, is what guarantees a consumer
      // sees chunks pushed before it started iterating.
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve)
      })
    }
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm exec vitest run src/server/host/chunk-queue.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Change the types**

In `src/server/host/types.ts`, replace the `ComposeOptions` block and the `runCompose` line:

```ts
export type JobChunk = { text: string; stream: "stdout" | "stderr" };

export type ComposeOptions = {
  /**
   * Defaults to 60s, which suits `config`. Lifecycle callers pass a much larger value:
   * `docker compose pull` on a large stack runs for minutes and must not be killed.
   */
  timeoutMs?: number;
};

export type JobHandle = {
  /** Bounded, drop-oldest. Ignoring it entirely does not slow or block the process. */
  output: AsyncIterable<JobChunk>;
  result: Promise<ComposeResult>;
  /** Idempotent. Sends SIGTERM; `result` still resolves, with a non-zero exit code. */
  cancel(): void;
};
```

and in `interface Host`:

```ts
  runCompose(target: ComposeTarget, args: string[], opts?: ComposeOptions): JobHandle;
```

- [ ] **Step 6: Rewrite `LocalHost.runCompose`**

Replace the existing method in `src/server/host/local-host.ts`. Add `spawn` to the
`node:child_process` import and drop `execFile` if nothing else uses it.

```ts
  /** Output kept for the `result` tail, per stream. Beyond this the head is discarded. */
  private static readonly TAIL_BYTES = 256 * 1024;

  /**
   * Keeps the last `TAIL_BYTES` characters of a stream without re-copying the whole tail
   * on every chunk.
   *
   * Concatenating and slicing per chunk allocates two full tails each time — on a `pull`
   * emitting ten thousand chunks that is gigabytes of garbage for a quarter-megabyte of
   * output. Holding the pieces and joining once at the end is amortised linear.
   */
  private static tailKeeper() {
    const pieces: string[] = [];
    let length = 0;
    return {
      push(text: string) {
        pieces.push(text);
        length += text.length;
        while (length > LocalHost.TAIL_BYTES && pieces.length > 1) {
          length -= pieces.shift()?.length ?? 0;
        }
      },
      text(): string {
        const joined = pieces.join("");
        return joined.length > LocalHost.TAIL_BYTES
          ? joined.slice(joined.length - LocalHost.TAIL_BYTES)
          : joined;
      },
    };
  }

  /**
   * Spawns `docker compose` and returns a handle rather than a finished result.
   *
   * `spawn`, not `execFile`: `execFile` buffers the entire output while we also read it
   * chunk by chunk — two copies of a `pull`'s output — and its `maxBuffer` kills the
   * process outright at the cap. The argument array and absence of a shell are unchanged,
   * which is what keeps this injection-resistant.
   */
  runCompose(target: ComposeTarget, args: string[], opts: ComposeOptions = {}): JobHandle {
    const queue = new ChunkQueue();
    const state = { child: null as ChildProcess | null, cancelled: false };
    const tails = {
      stdout: LocalHost.tailKeeper(),
      stderr: LocalHost.tailKeeper(),
    };

    const result = (async (): Promise<ComposeResult> => {
      const composePath = await this.guard.resolveExisting(join(target.directory, target.composeFile));
      if (state.cancelled) {
        queue.close();
        // 143 here too, not 130: a caller checking for "cancelled" should not have to
        // know whether the process had started yet.
        return { exitCode: 143, stdout: "", stderr: "cancelled before start" };
      }

      return await new Promise<ComposeResult>((resolve) => {
        const child = spawn("docker", ["compose", "-f", composePath, ...args], {
          timeout: opts.timeoutMs ?? 60_000,
          killSignal: "SIGTERM",
        });
        state.child = child;

        for (const stream of ["stdout", "stderr"] as const) {
          const pipe = child[stream];
          pipe?.setEncoding("utf8");
          pipe?.on("data", (text: string) => {
            tails[stream].push(text);
            queue.push({ text, stream });
          });
        }

        child.on("error", (error) => {
          queue.close();
          resolve({ exitCode: 1, stdout: tails.stdout.text(), stderr: error.message });
        });

        child.on("close", (code, signal) => {
          queue.close();
          // A signalled exit reports 128+n the way a shell would, so a killed `pull` is
          // distinguishable from a compose file that genuinely failed to validate.
          const exitCode = code ?? (signal === "SIGTERM" ? 143 : 1);
          resolve({ exitCode, stdout: tails.stdout.text(), stderr: tails.stderr.text() });
        });
      });
    })().catch((error: unknown) => {
      // A path-guard rejection lands here. The handle must still settle; a caller
      // awaiting `result` would otherwise hang forever on a typo in a directory name.
      queue.close();
      return {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    });

    return {
      output: queue,
      result,
      cancel: () => {
        state.cancelled = true;
        state.child?.kill("SIGTERM");
      },
    };
  }
```

- [ ] **Step 7: Update the two callers**

In `src/server/apps/compose-config.ts`, `resolve` becomes:

```ts
    const result = await this.host.runCompose(target, ['config', '--format', 'json']).result
```

In `src/server/routes/apps.ts`, `validateContent` uses the same `.result`. Search for every
`await host.runCompose(` and `await this.host.runCompose(` and append `.result` — `tsc` will
list any you miss, since a `JobHandle` has no `exitCode`.

- [ ] **Step 8: Give `FakeHost` real output fidelity**

This is the carry-forward's item 3, and it must land now rather than when the SSE tests are
written. The fake emitted a single chunk; real output arrives as many chunks split at arbitrary
byte boundaries, which is exactly what the streaming code exists to handle. A fake that cannot
reproduce it lets every test in Tasks 5 and 6 pass without exercising anything.

In `src/server/test-helpers.ts`, replace `FakeHost.runCompose`:

```ts
  /** Scripted per `args.join(" ")`, as before. */
  composeResults = new Map<string, ComposeResult>();
  /**
   * How many pieces to split scripted stdout into. Real output arrives in many chunks
   * split at arbitrary byte boundaries — never once, whole, and never on line boundaries.
   */
  composeChunkCount = 3;
  /** Set to have `runCompose` hang until `releaseCompose()` is called. */
  private composeGate: Promise<void> | null = null;
  private releaseComposeGate: (() => void) | null = null;

  gateCompose(): void {
    this.composeGate = new Promise((resolve) => {
      this.releaseComposeGate = resolve;
    });
  }

  releaseCompose(): void {
    this.releaseComposeGate?.();
    this.composeGate = null;
    this.releaseComposeGate = null;
  }

  runCompose(target: ComposeTarget, args: string[]): JobHandle {
    this.composeCalls.push({ target, args });
    const scripted = this.composeResults.get(args.join(" ")) ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    const queue = new ChunkQueue();
    let cancelled = false;

    const result = (async (): Promise<ComposeResult> => {
      if (this.composeGate) await this.composeGate;
      if (cancelled) {
        queue.close();
        return { exitCode: 143, stdout: "", stderr: "cancelled" };
      }
      for (const piece of splitIntoChunks(scripted.stdout, this.composeChunkCount)) {
        queue.push({ text: piece, stream: "stdout" });
      }
      if (scripted.stderr !== "") queue.push({ text: scripted.stderr, stream: "stderr" });
      queue.close();
      return scripted;
    })();

    return {
      output: queue,
      result,
      cancel: () => {
        cancelled = true;
        this.releaseCompose();
      },
    };
  }
```

with this helper at module scope in the same file:

```ts
/**
 * Splits text into AT MOST `count` pieces at arbitrary offsets — deliberately not on line
 * boundaries. Code that assumes a chunk is a whole line is the bug this exists to catch.
 * Fewer pieces than asked for when the text is shorter than the count; the point is
 * "more than one, split anywhere", not an exact number.
 */
function splitIntoChunks(text: string, count: number): string[] {
  if (text === "") return [];
  const size = Math.max(1, Math.ceil(text.length / count));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}
```

- [ ] **Step 9: Add the handle tests**

Append to `src/server/host/run-compose.test.ts`:

```ts
  it.skipIf(!hasDocker)('streams output before the process exits', async () => {
    const host = await realHost()
    const handle = host.runCompose(
      { directory: 'streamer', composeFile: 'compose.yaml' },
      ['config', '--format', 'json'],
    )
    const chunks: string[] = []
    for await (const chunk of handle.output) chunks.push(chunk.text)
    const result = await handle.result
    expect(result.exitCode).toBe(0)
    // The point of the handle: output was observable as an iterable, not only at the end.
    expect(chunks.join('')).toContain('services')
  })

  it.skipIf(!hasDocker)('settles result even when nobody reads output', async () => {
    const host = await realHost()
    const result = await host.runCompose(
      { directory: 'streamer', composeFile: 'compose.yaml' },
      ['config', '--format', 'json'],
    ).result
    expect(result.exitCode).toBe(0)
  })

  it('settles result when the compose path does not resolve', async () => {
    // No Docker needed: the path guard rejects before anything spawns. Without the
    // `.catch` on the async IIFE this hangs forever instead of resolving.
    const host = await realHost()
    const result = await host.runCompose(
      { directory: 'nope', composeFile: 'compose.yaml' },
      ['config'],
    ).result
    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toBe('')
  })
```

**Also move the existing `'refuses a directory outside the compose root'` test out of the
gated block.** The path guard rejects `../escape` before anything spawns, so it needs no
daemon — and the 1B-i carry-forward names these files as holding the only coverage of
compose-root confinement, coverage that silently disappears on a Docker-less CI while the
suite still reports green. Leave `'passes arguments as an array'` gated: without a daemon the
spawn fails immediately and both its assertions pass vacuously, which is worse than skipping.

The third test must **not** be `skipIf(!hasDocker)`, and that includes not being nested inside
a `describe.skipIf(!hasDocker)` block — the first attempt at this task put it there, which skips
it just as thoroughly. Put it in its own `describe` outside the gated one. It exercises the path
guard, which needs no daemon, and the carry-forward flags these files as holding the only
coverage of compose-root confinement. The carry-forward flags that these files' `skipIf` currently hides the only coverage
of compose-root confinement; every assertion here that can run without Docker must.

- [ ] **Step 10: Run everything**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm exec biome check .`
Expected: green, 243 tests. Any `.exitCode` on a `JobHandle` is a type error `tsc` will name.

- [ ] **Step 11: Commit**

```bash
git add src/server/host src/server/apps/compose-config.ts src/server/routes/apps.ts src/server/test-helpers.ts
git commit -m "Return a JobHandle from runCompose instead of a finished result"
```

---

### Task 2: Docker log frame demultiplexer

**Files:**
- Create: `src/server/host/log-demux.ts`, `src/server/host/log-demux.test.ts`

**Interfaces:**
- Consumes: `JobChunk`'s `stream` union, reused as `LogLine`'s.
- Produces:

```ts
export type DemuxedChunk = { text: string; stream: 'stdout' | 'stderr' }
export class LogFramingError extends Error {}
export class LogDemultiplexer {
  /** Throws `LogFramingError` if the stream is not actually framed. */
  push(buffer: Buffer): DemuxedChunk[]
  /** Flushes whatever the decoders are holding. Call once when the stream ends. */
  flush(): DemuxedChunk[]
}
```

Straight from spec §4: when a container has no TTY, Docker interleaves stdout and stderr on one
connection and frames each chunk with an 8-byte header — 1 byte stream type, 3 bytes padding,
4 bytes big-endian payload length. Treating that as text injects control bytes into log lines.

Two things make this worth its own file and its own test cycle. Network chunks split anywhere,
including in the middle of an 8-byte header and in the middle of a payload, so the parser is
stateful. And a UTF-8 character can straddle two frames, so each stream needs its own
`StringDecoder`; decoding each frame independently produces replacement characters in the middle
of otherwise valid log lines.

- [ ] **Step 1: Write the failing test**

`src/server/host/log-demux.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LogDemultiplexer, LogFramingError } from '@server/host/log-demux'

/** Builds one Docker log frame: 1 byte stream, 3 padding, 4-byte big-endian length. */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header = Buffer.alloc(8)
  header.writeUInt8(stream, 0)
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

const textOf = (chunks: Array<{ text: string }>) => chunks.map((c) => c.text).join('')

describe('LogDemultiplexer', () => {
  it('separates stdout from stderr', () => {
    const demux = new LogDemultiplexer()
    const out = demux.push(Buffer.concat([frame(1, 'to stdout\n'), frame(2, 'to stderr\n')]))
    expect(out).toEqual([
      { text: 'to stdout\n', stream: 'stdout' },
      { text: 'to stderr\n', stream: 'stderr' },
    ])
  })

  it('never emits the 8-byte header as text', () => {
    const demux = new LogDemultiplexer()
    const out = demux.push(frame(1, 'clean line\n'))
    // The bug this class exists to prevent: the header's NUL and length bytes appearing
    // in the log the user reads.
    expect(textOf(out)).toBe('clean line\n')
    expect(textOf(out)).not.toContain(' ')
  })

  it('reassembles frames split at EVERY byte boundary', () => {
    // The case that breaks a naive parser. A network chunk boundary lands wherever it
    // lands — inside the header, inside the payload, between the two.
    const whole = Buffer.concat([frame(1, 'alpha'), frame(2, 'beta'), frame(1, 'gamma')])
    for (let cut = 1; cut < whole.length; cut++) {
      const demux = new LogDemultiplexer()
      const chunks = [...demux.push(whole.subarray(0, cut)), ...demux.push(whole.subarray(cut))]
      expect(textOf(chunks), `split at ${cut}`).toBe('alphabetagamma')
      expect(chunks.filter((c) => c.stream === 'stderr').map((c) => c.text).join('')).toBe('beta')
    }
  })

  it('reassembles one byte at a time', () => {
    const whole = frame(1, 'drip')
    const demux = new LogDemultiplexer()
    const chunks = []
    for (const byte of whole) chunks.push(...demux.push(Buffer.from([byte])))
    expect(textOf(chunks)).toBe('drip')
  })

  it('keeps a multi-byte character intact when it straddles two frames', () => {
    // 'é' is two bytes in UTF-8, here delivered as two complete one-byte frames.
    // Decoding each frame on its own yields U+FFFD twice, which is what a per-frame
    // `toString('utf8')` produces and why each stream needs a persistent decoder.
    const accented = Buffer.from('é', 'utf8')
    const oneBytePayload = (byte: Buffer) =>
      Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 1]), byte])

    const demux = new LogDemultiplexer()
    const out = [
      ...demux.push(oneBytePayload(accented.subarray(0, 1))),
      ...demux.push(oneBytePayload(accented.subarray(1, 2))),
    ]
    expect(textOf(out)).toBe('é')
    expect(textOf(out)).not.toContain('\uFFFD')
  })

  it('does not interleave the two streams decoders', () => {
    // A partial UTF-8 sequence on stdout must not be completed by bytes from stderr.
    const demux = new LogDemultiplexer()
    const euro = Buffer.from('é', 'utf8')
    const out = [
      ...demux.push(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 1]), euro.subarray(0, 1)])),
      ...demux.push(frame(2, 'X')),
      ...demux.push(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 1]), euro.subarray(1, 2)])),
    ]
    expect(out.filter((c) => c.stream === 'stderr').map((c) => c.text).join('')).toBe('X')
    expect(out.filter((c) => c.stream === 'stdout').map((c) => c.text).join('')).toBe('é')
  })

  it('emits nothing for a zero-length frame', () => {
    expect(new LogDemultiplexer().push(frame(1, ''))).toEqual([])
  })

  it('throws rather than buffering forever on an impossible frame length', () => {
    // A four-byte length can claim 4 GB. The payload never arrives, so a parser that just
    // waits grows `pending` for the life of the process — and misframing never
    // resynchronises, because every later header is read at the wrong offset. The
    // realistic cause is a raw TTY stream being fed through the frame parser, where
    // ordinary log text is read as a length.
    const header = Buffer.alloc(8)
    header.writeUInt8(1, 0)
    header.writeUInt32BE(0xffffffff, 4)
    const demux = new LogDemultiplexer()
    expect(() => demux.push(header)).toThrow(LogFramingError)
    // And it does not keep the bytes it could not parse.
    expect(() => demux.push(Buffer.from('more'))).not.toThrow()
  })

  it('accepts a frame right at the size limit', () => {
    const header = Buffer.alloc(8)
    header.writeUInt8(1, 0)
    header.writeUInt32BE(16 * 1024 * 1024, 4)
    // Declared but not yet delivered: it waits, rather than rejecting a legal frame.
    expect(new LogDemultiplexer().push(header)).toEqual([])
  })

  it('discards a partial frame on flush rather than emitting half a payload', () => {
    const demux = new LogDemultiplexer()
    const header = Buffer.alloc(8)
    header.writeUInt8(1, 0)
    header.writeUInt32BE(4, 4)
    demux.push(Buffer.concat([header, Buffer.from('ab')])) // 2 of 4 bytes
    expect(demux.flush()).toEqual([])
    expect(demux.flush()).toEqual([])
  })

  it('treats an unknown stream byte as stdout rather than dropping the payload', () => {
    // Docker uses 0 for stdin on some endpoints. Losing the text would be worse than
    // filing it under the wrong stream.
    const demux = new LogDemultiplexer()
    const header = Buffer.alloc(8)
    header.writeUInt8(0, 0)
    header.writeUInt32BE(4, 4)
    const out = demux.push(Buffer.concat([header, Buffer.from('data')]))
    expect(out).toEqual([{ text: 'data', stream: 'stdout' }])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/host/log-demux.test.ts`
Expected: FAIL — cannot find module `@server/host/log-demux`.

- [ ] **Step 3: Write `src/server/host/log-demux.ts`**

```ts
import { StringDecoder } from 'node:string_decoder'

export type DemuxedChunk = { text: string; stream: 'stdout' | 'stderr' }

const HEADER_BYTES = 8

/**
 * Largest payload a single frame may declare.
 *
 * Docker's own log lines are capped far below this, so a larger figure means the bytes
 * are not framed at all — the likeliest cause being a stream we decided was non-TTY that
 * is actually raw, in which case arbitrary log text is being read as a length field. A
 * four-byte length can claim 4 GB; without this the parser waits forever for a payload
 * that never comes while `pending` grows for the life of the process.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Thrown when the byte stream cannot be framed. The caller should end the stream. */
export class LogFramingError extends Error {
  constructor(readonly declaredLength: number) {
    super(`Log frame declares ${declaredLength} bytes; the stream is not multiplexed`)
    this.name = 'LogFramingError'
  }
}

/**
 * Reassembles Docker's multiplexed log framing.
 *
 * A container without a TTY gets stdout and stderr interleaved on one connection, each
 * chunk prefixed by 8 bytes: stream type, three padding bytes, then a big-endian length.
 * Reading that as text puts NULs and length bytes into the log the user is looking at.
 *
 * Stateful because a network chunk boundary lands wherever it lands — mid-header as
 * readily as mid-payload. Two decoders because a UTF-8 character can straddle two frames
 * of the same stream, and decoding each frame alone turns it into replacement characters.
 * The decoders must not be shared: a half-finished character on stdout must not be
 * completed by the first byte of a stderr frame.
 */
export class LogDemultiplexer {
  private pending = Buffer.alloc(0)
  private readonly decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }

  push(buffer: Buffer): DemuxedChunk[] {
    this.pending = this.pending.length === 0 ? buffer : Buffer.concat([this.pending, buffer])
    const out: DemuxedChunk[] = []

    while (this.pending.length >= HEADER_BYTES) {
      const length = this.pending.readUInt32BE(4)
      // Fail loudly rather than buffering forever. Misframing does not resynchronise on
      // its own — every subsequent header is read at the wrong offset — so continuing
      // would emit garbage indefinitely while memory climbed.
      if (length > MAX_FRAME_BYTES) {
        this.pending = Buffer.alloc(0)
        throw new LogFramingError(length)
      }
      if (this.pending.length < HEADER_BYTES + length) break // payload still arriving

      // Anything other than 2 is stdout. Docker uses 0 for stdin on some endpoints, and
      // filing that under the wrong stream is better than discarding the text.
      const stream = this.pending.readUInt8(0) === 2 ? 'stderr' : 'stdout'
      const payload = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length)
      this.pending = this.pending.subarray(HEADER_BYTES + length)

      const text = this.decoders[stream].write(payload)
      if (text !== '') out.push({ text, stream })
    }

    return out
  }

  /**
   * Ends both decoders. A partial frame still in `pending` is discarded: its payload
   * never arrived, so there is nothing to decode. Safe to call twice.
   */
  flush(): DemuxedChunk[] {
    const out: DemuxedChunk[] = []
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = this.decoders[stream].end()
      if (text !== '') out.push({ text, stream })
    }
    this.pending = Buffer.alloc(0)
    return out
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm exec vitest run src/server/host/log-demux.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/host/log-demux.ts src/server/host/log-demux.test.ts
git commit -m "Demultiplex Docker's 8-byte log framing"
```

---

### Task 3: `streamLogs` and typed inspect on the Host

**Files:**
- Modify: `src/server/host/types.ts`, `src/server/host/local-host.ts`, `src/server/test-helpers.ts`
- Test: `src/server/host/stream-logs.test.ts`

**Interfaces:**
- Consumes: `LogDemultiplexer` (Task 2), `ChunkQueue` (Task 1).
- Produces:

```ts
export type LogOptions = { containerId: string; tail?: number; follow?: boolean; since?: number }
export type LogLine = { text: string; stream: 'stdout' | 'stderr' }

export type ContainerInspect = {
  id: string
  name: string
  image: string
  imageDigest: string | null
  state: string
  exitCode: number | null
  oomKilled: boolean
  startedAt: string | null
  finishedAt: string | null
  restartPolicy: string
  restartCount: number
  tty: boolean
  env: Array<{ key: string; masked: string }>
  mounts: Array<{ source: string; destination: string; mode: string; type: string }>
  ports: Array<{ container: number; host: number | null; protocol: string }>
  networks: string[]
  health: { status: string; failingStreak: number; log: Array<{ exitCode: number; output: string; end: string }> } | null
}

export type ImageInspect = { id: string; repoDigests: string[] }

// on Host:
streamLogs(opts: LogOptions): AsyncIterable<LogLine>
inspectContainer(id: string): Promise<ContainerInspect>   // was Promise<unknown>
inspectImage(ref: string): Promise<ImageInspect | null>   // null when the image is not pulled
```

`inspectContainer` currently returns `unknown` and nothing consumes it. Typing it here rather
than in Task 7 keeps the whole Host surface in one reviewable place, and the projection is what
lets the detail panel be written without an `as`.

**Env is masked at the Host boundary, not at the route.** `Config.Env` is where a container's
secrets live, and a projection that carries raw values would be one careless `JSON.stringify`
away from a log line or an error body. The mask is the same fixed-width `••••••••` the `.env`
API uses, with an empty value masking to `''`.

- [ ] **Step 1: Write the failing test**

`src/server/host/stream-logs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FakeHost } from '@server/test-helpers'

const collect = async (iterable: AsyncIterable<{ text: string }>) => {
  const seen: string[] = []
  for await (const line of iterable) seen.push(line.text)
  return seen.join('')
}

describe('FakeHost.streamLogs', () => {
  it('replays scripted lines and ends', async () => {
    const host = new FakeHost()
    host.logLines.set('abc', [
      { text: 'starting\n', stream: 'stdout' },
      { text: 'oops\n', stream: 'stderr' },
    ])
    const lines: Array<{ text: string; stream: string }> = []
    for await (const line of host.streamLogs({ containerId: 'abc' })) lines.push(line)
    expect(lines).toEqual([
      { text: 'starting\n', stream: 'stdout' },
      { text: 'oops\n', stream: 'stderr' },
    ])
  })

  it('yields nothing for a container with no scripted output', async () => {
    expect(await collect(new FakeHost().streamLogs({ containerId: 'quiet' }))).toBe('')
  })

  it('reports the requested container id so a route cannot silently ignore it', async () => {
    const host = new FakeHost()
    host.logLines.set('abc', [{ text: 'x', stream: 'stdout' }])
    await collect(host.streamLogs({ containerId: 'abc', tail: 50, follow: true }))
    expect(host.logCalls).toEqual([{ containerId: 'abc', tail: 50, follow: true }])
  })
})

describe('streamLogs cleanup contract', () => {
  it('opens nothing until the first next()', async () => {
    // The body is a generator: obtaining the iterable must not touch Docker. Measured
    // against the real daemon, five un-iterated iterables left the handle count
    // unchanged — this pins the same property against the fake.
    const host = new FakeHost()
    host.logLines.set('abc', [{ text: 'x', stream: 'stdout' }])
    const iterable = host.streamLogs({ containerId: 'abc' })
    expect(host.logCalls).toEqual([])
    // Only once someone asks for a value does it record the call.
    await iterable[Symbol.asyncIterator]().next()
    expect(host.logCalls).toHaveLength(1)
  })
})

describe('inspectContainer port projection', () => {
  it('reports an exposed-but-unpublished port as null, not port zero', async () => {
    // Docker gives `HostPort: ""` for a port that is exposed but not published, and
    // `Number("")` is 0 — finite, so a naive coercion tells the user the app is
    // reachable on port 0.
    const host = new FakeHost()
    host.inspected.set('abc', {
      id: 'abc', name: 'x', image: 'x', imageDigest: null, state: 'running',
      exitCode: null, oomKilled: false, startedAt: null, finishedAt: null,
      restartPolicy: 'no', restartCount: 0, tty: false, env: [], mounts: [],
      ports: [{ container: 80, host: null, protocol: 'tcp' }],
      networks: [], health: null,
    })
    expect((await host.inspectContainer('abc')).ports).toEqual([
      { container: 80, host: null, protocol: 'tcp' },
    ])
  })
})

describe('FakeHost.inspectContainer', () => {
  it('masks env values, never returning one', async () => {
    const host = new FakeHost()
    host.inspected.set('abc', {
      id: 'abc',
      name: 'jellyfin-web-1',
      image: 'nginx:alpine',
      imageDigest: 'sha256:aaa',
      state: 'running',
      exitCode: null,
      oomKilled: false,
      startedAt: '2026-09-10T00:00:00Z',
      finishedAt: null,
      restartPolicy: 'unless-stopped',
      restartCount: 0,
      tty: false,
      env: [
        { key: 'DB_PASSWORD', masked: '••••••••' },
        { key: 'EMPTY', masked: '' },
      ],
      mounts: [{ source: '/volume2/media', destination: '/media', mode: 'ro', type: 'bind' }],
      ports: [{ container: 80, host: 8099, protocol: 'tcp' }],
      networks: ['jellyfin_default'],
      health: null,
    })
    const inspected = await host.inspectContainer('abc')
    expect(JSON.stringify(inspected)).not.toContain('hunter2')
    expect(inspected.env).toEqual([
      { key: 'DB_PASSWORD', masked: '••••••••' },
      { key: 'EMPTY', masked: '' },
    ])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/host/stream-logs.test.ts`
Expected: FAIL — `streamLogs` and `logLines` do not exist on `FakeHost`.

- [ ] **Step 3: Add the types**

Append the `LogOptions`, `LogLine`, `ContainerInspect` and `ImageInspect` types from the
Interfaces block above to `src/server/host/types.ts`, and change the three `Host` members:

```ts
  streamLogs(opts: LogOptions): AsyncIterable<LogLine>;
  inspectContainer(id: string): Promise<ContainerInspect>;
  inspectImage(ref: string): Promise<ImageInspect | null>;
```

- [ ] **Step 4: Implement on `LocalHost`**

```ts
/** Fixed width, so the mask reveals nothing about a secret's length. Matches env-file.ts. */
const MASK = "••••••••";

  /**
   * Follows a container's logs.
   *
   * `Config.Tty` decides the framing. With a TTY, Docker sends raw bytes on one stream.
   * Without one — the normal case for a compose service — it interleaves stdout and stderr
   * with an 8-byte header per chunk, so the bytes must be demultiplexed or the log fills
   * with control characters.
   */
  /**
   * Consume this with `for await`, or call `return()` on the iterator yourself.
   *
   * The body is a generator, so nothing runs — and no socket is opened — until the first
   * `next()`. Measured: obtaining five iterables and never iterating them left the
   * process's handle count unchanged. But an iterator advanced once and then abandoned
   * without `return()` does leak, because only `return()` runs the `finally` below:
   * three such iterators added three handles. `for await` always calls `return()` on
   * break or throw, which is why every caller in this phase uses it.
   */
  async *streamLogs(opts: LogOptions): AsyncIterable<LogLine> {
    const container = this.docker.getContainer(opts.containerId);
    const details = await container.inspect();
    const tty = details.Config?.Tty === true;

    const stream = await container.logs({
      follow: opts.follow ?? false,
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 200,
      ...(opts.since === undefined ? {} : { since: opts.since }),
    });

    const queue = new ChunkQueue();
    const demux = tty ? null : new LogDemultiplexer();
    const ttyDecoder = tty ? new StringDecoder("utf8") : null;

    // dockerode types `logs` as Buffer | ReadableStream depending on `follow`; at runtime
    // with follow:true it is a stream, and with follow:false a Buffer.
    if (Buffer.isBuffer(stream)) {
      try {
        for (const chunk of demux
          ? demux.push(stream)
          : [{ text: stream.toString("utf8"), stream: "stdout" as const }]) {
          queue.push(chunk);
        }
        if (demux) for (const chunk of demux.flush()) queue.push(chunk);
      } catch (error) {
        queue.push({
          text: `\n[log stream ended: ${error instanceof Error ? error.message : "framing error"}]\n`,
          stream: "stderr",
        });
      }
      queue.close();
    } else {
      stream.on("data", (buffer: Buffer) => {
        if (demux) {
          try {
            for (const chunk of demux.push(buffer)) queue.push(chunk);
          } catch (error) {
            // `LogFramingError`: the bytes are not framed after all — most likely the
            // container was recreated with a TTY between our inspect and this stream.
            // End cleanly rather than throwing from a 'data' handler, which would be an
            // unhandled rejection rather than a closed log pane.
            queue.push({
              text: `\n[log stream ended: ${error instanceof Error ? error.message : "framing error"}]\n`,
              stream: "stderr",
            });
            queue.close();
            stream.destroy();
          }
        } else if (ttyDecoder) {
          const text = ttyDecoder.write(buffer);
          if (text !== "") queue.push({ text, stream: "stdout" });
        }
      });
      stream.on("end", () => {
        if (demux) for (const chunk of demux.flush()) queue.push(chunk);
        // The TTY path needs the same courtesy: without `end()` a stream finishing
        // mid-character drops it, so "café" arrives as "caf".
        if (ttyDecoder) {
          const trailing = ttyDecoder.end();
          if (trailing !== "") queue.push({ text: trailing, stream: "stdout" });
        }
        queue.close();
      });
      stream.on("error", () => {
        // Same flush as the `end` path. A socket dying mid-character would otherwise
        // drop it, and the two paths differing is how one of them silently rots.
        if (demux) for (const chunk of demux.flush()) queue.push(chunk);
        if (ttyDecoder) {
          const trailing = ttyDecoder.end();
          if (trailing !== "") queue.push({ text: trailing, stream: "stdout" });
        }
        queue.close();
      });
    }

    try {
      yield* queue;
    } finally {
      // The consumer breaking out of its `for await` lands here — which is the NORMAL
      // exit for the SSE log route, because browsers disconnect constantly. Without the
      // destroy the handlers keep firing into a queue nobody reads and the Docker socket
      // stays open, one per abandoned viewer.
      if (!Buffer.isBuffer(stream)) stream.destroy();
    }
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const raw = await this.docker.getContainer(id).inspect();
    return {
      id: raw.Id,
      name: raw.Name?.replace(/^\//, "") ?? id,
      image: raw.Config?.Image ?? "",
      imageDigest: raw.Image ?? null,
      state: raw.State?.Status ?? "unknown",
      exitCode: raw.State?.ExitCode ?? null,
      oomKilled: raw.State?.OOMKilled === true,
      startedAt: raw.State?.StartedAt ?? null,
      finishedAt: raw.State?.FinishedAt ?? null,
      restartPolicy: raw.HostConfig?.RestartPolicy?.Name ?? "no",
      restartCount: raw.RestartCount ?? 0,
      tty: raw.Config?.Tty === true,
      // Masked here, at the boundary, not at the route. Config.Env is where a container's
      // secrets are, and a projection carrying raw values is one JSON.stringify away from
      // an error body or a log line.
      env: (raw.Config?.Env ?? []).map((entry) => {
        const eq = entry.indexOf("=");
        const key = eq === -1 ? entry : entry.slice(0, eq);
        const value = eq === -1 ? "" : entry.slice(eq + 1);
        return { key, masked: value === "" ? "" : MASK };
      }),
      mounts: (raw.Mounts ?? []).map((mount) => ({
        source: mount.Source ?? "",
        destination: mount.Destination ?? "",
        mode: mount.RW === false ? "ro" : "rw",
        type: mount.Type ?? "bind",
      })),
      ports: Object.entries(raw.NetworkSettings?.Ports ?? {}).flatMap(([spec, bindings]) => {
        const [portText, protocol] = spec.split("/");
        const container = Number(portText);
        if (!Number.isFinite(container)) return [];
        // `HostPort` is "" for a port that is exposed but not published. `Number("")` is
        // 0, which is finite, so a naive coercion reports the app as reachable on port 0.
        const host = bindings?.[0]?.HostPort;
        const hostPort = host === undefined || host === "" ? Number.NaN : Number(host);
        return [{
          container,
          host: Number.isFinite(hostPort) && hostPort > 0 ? hostPort : null,
          protocol: protocol ?? "tcp",
        }];
      }),
      networks: Object.keys(raw.NetworkSettings?.Networks ?? {}),
      health: raw.State?.Health
        ? {
            status: raw.State.Health.Status ?? "unknown",
            failingStreak: raw.State.Health.FailingStreak ?? 0,
            log: (raw.State.Health.Log ?? []).slice(-5).map((entry) => ({
              exitCode: entry.ExitCode ?? 0,
              output: entry.Output ?? "",
              end: entry.End ?? "",
            })),
          }
        : null,
    };
  }

  /**
   * `null` when the image has never been pulled — a normal state — but a **throw** for
   * anything else.
   *
   * Swallowing every error made a wedged Docker socket indistinguishable from a missing
   * image, and the image-update checker reads `null` as "nothing local to compare", so a
   * broken socket would have reported every app as up to date rather than as unknown.
   * Docker answers 404 for a genuinely absent image; everything else is infrastructure.
   */
  async inspectImage(ref: string): Promise<ImageInspect | null> {
    try {
      const raw = await this.docker.getImage(ref).inspect();
      return { id: raw.Id, repoDigests: raw.RepoDigests ?? [] };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }
```

Add `StringDecoder` from `node:string_decoder`, `ChunkQueue` and `LogDemultiplexer` to the imports.

- [ ] **Step 5: Implement on `FakeHost`**

```ts
  logLines = new Map<string, LogLine[]>();
  logCalls: LogOptions[] = [];
  /** Scripted inspect data. NOTE the existing `inspected` field is a `string[]` call log —
   *  rename that to `inspectCalls` rather than replacing it, so nothing loses the log. */
  inspected = new Map<string, ContainerInspect>();
  inspectCalls: string[] = [];
  images = new Map<string, ImageInspect>();

  /**
   * Consume this with `for await`, or call `return()` on the iterator yourself.
   *
   * The body is a generator, so nothing runs — and no socket is opened — until the first
   * `next()`. Measured: obtaining five iterables and never iterating them left the
   * process's handle count unchanged. But an iterator advanced once and then abandoned
   * without `return()` does leak, because only `return()` runs the `finally` below:
   * three such iterators added three handles. `for await` always calls `return()` on
   * break or throw, which is why every caller in this phase uses it.
   */
  async *streamLogs(opts: LogOptions): AsyncIterable<LogLine> {
    this.logCalls.push(opts);
    for (const line of this.logLines.get(opts.containerId) ?? []) yield line;
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    this.inspectCalls.push(id);
    const found = this.inspected.get(id);
    if (!found) throw new Error(`no such container: ${id}`);
    return found;
  }

  async inspectImage(ref: string): Promise<ImageInspect | null> {
    return this.images.get(ref) ?? null;
  }
```

**`inspected` today is `string[]`** — a log of the ids passed to `inspectContainer`, pushed to
at `test-helpers.ts:106`, not a data map. Rename that field to `inspectCalls` and add
`inspected` as the `Map<string, ContainerInspect>` above; replacing it outright would silently
drop the call log. Nothing outside `test-helpers.ts` reads it today, so the rename is safe.

- [ ] **Step 6: Add an integration test against a real daemon**

Every test so far runs against `FakeHost`, which skips the TTY decision, the framing and
the masking entirely — so none of them touch the logic most likely to be wrong. This one
does. Put it in `src/server/host/stream-logs.integration.test.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { LocalHost } from '@server/host/local-host'

const run = promisify(execFile)
const hasDocker = await run('docker', ['version']).then(() => true).catch(() => false)

describe.skipIf(!hasDocker)('streamLogs against real Docker', () => {
  const name = `homestead-logtest-${Date.now()}`
  afterAll(async () => {
    await run('docker', ['rm', '-f', name]).catch(() => {})
  })

  it('separates stdout from stderr on a non-TTY container without leaking header bytes', async () => {
    // The case FakeHost cannot reach: a real multiplexed stream, whose 8-byte headers
    // become control characters in the log pane if the demultiplexer is wrong. The
    // accented text is here because a multi-byte character split across two frames comes
    // back as replacement characters without a persistent decoder.
    await run('docker', [
      'run', '--name', name, 'alpine:3',
      'sh', '-c', "echo 'out: café ✓'; echo 'err: problem' 1>&2; echo 'out: second'",
    ])
    const host = new LocalHost('local', '/tmp', '/var/run/docker.sock')
    await host.init()

    const lines: Array<{ text: string; stream: string }> = []
    for await (const line of host.streamLogs({ containerId: name, follow: false, tail: 100 })) {
      lines.push(line)
    }
    const textOf = (stream: string) =>
      lines.filter((l) => l.stream === stream).map((l) => l.text).join('')

    expect(textOf('stdout')).toContain('out: café ✓')
    expect(textOf('stdout')).toContain('out: second')
    expect(textOf('stderr')).toContain('err: problem')
    // No header bytes and no mangled characters.
    const all = lines.map((l) => l.text).join('')
    expect(all).not.toMatch(/[\u0000-\u0008]/)
    expect(all).not.toContain('\uFFFD')
  })

  it('masks env values from a real inspect', async () => {
    const host = new LocalHost('local', '/tmp', '/var/run/docker.sock')
    await host.init()
    const inspected = await host.inspectContainer(name)
    expect(inspected.env.length).toBeGreaterThan(0)
    // PATH always exists and always has a value; none of it may appear.
    expect(JSON.stringify(inspected.env)).not.toContain('/usr/local/sbin')
    expect(inspected.env.every((e) => e.masked === '••••••••' || e.masked === '')).toBe(true)
  })
})
```

- [ ] **Step 7: Run everything**

Run: `pnpm exec vitest run src/server/host/stream-logs.test.ts && pnpm test && pnpm exec tsc --noEmit`
Expected: the focused file passes 5 tests; the full suite stays green.

- [ ] **Step 8: Commit**

```bash
git add src/server/host src/server/test-helpers.ts
git commit -m "Add streamLogs and typed container and image inspection"
```

---

### Task 4: Job runner — per-app mutex, persistence, grace window

**Files:**
- Create: `src/server/apps/job-runner.ts`, `src/server/apps/job-runner.test.ts`

**Interfaces:**
- Consumes: `JobHandle`, `ChunkQueue`, the `jobs` and `apps` tables.
- Produces:

```ts
export const JOB_KINDS = ['up', 'down', 'restart', 'pull'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export type RunningJob = {
  id: string
  appId: string
  kind: JobKind
  output: AsyncIterable<JobChunk>
  done: Promise<void>
}

export class JobRunner {
  constructor(deps: { db: Db; host: Host; composeConfig: ComposeConfigCache })
  /** Rejects with `JobBusyError` if this app already has a job running. */
  start(app: AppRow, kind: JobKind, userId: string): Promise<RunningJob>
  /** A running job's live output, or undefined once it has finished. */
  live(jobId: string): RunningJob | undefined
  cancel(jobId: string): boolean
}

export class JobBusyError extends Error { constructor(readonly runningJobId: string) }
```

Spec §4: "A per-app mutex prevents a `pull` and a `down` from racing," and §3: "`docker compose
pull` on a large stack runs for minutes; it cannot be an HTTP request." So `start` returns as
soon as the row exists and the process is spawned; the caller streams or polls.

The mutex is an in-process `Map`. Homestead is a single Node process by design (spec §2), and a
second process would need a database lock instead — recorded here so a future reader knows the
bound rather than assuming this is general.

**`graceUntil` is set when the job finishes, not when it starts.** During a `pull` the old
containers are still up and their status is meaningful; suppressing it would hide a real failure
for the whole length of the pull.

- [ ] **Step 1: Write the failing test**

`src/server/apps/job-runner.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { JobBusyError, JobRunner } from '@server/apps/job-runner'
import { ComposeConfigCache } from '@server/apps/compose-config'
import { createDb, runMigrations } from '@server/db/client'
import { apps, hosts, jobs, users } from '@server/db/schema'
import { FakeHost } from '@server/test-helpers'

async function seed() {
  const { db } = await createDb(':memory:')
  await runMigrations(db)
  await db.insert(hosts).values({
    id: 'local', name: 'local', composeRoot: '/v', dockerSocket: '/s',
  })
  const userId = ulid()
  await db.insert(users).values({
    id: userId, email: 'a@example.com', name: 'A', role: 'admin',
    emailVerified: true, createdAt: Date.now(), updatedAt: Date.now(),
  })
  const app = {
    id: ulid(), hostId: 'local', slug: 'jellyfin', displayName: 'Jellyfin',
    directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
  }
  await db.insert(apps).values(app)
  const [row] = await db.select().from(apps).where(eq(apps.id, app.id))
  if (!row) throw new Error('seed failed')

  const host = new FakeHost()
  host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  return { db, host, row, userId, runner: new JobRunner({ db, host, composeConfig: new ComposeConfigCache(host) }) }
}

describe('JobRunner', () => {
  it('records a job row and its output', async () => {
    const { db, host, row, userId, runner } = await seed()
    host.composeResults.set('up -d', { exitCode: 0, stdout: 'Container started\n', stderr: '' })

    const job = await runner.start(row, 'up', userId)
    await job.done

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id))
    expect(saved?.status).toBe('succeeded')
    expect(saved?.exitCode).toBe(0)
    expect(saved?.kind).toBe('up')
    expect(saved?.output).toContain('Container started')
  })

  it('marks a non-zero exit as failed', async () => {
    const { db, host, row, userId, runner } = await seed()
    host.composeResults.set('up -d', { exitCode: 1, stdout: '', stderr: 'no such image\n' })
    const job = await runner.start(row, 'up', userId)
    await job.done
    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id))
    expect(saved?.status).toBe('failed')
    expect(saved?.exitCode).toBe(1)
    expect(saved?.output).toContain('no such image')
  })

  it('refuses a second job while one is running, naming the one in flight', async () => {
    // The mutex. A `pull` and a `down` racing on one stack is how a user ends up with
    // half-replaced containers and no way to tell what happened.
    const { host, row, userId, runner } = await seed()
    host.composeResults.set('pull', { exitCode: 0, stdout: 'pulled\n', stderr: '' })
    host.gateCompose()

    const first = await runner.start(row, 'pull', userId)
    await expect(runner.start(row, 'down', userId)).rejects.toBeInstanceOf(JobBusyError)

    host.releaseCompose()
    await first.done
    // Once it finishes the lock is gone.
    host.composeResults.set('down', { exitCode: 0, stdout: 'stopped\n', stderr: '' })
    await (await runner.start(row, 'down', userId)).done
  })

  it('holds the mutex against two starts in the SAME TICK', async () => {
    // The form the serialised test cannot catch. Measured with the row insert placed
    // before the reservation: both calls returned a job and both spawned
    // `docker compose up` on one stack, because each passed the busy check while the
    // other was still awaiting its insert. A double-click on Deploy is enough.
    const { host, row, userId, runner } = await seed()
    host.composeResults.set('up -d', { exitCode: 0, stdout: 'ok\n', stderr: '' })
    host.gateCompose()

    const settled = await Promise.allSettled([
      runner.start(row, 'up', userId),
      runner.start(row, 'up', userId),
    ])
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const rejected = settled.find((r) => r.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(JobBusyError)

    host.releaseCompose()
  })

  it('frees the slot when the job row cannot be written', async () => {
    // The process is spawned before the insert, so a failed insert must not leave an
    // untracked `up` running against an app that now looks idle.
    const { db, host, row, userId, runner } = await seed()
    host.composeResults.set('up -d', { exitCode: 0, stdout: '', stderr: '' })
    // A second row with the same primary key is the simplest way to make the insert fail.
    const clash = ulid()
    const original = db.insert.bind(db)
    let first = true
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
    ;(db as any).insert = (table: unknown) => {
      if (first) {
        first = false
        throw new Error('disk I/O error')
      }
      return original(table as never)
    }
    await expect(runner.start(row, 'up', userId)).rejects.toThrow('disk I/O error')
    // biome-ignore lint/suspicious/noExplicitAny: restore
    ;(db as any).insert = original
    void clash

    // The app is usable again immediately.
    host.composeResults.set('down', { exitCode: 0, stdout: '', stderr: '' })
    await (await runner.start(row, 'down', userId)).done
  })

  it('releases the mutex even when the job throws', async () => {
    const { host, row, userId, runner } = await seed()
    host.composeResults.set('up -d', { exitCode: 1, stdout: '', stderr: 'boom' })
    await (await runner.start(row, 'up', userId)).done
    // A failed job must not wedge the app forever.
    host.composeResults.set('down', { exitCode: 0, stdout: '', stderr: '' })
    await (await runner.start(row, 'down', userId)).done
  })

  it('sets the grace window when the job finishes, not when it starts', async () => {
    const { db, host, row, userId, runner } = await seed()
    host.composeResults.set('restart', { exitCode: 0, stdout: 'ok\n', stderr: '' })
    host.gateCompose()
    const job = await runner.start(row, 'restart', userId)

    const [during] = await db.select().from(apps).where(eq(apps.id, row.id))
    // Still running: the old containers are up and their status is real. Suppressing it
    // for the length of a multi-minute pull would hide a genuine failure.
    expect(during?.graceUntil).toBeNull()

    host.releaseCompose()
    await job.done
    const [after] = await db.select().from(apps).where(eq(apps.id, row.id))
    expect(after?.graceUntil).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('streams output as chunks, not as one blob', async () => {
    const { host, row, userId, runner } = await seed()
    host.composeChunkCount = 4
    host.composeResults.set('up -d', { exitCode: 0, stdout: 'abcdefgh', stderr: '' })
    const job = await runner.start(row, 'up', userId)
    const chunks: string[] = []
    for await (const chunk of job.output) chunks.push(chunk.text)
    await job.done
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe('abcdefgh')
  })

  it('caps the persisted output, keeping the tail', async () => {
    const { db, host, row, userId, runner } = await seed()
    host.composeResults.set('pull', { exitCode: 0, stdout: `${'x'.repeat(300_000)}THE-END`, stderr: '' })
    const job = await runner.start(row, 'pull', userId)
    await job.done
    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id))
    expect((saved?.output ?? '').length).toBeLessThan(300_000)
    // The end is where the error is.
    expect(saved?.output).toContain('THE-END')
    expect(saved?.output).toContain('truncated')
  })

  it('invalidates the compose config cache after a job', async () => {
    // `up` can pull a new image and `pull` certainly does, so the resolved config and the
    // container set the status rollup compares against are both stale afterwards.
    // The cache must be the SAME instance the runner holds, and the db the same one the
    // app row lives in — a second `seed()` here would violate the app's foreign key and
    // fail for a reason that has nothing to do with caching.
    const { db, host, row, userId } = await seed()
    host.composeResults.set('config --format json', {
      exitCode: 0, stdout: JSON.stringify({ name: 'jellyfin', services: {} }), stderr: '',
    })
    host.composeResults.set('up -d', { exitCode: 0, stdout: '', stderr: '' })

    const cache = new ComposeConfigCache(host)
    const runner = new JobRunner({ db, host, composeConfig: cache })
    const target = { directory: 'jellyfin', composeFile: 'compose.yaml' }

    await cache.resolve(target)
    const afterFirstResolve = host.composeCalls.length
    await (await runner.start(row, 'up', userId)).done
    await cache.resolve(target)

    // One call for `up`, one for the re-resolve. Without the invalidation the second
    // resolve is a cache hit and this is `afterFirstResolve + 1`.
    expect(host.composeCalls.length).toBe(afterFirstResolve + 2)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/apps/job-runner.test.ts`
Expected: FAIL — cannot find module `@server/apps/job-runner`.

- [ ] **Step 3: Write `src/server/apps/job-runner.ts`**

```ts
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Db } from '../db/client.js'
import { apps, jobs } from '../db/schema.js'
import type { Host, JobChunk, JobHandle } from '../host/types.js'
import type { ComposeConfigCache } from './compose-config.js'

export const JOB_KINDS = ['up', 'down', 'restart', 'pull'] as const
export type JobKind = (typeof JOB_KINDS)[number]

/** The compose arguments each action maps to. Fixed here so no caller can pass its own. */
const ARGS: Record<JobKind, string[]> = {
  up: ['up', '-d'],
  down: ['down'],
  restart: ['restart'],
  pull: ['pull'],
}

/** A `pull` on a large stack runs for minutes; 30 is generous without being unbounded. */
const JOB_TIMEOUT_MS = 30 * 60_000
/** Persisted output cap. The tail is kept — the end is where the error is. */
const OUTPUT_CAP = 256 * 1024
/** Seconds after a job during which probe failures render as `starting` (spec §4). */
const GRACE_SECONDS = 120

export class JobBusyError extends Error {
  constructor(readonly runningJobId: string) {
    super('Another job is already running for this app')
    this.name = 'JobBusyError'
  }
}

export type AppRow = typeof apps.$inferSelect

export type RunningJob = {
  id: string
  appId: string
  kind: JobKind
  output: AsyncIterable<JobChunk>
  done: Promise<void>
}

export class JobRunner {
  /**
   * The per-app mutex, and the registry the SSE route reads to attach to a job already in
   * flight. In-process because Homestead is one Node process by design (spec §2) — a
   * second process would need a row lock instead.
   */
  private readonly running = new Map<string, RunningJob & { handle: JobHandle }>()

  constructor(
    private readonly deps: { db: Db; host: Host; composeConfig: ComposeConfigCache },
  ) {}

  live(jobId: string): RunningJob | undefined {
    for (const job of this.running.values()) if (job.id === jobId) return job
    return undefined
  }

  cancel(jobId: string): boolean {
    for (const job of this.running.values()) {
      if (job.id === jobId) {
        job.handle.cancel()
        return true
      }
    }
    return false
  }

  async start(app: AppRow, kind: JobKind, userId: string): Promise<RunningJob> {
    const inFlight = this.running.get(app.id)
    if (inFlight) throw new JobBusyError(inFlight.id)

    // EVERYTHING from here to `this.running.set` must be synchronous.
    //
    // Measured with the insert placed first: two `start` calls in the same tick both
    // returned a job and both spawned `docker compose up` on the same stack, because
    // each passed the check above while the other was still awaiting its insert. A
    // double-click on Deploy is enough. `ulid()` and `runCompose` are both synchronous —
    // `runCompose` returns a handle, not a promise — so the slot can be taken before any
    // await exists to yield at.
    const id = ulid()
    const handle = this.deps.host.runCompose(
      { directory: app.directory, composeFile: app.composeFile },
      ARGS[kind],
      { timeoutMs: JOB_TIMEOUT_MS },
    )
    const job: RunningJob & { handle: JobHandle } = {
      id, appId: app.id, kind, handle,
      output: handle.output,
      done: Promise.resolve(),
    }
    this.running.set(app.id, job)

    try {
      await this.deps.db.insert(jobs).values({
        id, appId: app.id, kind, status: 'running',
        startedAt: Math.floor(Date.now() / 1000), userId,
      })
    } catch (error) {
      // The process is already running but has no row to record it against. Kill it and
      // free the slot, rather than leaving an untracked `up` on the user's stack.
      handle.cancel()
      this.running.delete(app.id)
      throw error
    }

    job.done = this.finish(app, job, handle)
    return job
  }

  private async finish(app: AppRow, job: RunningJob, handle: JobHandle): Promise<void> {
    try {
      const result = await handle.result
      const combined = [result.stdout, result.stderr].filter((part) => part !== '').join('\n')
      const output =
        combined.length > OUTPUT_CAP
          ? `… output truncated, showing the last ${OUTPUT_CAP} characters …\n${combined.slice(combined.length - OUTPUT_CAP)}`
          : combined

      await this.deps.db
        .update(jobs)
        .set({
          status: result.exitCode === 0 ? 'succeeded' : 'failed',
          exitCode: result.exitCode,
          finishedAt: Math.floor(Date.now() / 1000),
          output,
        })
        .where(eq(jobs.id, job.id))

      // The config and the container set are both stale now: `up` can pull a new image and
      // `pull` certainly does.
      this.deps.composeConfig.invalidate({
        directory: app.directory,
        composeFile: app.composeFile,
      })

      // Set on completion, not on start. During a multi-minute `pull` the old containers
      // are still up and their status is real; suppressing it would hide a live failure.
      await this.deps.db
        .update(apps)
        .set({ graceUntil: Math.floor(Date.now() / 1000) + GRACE_SECONDS })
        .where(eq(apps.id, app.id))
    } finally {
      // Always, or a failed job wedges the app until restart.
      this.running.delete(app.id)
    }
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm exec vitest run src/server/apps/job-runner.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run everything and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec biome check .
git add src/server/apps/job-runner.ts src/server/apps/job-runner.test.ts
git commit -m "Run compose actions as jobs behind a per-app mutex"
```

---

### Task 5: SSE helper and lifecycle routes

**Files:**
- Create: `src/server/sse.ts`, `src/server/routes/jobs.ts`, `src/server/routes/jobs.test.ts`
- Modify: `src/server/app.ts` (register `jobRoutes`, add `jobs: JobRunner` to `AppDeps`), `src/server/index.ts`, `src/server/test-helpers.ts`
- Modify: `src/server/routes/apps.ts` — export `loadApp` so `jobs.ts` can use it

**Interfaces:**
- Consumes: `JobRunner`, `JobBusyError`, `loadApp`.
- Produces: `POST /api/apps/:id/actions/:kind`, `GET /api/jobs/:jobId`, `GET /api/jobs/:jobId/stream`, and

```ts
export function sseResponse(request: FastifyRequest, reply: FastifyReply): {
  send(event: string, data: unknown): void
  close(): void
  /** Resolves when the client disconnects. */
  closed: Promise<void>
}
```

**A hijacked reply is never returned.** `sseResponse` calls `reply.hijack()`, so the handler
owns the socket; returning `reply` afterwards asks Fastify to send a second response over a
socket already written to and closed. Handlers that take the SSE path return nothing, and every
pre-SSE guard must `return reply.code(...).send(...)` *before* `sseResponse` is called.

`loadApp` currently lives inside the `appRoutes` closure. Extract it to a module-level function
taking `db` so both route files use the same one — the Global Constraint says it is the only way
a route loads an app, and a second copy in `jobs.ts` would be exactly the drift that constraint
exists to prevent.

Lifecycle requires `app:lifecycle`. Reading a job requires `app:config` — job output is compose
output and can name paths and images.

- [ ] **Step 1: Write the failing test**

`src/server/routes/jobs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp, createViewer, signUpAdmin } from '@server/test-helpers'

const CONFIG = JSON.stringify({ name: 'jellyfin', services: { web: { image: 'nginx' } } })

async function withApp() {
  const app = await buildTestApp()
  const { cookie } = await signUpAdmin(app)
  app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  app.deps.host.composeResults.set('config --format json', {
    exitCode: 0, stdout: CONFIG, stderr: '',
  })
  const adopted = await app.inject({
    method: 'POST', url: '/api/apps/adopt', headers: { cookie },
    payload: { directories: ['jellyfin'] },
  })
  return { app, cookie, id: adopted.json().adopted[0].id as string }
}

/** Polls until `ready`, or fails loudly rather than hanging the suite. */
async function until<T>(attempt: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await attempt()
    if (ready(value)) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condition never became true')
}

describe('lifecycle routes', () => {
  it('starts a job and returns its id immediately', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.composeResults.set('up -d', { exitCode: 0, stdout: 'started\n', stderr: '' })
    const res = await app.inject({
      method: 'POST', url: `/api/apps/${id}/actions/up`, headers: { cookie },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    await app.close()
  })

  it('refuses an unknown action rather than passing it to compose', async () => {
    const { app, cookie, id } = await withApp()
    const res = await app.inject({
      method: 'POST', url: `/api/apps/${id}/actions/rm%20-rf`, headers: { cookie },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown_action')
    // Nothing reached the host.
    expect(app.deps.host.composeCalls.some((c) => c.args.includes('rm -rf'))).toBe(false)
    await app.close()
  })

  it('refuses a viewer', async () => {
    const { app, cookie, id } = await withApp()
    const viewer = await createViewer(app, cookie)
    const res = await app.inject({
      method: 'POST', url: `/api/apps/${id}/actions/up`, headers: { cookie: viewer.cookie },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('returns 404 for an app outside the caller\'s scope', async () => {
    const { app, cookie, id } = await withApp()
    const created = await app.inject({
      method: 'POST', url: '/api/users', headers: { cookie },
      payload: {
        email: 'scoped@example.com', password: 'correct-horse-battery', name: 'S',
        role: 'admin', scopeAllApps: false, appIds: [],
      },
    })
    expect(created.statusCode).toBe(201)
    const signIn = await app.inject({
      method: 'POST', url: '/api/auth/sign-in/email',
      payload: { email: 'scoped@example.com', password: 'correct-horse-battery' },
    })
    const scoped = String(signIn.headers['set-cookie'] ?? '').split(';')[0] ?? ''
    const res = await app.inject({
      method: 'POST', url: `/api/apps/${id}/actions/up`, headers: { cookie: scoped },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 409 when a job is already running for the app', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.composeResults.set('pull', { exitCode: 0, stdout: 'ok\n', stderr: '' })
    app.deps.host.gateCompose()
    const first = await app.inject({
      method: 'POST', url: `/api/apps/${id}/actions/pull`, headers: { cookie },
    })
    expect(first.statusCode).toBe(202)
    const second = await app.inject({
      method: 'POST', url: `/api/apps/${id}/actions/down`, headers: { cookie },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('job_running')
    expect(second.json().runningJobId).toBe(first.json().jobId)
    app.deps.host.releaseCompose()
    await app.close()
  })

  it('reports a finished job with its output', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.composeResults.set('up -d', { exitCode: 0, stdout: 'started\n', stderr: '' })
    const started = await app.inject({
      method: 'POST', url: `/api/apps/${id}/actions/up`, headers: { cookie },
    })
    const jobId = started.json().jobId
    // Poll rather than `await live(jobId)?.done`: `live` returns undefined once the job
    // has finished, so `?.done` silently no-ops and the GET below races the runner.
    const res = await until(
      () => app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } }),
      (r) => r.json().status !== 'running',
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'succeeded', exitCode: 0, kind: 'up' })
    expect(res.json().output).toContain('started')
    await app.close()
  })

  it('streams a running job\'s output over SSE and ends with a result event', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.composeChunkCount = 4
    app.deps.host.composeResults.set('up -d', { exitCode: 0, stdout: 'abcdefgh', stderr: '' })
    const started = await app.inject({
      method: 'POST', url: `/api/apps/${id}/actions/up`, headers: { cookie },
    })
    const res = await app.inject({
      method: 'GET', url: `/api/jobs/${started.json().jobId}/stream`, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    // Chunks arrive as separate events — the fake splits into four, and code that
    // assumed one blob would emit one.
    expect(res.body.match(/event: output/g)?.length).toBeGreaterThan(1)
    expect(res.body).toContain('event: done')
    const payloads = [...res.body.matchAll(/event: output\ndata: (.*)/g)]
      .map((m) => JSON.parse(m[1] ?? '{}').text)
      .join('')
    expect(payloads).toBe('abcdefgh')
    await app.close()
  })

  it('returns 404 streaming a job id that does not exist', async () => {
    const { app, cookie } = await withApp()
    const res = await app.inject({
      method: 'GET', url: '/api/jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV/stream', headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/routes/jobs.test.ts`
Expected: FAIL — the routes are not registered (404 where 202 is expected).

- [ ] **Step 3: Write `src/server/sse.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify'

/** Comment frame every 25s. Keeps intermediaries from closing an idle stream. */
const HEARTBEAT_MS = 25_000

/**
 * Turns a reply into a Server-Sent Events stream.
 *
 * `X-Accel-Buffering: no` matters even though Homestead has no nginx in front of it
 * today: a user putting one there would otherwise see nothing until the stream closed,
 * which looks exactly like a hung job.
 */
export function sseResponse(request: FastifyRequest, reply: FastifyReply) {
  // Tells Fastify we own the socket from here. Without it Fastify also tries to send a
  // response, and its headers arrive after ours have already gone out on the wire.
  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.flushHeaders()

  let open = true
  const heartbeat = setInterval(() => {
    if (open) reply.raw.write(': ping\n\n')
  }, HEARTBEAT_MS)

  const close = () => {
    if (!open) return
    open = false
    clearInterval(heartbeat)
    reply.raw.end()
  }

  const closed = new Promise<void>((resolve) => {
    request.raw.on('close', () => {
      open = false
      clearInterval(heartbeat)
      resolve()
    })
  })

  return {
    send(event: string, data: unknown): void {
      if (!open) return
      // One JSON object per event, so a newline inside the payload cannot terminate the
      // frame — a log line containing "\n\n" would otherwise split into two events.
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    close,
    closed,
  }
}
```

- [ ] **Step 4: Extract `loadApp` from `appRoutes`**

In `src/server/routes/apps.ts`, lift the helper to module scope and export it, leaving the
in-closure call sites reading `loadApp(db, ctx, id)`:

```ts
/**
 * The single way any route loads an app by id. Composing `visibleAppsWhere` here rather
 * than at each call site is the point: a route that forgets it cannot be spotted by
 * reading that route, only by reading all of them and noticing one differs. Out of scope
 * is 404, not 403, so the answer does not confirm an app the caller may not see exists.
 */
export async function loadApp(db: Db, ctx: AuthContext, id: string) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, id), visibleAppsWhere(ctx)))
  return row
}
```

- [ ] **Step 5: Write `src/server/routes/jobs.ts`**

```ts
import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { JOB_KINDS, JobBusyError, type JobKind } from '../apps/job-runner.js'
import { audit } from '../audit.js'
import { requireCapability } from '../auth/context.js'
import { jobs } from '../db/schema.js'
import { sseResponse } from '../sse.js'
import { loadApp } from './apps.js'

const kindSchema = z.enum(JOB_KINDS)

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const { db, jobs: runner } = app.deps

  app.post('/api/apps/:id/actions/:kind', async (request, reply) => {
    const ctx = requireCapability(request, 'app:lifecycle')
    const params = z.object({ id: z.string(), kind: z.string() }).parse(request.params)

    // Parsed against a closed set before anything reaches the host. The action never
    // becomes an argument the caller chose — `ARGS` in the runner owns that mapping.
    const kind = kindSchema.safeParse(params.kind)
    if (!kind.success) {
      return reply.code(400).send({ error: 'unknown_action', message: `Unknown action: ${params.kind}` })
    }

    const row = await loadApp(db, ctx, params.id)
    if (!row) return reply.code(404).send({ error: 'not_found' })

    try {
      const job = await runner.start(row, kind.data as JobKind, ctx.userId)
      await audit(db, ctx, {
        action: `app.${kind.data}`, targetType: 'app', targetId: row.id, ip: request.ip,
      })
      return reply.code(202).send({ jobId: job.id })
    } catch (error) {
      if (error instanceof JobBusyError) {
        return reply.code(409).send({
          error: 'job_running',
          message: 'Another job is already running for this app.',
          runningJobId: error.runningJobId,
        })
      }
      throw error
    }
  })

  app.get('/api/jobs/:jobId', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params)
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId))
    if (!job?.appId) return reply.code(404).send({ error: 'not_found' })
    // Scope is a property of the app, so it is checked against the app, not the job row.
    if (!(await loadApp(db, ctx, job.appId))) return reply.code(404).send({ error: 'not_found' })
    return job
  })

  app.get('/api/apps/:id/jobs', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const row = await loadApp(db, ctx, id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    return db.select().from(jobs).where(eq(jobs.appId, id)).orderBy(desc(jobs.createdAt)).limit(20)
  })

  app.get('/api/jobs/:jobId/stream', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId))
    if (!job?.appId) return reply.code(404).send({ error: 'not_found' })
    if (!(await loadApp(db, ctx, job.appId))) return reply.code(404).send({ error: 'not_found' })

    const live = runner.live(jobId)
    const sse = sseResponse(request, reply)

    if (!live) {
      // Already finished. Send what was persisted and close, so the client does not have
      // to know whether it attached in time.
      sse.send('output', { text: job.output ?? '', stream: 'stdout' })
      sse.send('done', { status: job.status, exitCode: job.exitCode })
      sse.close()
      return
    }

    let disconnected = false
    void sse.closed.then(() => {
      disconnected = true
    })

    for await (const chunk of live.output) {
      if (disconnected) break
      sse.send('output', chunk)
    }
    await live.done

    const [finished] = await db.select().from(jobs).where(eq(jobs.id, jobId))
    sse.send('done', { status: finished?.status ?? 'failed', exitCode: finished?.exitCode ?? null })
    sse.close()
    // No `return reply`: the reply is hijacked, so returning it would ask Fastify to
    // send a second response over a socket we have already written to and closed.
  })
}
```

- [ ] **Step 6: Wire it up**

In `src/server/app.ts`, add `jobs: JobRunner` to `AppDeps` and register **after** `appRoutes`
and **before** `spaRoutes` — the SPA fallback must stay last or it swallows the API. Do not move
`setErrorHandler`; it must keep preceding every `register()`, because Fastify child contexts
capture the parent's handler at registration time.

```ts
  await app.register(jobRoutes)
```

Construct the runner in `src/server/index.ts` and `src/server/test-helpers.ts`:

```ts
const composeConfig = new ComposeConfigCache(host)
const jobs = new JobRunner({ db, host, composeConfig })
```

- [ ] **Step 7: Run it and confirm it passes**

Run: `pnpm exec vitest run src/server/routes/jobs.test.ts && pnpm test && pnpm exec tsc --noEmit`
Expected: the focused file passes 8 tests; the full suite stays green.

- [ ] **Step 8: Commit**

```bash
git add src/server/sse.ts src/server/routes/jobs.ts src/server/routes/jobs.test.ts src/server/app.ts src/server/index.ts src/server/test-helpers.ts src/server/routes/apps.ts
git commit -m "Add lifecycle actions as SSE-streamed jobs"
```

---

### Task 6: Log streaming route

**Files:**
- Create: `src/server/routes/logs.ts`, `src/server/routes/logs.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Consumes: `Host.streamLogs`, `sseResponse`, `loadApp`.
- Produces: `GET /api/apps/:id/containers/:containerId/logs` (SSE).

Requires `app:config`. The container must belong to the app — otherwise the id is a free-form
handle to any container on the host, including one from an app the caller cannot see.

- [ ] **Step 1: Write the failing test**

`src/server/routes/logs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp, createViewer, signUpAdmin } from '@server/test-helpers'

const CONFIG = JSON.stringify({ name: 'jellyfin', services: { web: { image: 'nginx' } } })

async function withApp() {
  const app = await buildTestApp()
  const { cookie } = await signUpAdmin(app)
  app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  app.deps.host.composeResults.set('config --format json', { exitCode: 0, stdout: CONFIG, stderr: '' })
  app.deps.host.containers = [{
    id: 'container-1', names: ['jellyfin-web-1'], image: 'nginx', state: 'running',
    status: 'Up 2 hours', project: 'jellyfin', service: 'web', labels: {},
  }]
  const adopted = await app.inject({
    method: 'POST', url: '/api/apps/adopt', headers: { cookie },
    payload: { directories: ['jellyfin'] },
  })
  return { app, cookie, id: adopted.json().adopted[0].id as string }
}

describe('log streaming', () => {
  it('streams lines as separate events, tagged by stream', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.logLines.set('container-1', [
      { text: 'listening on 8096\n', stream: 'stdout' },
      { text: 'permission denied\n', stream: 'stderr' },
    ])
    const res = await app.inject({
      method: 'GET', url: `/api/apps/${id}/containers/container-1/logs`, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.body.match(/event: line/g)).toHaveLength(2)
    expect(res.body).toContain('"stream":"stderr"')
    expect(res.body).toContain('permission denied')
    await app.close()
  })

  it('refuses a container that belongs to a different app', async () => {
    // Otherwise the container id is a handle to anything on the host, including a
    // container from an app this caller cannot see.
    const { app, cookie, id } = await withApp()
    app.deps.host.containers.push({
      id: 'other-1', names: ['paperless-web-1'], image: 'x', state: 'running',
      status: 'Up', project: 'paperless', service: 'web', labels: {},
    })
    app.deps.host.logLines.set('other-1', [{ text: 'secret\n', stream: 'stdout' }])
    const res = await app.inject({
      method: 'GET', url: `/api/apps/${id}/containers/other-1/logs`, headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('secret')
    await app.close()
  })

  it('refuses a viewer', async () => {
    const { app, cookie, id } = await withApp()
    const viewer = await createViewer(app, cookie)
    const res = await app.inject({
      method: 'GET', url: `/api/apps/${id}/containers/container-1/logs`,
      headers: { cookie: viewer.cookie },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('passes tail and follow through to the host', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.logLines.set('container-1', [{ text: 'x\n', stream: 'stdout' }])
    await app.inject({
      method: 'GET', url: `/api/apps/${id}/containers/container-1/logs?tail=50&follow=false`,
      headers: { cookie },
    })
    expect(app.deps.host.logCalls[0]).toMatchObject({
      containerId: 'container-1', tail: 50, follow: false,
    })
    await app.close()
  })

  it('clamps an absurd tail rather than passing it through', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.logLines.set('container-1', [{ text: 'x\n', stream: 'stdout' }])
    await app.inject({
      method: 'GET', url: `/api/apps/${id}/containers/container-1/logs?tail=999999`,
      headers: { cookie },
    })
    expect(app.deps.host.logCalls[0]?.tail).toBe(5000)
    await app.close()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/routes/logs.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write `src/server/routes/logs.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireCapability } from '../auth/context.js'
import { sseResponse } from '../sse.js'
import { loadApp } from './apps.js'

/** More than this and the browser is the bottleneck, not the server. */
const MAX_TAIL = 5000

const query = z.object({
  tail: z.coerce.number().int().positive().max(MAX_TAIL).catch(MAX_TAIL).default(200),
  follow: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default('true'),
})

export async function logRoutes(app: FastifyInstance): Promise<void> {
  const { db, host } = app.deps

  app.get('/api/apps/:id/containers/:containerId/logs', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id, containerId } = z
      .object({ id: z.string(), containerId: z.string() })
      .parse(request.params)
    const options = query.parse(request.query)

    const row = await loadApp(db, ctx, id)
    if (!row) return reply.code(404).send({ error: 'not_found' })

    // The container must belong to THIS app. Without this the id is a free handle to any
    // container on the host, including one from an app the caller is scoped out of.
    const containers = await host.listContainers({ project: row.projectName ?? '' })
    if (!containers.some((container) => container.id === containerId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const sse = sseResponse(request, reply)
    let disconnected = false
    void sse.closed.then(() => {
      disconnected = true
    })

    try {
      for await (const line of host.streamLogs({
        containerId,
        tail: options.tail,
        follow: options.follow,
      })) {
        if (disconnected) break
        sse.send('line', line)
      }
    } catch (error) {
      // The stream can die mid-flight when the container is removed. Say so on the
      // stream rather than throwing, which at this point would produce a torn response
      // the error handler cannot turn into JSON.
      sse.send('error', { message: error instanceof Error ? error.message : 'log stream ended' })
    }

    sse.send('done', {})
    sse.close()
    // Hijacked — nothing to return.
  })
}
```

- [ ] **Step 4: Register it**

In `src/server/app.ts`, `await app.register(logRoutes)` after `jobRoutes`, before `spaRoutes`.

- [ ] **Step 5: Run and commit**

```bash
pnpm exec vitest run src/server/routes/logs.test.ts && pnpm test && pnpm exec tsc --noEmit
git add src/server/routes/logs.ts src/server/routes/logs.test.ts src/server/app.ts
git commit -m "Stream container logs over SSE, scoped to the owning app"
```

---

### Task 7: Container detail panel

**Files:**
- Create: `src/server/routes/containers.ts`, `src/server/routes/containers.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Consumes: `Host.listContainers`, `Host.inspectContainer` (typed in Task 3), `loadApp`.
- Produces: `GET /api/apps/:id/containers`, `GET /api/apps/:id/containers/:containerId`.

Spec §4: read-only, replacing the rejected web terminal — resolved image and digest, env vars
(masked), mounts, ports, networks, restart policy, exit code and OOM flag, health-check history.
It has to work on distroless images, which is exactly why it is inspect-based and not a shell.

Masking already happened at the Host boundary in Task 3, so this route is a projection and a
scope check. Requires `app:config`.

- [ ] **Step 1: Write the failing test**

`src/server/routes/containers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp, createViewer, signUpAdmin } from '@server/test-helpers'

const CONFIG = JSON.stringify({ name: 'jellyfin', services: { web: { image: 'nginx' } } })

const INSPECT = {
  id: 'container-1',
  name: 'jellyfin-web-1',
  image: 'nginx:alpine',
  imageDigest: 'sha256:abc',
  state: 'exited',
  exitCode: 137,
  oomKilled: true,
  startedAt: '2026-09-10T00:00:00Z',
  finishedAt: '2026-09-10T01:00:00Z',
  restartPolicy: 'unless-stopped',
  restartCount: 3,
  tty: false,
  env: [{ key: 'DB_PASSWORD', masked: '••••••••' }],
  mounts: [{ source: '/volume2/media', destination: '/media', mode: 'ro', type: 'bind' }],
  ports: [{ container: 80, host: 8099, protocol: 'tcp' }],
  networks: ['jellyfin_default'],
  health: { status: 'unhealthy', failingStreak: 3, log: [{ exitCode: 1, output: 'curl: (7)', end: '2026-09-10T01:00:00Z' }] },
}

async function withApp() {
  const app = await buildTestApp()
  const { cookie } = await signUpAdmin(app)
  app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  app.deps.host.composeResults.set('config --format json', { exitCode: 0, stdout: CONFIG, stderr: '' })
  app.deps.host.containers = [{
    id: 'container-1', names: ['jellyfin-web-1'], image: 'nginx', state: 'exited',
    status: 'Exited (137)', project: 'jellyfin', service: 'web', labels: {},
  }]
  app.deps.host.inspected.set('container-1', INSPECT)
  const adopted = await app.inject({
    method: 'POST', url: '/api/apps/adopt', headers: { cookie },
    payload: { directories: ['jellyfin'] },
  })
  return { app, cookie, id: adopted.json().adopted[0].id as string }
}

describe('container detail', () => {
  it('lists the app\'s containers', async () => {
    const { app, cookie, id } = await withApp()
    const res = await app.inject({ method: 'GET', url: `/api/apps/${id}/containers`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0]).toMatchObject({ id: 'container-1', service: 'web', state: 'exited' })
    await app.close()
  })

  it('returns the diagnostics the panel exists for', async () => {
    const { app, cookie, id } = await withApp()
    const res = await app.inject({
      method: 'GET', url: `/api/apps/${id}/containers/container-1`, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    // The reason the web terminal was cut: these answer "why did it die" without a shell,
    // and work on a distroless image that has none.
    expect(res.json()).toMatchObject({
      exitCode: 137, oomKilled: true, restartCount: 3, restartPolicy: 'unless-stopped',
    })
    expect(res.json().health.status).toBe('unhealthy')
    await app.close()
  })

  it('never returns an env value', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.inspected.set('container-1', {
      ...INSPECT, env: [{ key: 'DB_PASSWORD', masked: '••••••••' }],
    })
    const res = await app.inject({
      method: 'GET', url: `/api/apps/${id}/containers/container-1`, headers: { cookie },
    })
    expect(res.body).not.toContain('hunter2')
    expect(res.json().env).toEqual([{ key: 'DB_PASSWORD', masked: '••••••••' }])
    await app.close()
  })

  it('refuses a container belonging to another app', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.host.containers.push({
      id: 'other-1', names: ['paperless-web-1'], image: 'x', state: 'running',
      status: 'Up', project: 'paperless', service: 'web', labels: {},
    })
    app.deps.host.inspected.set('other-1', { ...INSPECT, id: 'other-1' })
    const res = await app.inject({
      method: 'GET', url: `/api/apps/${id}/containers/other-1`, headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('refuses a viewer', async () => {
    const { app, cookie, id } = await withApp()
    const viewer = await createViewer(app, cookie)
    for (const url of [`/api/apps/${id}/containers`, `/api/apps/${id}/containers/container-1`]) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie: viewer.cookie } })).statusCode).toBe(403)
    }
    await app.close()
  })

  it('stays 200 with an empty list when Docker is unreachable', async () => {
    // Same rule as the app list: a wedged socket must not 500 the screen.
    const { app, cookie, id } = await withApp()
    app.deps.host.listContainers = async () => {
      throw new Error('connect ENOENT /var/run/docker.sock')
    }
    const res = await app.inject({ method: 'GET', url: `/api/apps/${id}/containers`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/routes/containers.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write `src/server/routes/containers.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireCapability } from '../auth/context.js'
import type { ContainerSummary } from '../host/types.js'
import { loadApp } from './apps.js'

export async function containerRoutes(app: FastifyInstance): Promise<void> {
  const { db, host } = app.deps

  /** The app's containers, or an empty list. Never a 500: a wedged socket must not take
   *  out the screen, which is the same rule the app list follows. */
  async function containersFor(projectName: string | null): Promise<ContainerSummary[]> {
    try {
      return await host.listContainers({ project: projectName ?? '' })
    } catch {
      return []
    }
  }

  app.get('/api/apps/:id/containers', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const row = await loadApp(db, ctx, id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    return containersFor(row.projectName)
  })

  app.get('/api/apps/:id/containers/:containerId', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id, containerId } = z
      .object({ id: z.string(), containerId: z.string() })
      .parse(request.params)

    const row = await loadApp(db, ctx, id)
    if (!row) return reply.code(404).send({ error: 'not_found' })

    // Ownership, not just existence. A raw container id would otherwise reach any
    // container on the host, including one from an app this caller cannot see.
    const containers = await containersFor(row.projectName)
    if (!containers.some((container) => container.id === containerId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    try {
      return await host.inspectContainer(containerId)
    } catch (error) {
      // Removed between the list and the inspect. 404 is the honest answer.
      return reply.code(404).send({
        error: 'not_found',
        message: error instanceof Error ? error.message : 'container is gone',
      })
    }
  })
}
```

- [ ] **Step 4: Register, run, commit**

```bash
# app.ts: await app.register(containerRoutes) after logRoutes, before spaRoutes
pnpm exec vitest run src/server/routes/containers.test.ts && pnpm test && pnpm exec tsc --noEmit
git add src/server/routes/containers.ts src/server/routes/containers.test.ts src/server/app.ts
git commit -m "Add the read-only container detail panel"
```

---

### Task 8: Registry digest client

**Files:**
- Create: `src/server/apps/registry.ts`, `src/server/apps/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type ImageRef = { registry: string; repository: string; reference: string }
export function parseImageRef(image: string): ImageRef
export function createRegistryClient(deps: { fetch: typeof fetch }): {
  latestDigest(image: string): Promise<string | null>
}
```

Spec §4: "the `WWW-Authenticate` challenge → token → `HEAD` manifest flow, with `Accept` headers
covering multi-arch manifest lists — and compared against the local image's `RepoDigests`. This
detects updates without downloading layers."

`fetch` is injected so the tests never touch the network. A test that reaches Docker Hub is a
test that fails on a plane and rate-limits a shared IP.

- [ ] **Step 1: Write the failing test**

`src/server/apps/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createRegistryClient, parseImageRef } from '@server/apps/registry'

describe('parseImageRef', () => {
  it.each([
    ['nginx', 'registry-1.docker.io', 'library/nginx', 'latest'],
    ['nginx:alpine', 'registry-1.docker.io', 'library/nginx', 'alpine'],
    ['linuxserver/jellyfin:latest', 'registry-1.docker.io', 'linuxserver/jellyfin', 'latest'],
    ['ghcr.io/home-assistant/home-assistant:stable', 'ghcr.io', 'home-assistant/home-assistant', 'stable'],
    ['lscr.io/linuxserver/radarr', 'lscr.io', 'linuxserver/radarr', 'latest'],
    ['localhost:5000/mine:v1', 'localhost:5000', 'mine', 'v1'],
  ])('parses %s', (input, registry, repository, reference) => {
    expect(parseImageRef(input)).toEqual({ registry, repository, reference })
  })

  it('keeps a digest reference as the reference', () => {
    expect(parseImageRef('nginx@sha256:abc')).toEqual({
      registry: 'registry-1.docker.io', repository: 'library/nginx', reference: 'sha256:abc',
    })
  })

  it('does not mistake a port for a repository separator', () => {
    // `localhost:5000/mine` has a colon in the host, not a tag. Splitting on the last
    // colon without checking for a slash after it gets this wrong.
    expect(parseImageRef('localhost:5000/mine').reference).toBe('latest')
  })
})

describe('registry client', () => {
  const manifestDigest = 'sha256:deadbeef'

  function fakeFetch(script: Array<{ status: number; headers: Record<string, string>; body?: unknown }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const impl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const next = script.shift()
      if (!next) throw new Error('unexpected extra fetch')
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers,
      })
    }
    return { impl: impl as unknown as typeof fetch, calls }
  }

  it('follows the challenge, fetches a token, and returns the digest', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
        },
      },
      { status: 200, headers: {}, body: { token: 'tok-123' } },
      { status: 200, headers: { 'docker-content-digest': manifestDigest } },
    ])
    const client = createRegistryClient({ fetch: impl })
    expect(await client.latestDigest('nginx:alpine')).toBe(manifestDigest)

    expect(calls[0]?.url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/alpine')
    expect(calls[1]?.url).toContain('https://auth.docker.io/token?')
    expect(calls[1]?.url).toContain('scope=repository%3Alibrary%2Fnginx%3Apull')
    expect((calls[2]?.init?.headers as Record<string, string>)?.authorization).toBe('Bearer tok-123')
    // Manifest lists AND single manifests, or a multi-arch image returns 404.
    const accept = (calls[2]?.init?.headers as Record<string, string>)?.accept ?? ''
    expect(accept).toContain('application/vnd.docker.distribution.manifest.list.v2+json')
    expect(accept).toContain('application/vnd.oci.image.index.v1+json')
    expect(calls[2]?.init?.method).toBe('HEAD')
  })

  it('uses the digest directly when the registry needs no auth', async () => {
    const { impl } = fakeFetch([{ status: 200, headers: { 'docker-content-digest': manifestDigest } }])
    expect(await createRegistryClient({ fetch: impl }).latestDigest('localhost:5000/mine:v1')).toBe(manifestDigest)
  })

  it('returns null rather than throwing when the manifest is missing', async () => {
    const { impl } = fakeFetch([{ status: 404, headers: {} }])
    expect(await createRegistryClient({ fetch: impl }).latestDigest('nginx:nope')).toBeNull()
  })

  it('returns null when the registry answers without a digest header', async () => {
    const { impl } = fakeFetch([{ status: 200, headers: {} }])
    expect(await createRegistryClient({ fetch: impl }).latestDigest('nginx')).toBeNull()
  })

  it('returns null when the network fails, rather than failing the whole check', async () => {
    const failing = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    expect(await createRegistryClient({ fetch: failing }).latestDigest('nginx')).toBeNull()
  })

  it('gives up rather than looping when the token is rejected too', async () => {
    const { impl, calls } = fakeFetch([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example/token",service="s"' } },
      { status: 200, headers: {}, body: { token: 'tok' } },
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example/token",service="s"' } },
    ])
    expect(await createRegistryClient({ fetch: impl }).latestDigest('nginx')).toBeNull()
    expect(calls).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/apps/registry.test.ts`
Expected: FAIL — cannot find module `@server/apps/registry`.

- [ ] **Step 3: Write `src/server/apps/registry.ts`**

```ts
export type ImageRef = { registry: string; repository: string; reference: string }

const DEFAULT_REGISTRY = 'registry-1.docker.io'

/**
 * Every media type a manifest endpoint might answer with.
 *
 * Without the list and index types a multi-arch image — which is most of them — returns
 * 404 or the wrong digest, because the registry falls back to whatever single manifest it
 * thinks the client can read.
 */
const ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ')

/**
 * Splits an image reference into registry, repository and tag-or-digest.
 *
 * The first segment is a registry only if it looks like a host — it contains a dot or a
 * colon, or is exactly `localhost`. Otherwise `linuxserver/jellyfin` would parse as the
 * registry `linuxserver`. A single-segment name gets Docker Hub's implicit `library/`.
 */
export function parseImageRef(image: string): ImageRef {
  let rest = image
  let registry = DEFAULT_REGISTRY

  const slash = rest.indexOf('/')
  if (slash !== -1) {
    const head = rest.slice(0, slash)
    if (head === 'localhost' || head.includes('.') || head.includes(':')) {
      registry = head
      rest = rest.slice(slash + 1)
    }
  }

  let reference = 'latest'
  const at = rest.indexOf('@')
  if (at !== -1) {
    reference = rest.slice(at + 1)
    rest = rest.slice(0, at)
  } else {
    const colon = rest.lastIndexOf(':')
    // A colon before a slash is a port on the host, not a tag — but the host has already
    // been stripped above, so any remaining colon after the last slash is a tag.
    if (colon !== -1 && colon > rest.lastIndexOf('/')) {
      reference = rest.slice(colon + 1)
      rest = rest.slice(0, colon)
    }
  }

  const repository = registry === DEFAULT_REGISTRY && !rest.includes('/') ? `library/${rest}` : rest
  return { registry, repository, reference }
}

/** Parses `Bearer realm="…",service="…",scope="…"` into its parts. */
function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of header.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) {
    const [, key, value] = match
    if (key !== undefined && value !== undefined) out[key.toLowerCase()] = value
  }
  return out
}

export function createRegistryClient(deps: { fetch: typeof fetch }) {
  /**
   * The digest the registry currently serves for a tag, or `null`.
   *
   * `null` for every failure — a missing tag, a private registry, no network, a rate
   * limit. This runs daily across every service of every app, and one unreachable
   * registry must not fail the others or surface as an error the user has to dismiss.
   */
  async function latestDigest(image: string): Promise<string | null> {
    try {
      const ref = parseImageRef(image)
      const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${ref.reference}`
      const headers: Record<string, string> = { accept: ACCEPT }

      let response = await deps.fetch(url, { method: 'HEAD', headers })

      if (response.status === 401) {
        const challenge = parseChallenge(response.headers.get('www-authenticate') ?? '')
        if (!challenge.realm) return null

        const tokenUrl = new URL(challenge.realm)
        if (challenge.service) tokenUrl.searchParams.set('service', challenge.service)
        tokenUrl.searchParams.set(
          'scope',
          challenge.scope ?? `repository:${ref.repository}:pull`,
        )

        const tokenResponse = await deps.fetch(tokenUrl.toString(), { method: 'GET' })
        if (!tokenResponse.ok) return null
        const body = (await tokenResponse.json()) as { token?: string; access_token?: string }
        const token = body.token ?? body.access_token
        if (!token) return null

        headers.authorization = `Bearer ${token}`
        // Exactly one retry. A registry that rejects its own token will keep doing so,
        // and a loop here would hammer it once per service per app.
        response = await deps.fetch(url, { method: 'HEAD', headers })
      }

      if (!response.ok) return null
      return response.headers.get('docker-content-digest')
    } catch {
      return null
    }
  }

  return { latestDigest }
}
```

- [ ] **Step 4: Run and commit**

```bash
pnpm exec vitest run src/server/apps/registry.test.ts && pnpm test && pnpm exec tsc --noEmit
git add src/server/apps/registry.ts src/server/apps/registry.test.ts
git commit -m "Query registry manifest digests without downloading layers"
```

---

### Task 9: Image update detection and its API

**Files:**
- Create: `src/server/apps/image-updates.ts`, `src/server/apps/image-updates.test.ts`, `src/server/routes/images.ts`, `src/server/routes/images.test.ts`
- Modify: `src/server/app.ts`, `src/server/index.ts`, `src/server/test-helpers.ts`

**Interfaces:**
- Consumes: `createRegistryClient`, `ComposeConfigCache`, `Host.inspectImage`, `loadApp`.
- Produces:

```ts
export class ImageUpdateChecker {
  constructor(deps: {
    db: Db
    host: Host
    composeConfig: ComposeConfigCache
    registry: { latestDigest(image: string): Promise<string | null> }
  })
  /** Checks every service of one app and writes `image_status`. Never throws. */
  check(app: AppRow): Promise<void>
}
```

Routes: `GET /api/apps/:id/images` reads the stored rows; `POST /api/apps/:id/images/check` runs
a check now. Both require `app:config`.

The daily schedule belongs to 1C, which owns the scheduler. This task provides the unit it will
call, plus the manual trigger, so 1C wires rather than writes.

- [ ] **Step 1: Write the failing test**

`src/server/apps/image-updates.test.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { ComposeConfigCache } from '@server/apps/compose-config'
import { ImageUpdateChecker } from '@server/apps/image-updates'
import { createDb, runMigrations } from '@server/db/client'
import { apps, hosts, imageStatus } from '@server/db/schema'
import { FakeHost } from '@server/test-helpers'

const CONFIG = JSON.stringify({
  name: 'jellyfin',
  services: { web: { image: 'nginx:alpine' }, db: { image: 'postgres:16' } },
})

async function seed() {
  const { db } = await createDb(':memory:')
  await runMigrations(db)
  await db.insert(hosts).values({ id: 'local', name: 'l', composeRoot: '/v', dockerSocket: '/s' })
  const row = {
    id: ulid(), hostId: 'local', slug: 'jellyfin', displayName: 'J',
    directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
  }
  await db.insert(apps).values(row)
  const [app] = await db.select().from(apps).where(eq(apps.id, row.id))
  if (!app) throw new Error('seed failed')

  const host = new FakeHost()
  host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  host.composeResults.set('config --format json', { exitCode: 0, stdout: CONFIG, stderr: '' })
  return { db, host, app }
}

describe('ImageUpdateChecker', () => {
  it('flags a service whose registry digest differs from the local one', async () => {
    const { db, host, app } = await seed()
    host.images.set('nginx:alpine', { id: 'sha256:local', repoDigests: ['nginx@sha256:old'] })
    host.images.set('postgres:16', { id: 'sha256:local2', repoDigests: ['postgres@sha256:same'] })
    const checker = new ImageUpdateChecker({
      db, host, composeConfig: new ComposeConfigCache(host),
      registry: {
        latestDigest: async (image) =>
          image === 'nginx:alpine' ? 'sha256:new' : 'sha256:same',
      },
    })

    await checker.check(app)
    const rows = await db.select().from(imageStatus).where(eq(imageStatus.appId, app.id))
    expect(rows).toHaveLength(2)
    const web = rows.find((r) => r.serviceName === 'web')
    expect(web).toMatchObject({ currentDigest: 'sha256:old', latestDigest: 'sha256:new', updateAvailable: true })
    expect(rows.find((r) => r.serviceName === 'db')?.updateAvailable).toBe(false)
  })

  it('does not claim an update when the registry cannot be reached', async () => {
    // A null digest means "unknown", and reporting unknown as "update available" would
    // train the user to ignore the badge.
    const { db, host, app } = await seed()
    host.images.set('nginx:alpine', { id: 'x', repoDigests: ['nginx@sha256:old'] })
    const checker = new ImageUpdateChecker({
      db, host, composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => null },
    })
    await checker.check(app)
    const [web] = await db.select().from(imageStatus)
      .where(and(eq(imageStatus.appId, app.id), eq(imageStatus.serviceName, 'web')))
    expect(web?.updateAvailable).toBe(false)
    expect(web?.latestDigest).toBeNull()
    expect(web?.checkedAt).toBeGreaterThan(0)
  })

  it('does not claim an update when the image was never pulled', async () => {
    const { db, host, app } = await seed()
    const checker = new ImageUpdateChecker({
      db, host, composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => 'sha256:new' },
    })
    await checker.check(app)
    const [web] = await db.select().from(imageStatus)
      .where(and(eq(imageStatus.appId, app.id), eq(imageStatus.serviceName, 'web')))
    expect(web?.currentDigest).toBeNull()
    expect(web?.updateAvailable).toBe(false)
  })

  it('re-running replaces rather than duplicating', async () => {
    const { db, host, app } = await seed()
    host.images.set('nginx:alpine', { id: 'x', repoDigests: ['nginx@sha256:old'] })
    const checker = new ImageUpdateChecker({
      db, host, composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => 'sha256:new' },
    })
    await checker.check(app)
    await checker.check(app)
    expect(await db.select().from(imageStatus).where(eq(imageStatus.appId, app.id))).toHaveLength(2)
  })

  it('does nothing and does not throw when the compose file will not resolve', async () => {
    const { db, host, app } = await seed()
    host.composeResults.set('config --format json', { exitCode: 1, stdout: '', stderr: 'bad' })
    const checker = new ImageUpdateChecker({
      db, host, composeConfig: new ComposeConfigCache(host),
      registry: { latestDigest: async () => 'sha256:new' },
    })
    await expect(checker.check(app)).resolves.toBeUndefined()
    expect(await db.select().from(imageStatus)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/apps/image-updates.test.ts`
Expected: FAIL — cannot find module `@server/apps/image-updates`.

- [ ] **Step 3: Write `src/server/apps/image-updates.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { apps, imageStatus } from '../db/schema.js'
import type { Host } from '../host/types.js'
import type { ComposeConfigCache } from './compose-config.js'

export type AppRow = typeof apps.$inferSelect

export class ImageUpdateChecker {
  constructor(
    private readonly deps: {
      db: Db
      host: Host
      composeConfig: ComposeConfigCache
      registry: { latestDigest(image: string): Promise<string | null> }
    },
  ) {}

  /**
   * Compares each service's local image digest against the registry's.
   *
   * Never throws. This runs across every app on a schedule, and one unresolvable compose
   * file or one unreachable registry must not stop the rest.
   */
  async check(app: AppRow): Promise<void> {
    const resolved = await this.deps.composeConfig.resolve({
      directory: app.directory,
      composeFile: app.composeFile,
    })
    if (!resolved.valid) return

    const checkedAt = Math.floor(Date.now() / 1000)

    for (const service of resolved.resolved.services) {
      if (!service.image) continue

      const local = await this.deps.host.inspectImage(service.image)
      // `RepoDigests` entries look like `nginx@sha256:…`; the digest is what compares.
      const currentDigest = local?.repoDigests[0]?.split('@')[1] ?? null
      const latestDigest = await this.deps.registry.latestDigest(service.image)

      // Both must be known. A null latest means the registry could not be reached, and
      // reporting unknown as "update available" trains the user to ignore the badge.
      const updateAvailable =
        currentDigest !== null && latestDigest !== null && currentDigest !== latestDigest

      const row = {
        appId: app.id,
        serviceName: service.name,
        currentDigest,
        latestDigest,
        updateAvailable,
        checkedAt,
      }

      await this.deps.db
        .insert(imageStatus)
        .values(row)
        .onConflictDoUpdate({
          target: [imageStatus.appId, imageStatus.serviceName],
          set: row,
        })
    }
  }
}
```

- [ ] **Step 4: Write `src/server/routes/images.ts`**

```ts
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireCapability } from '../auth/context.js'
import { imageStatus } from '../db/schema.js'
import { loadApp } from './apps.js'

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  const { db, images } = app.deps

  app.get('/api/apps/:id/images', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const row = await loadApp(db, ctx, id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    return db.select().from(imageStatus).where(eq(imageStatus.appId, id))
  })

  app.post('/api/apps/:id/images/check', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const row = await loadApp(db, ctx, id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    await images.check(row)
    return db.select().from(imageStatus).where(eq(imageStatus.appId, id))
  })
}
```

- [ ] **Step 5: Write `src/server/routes/images.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp, createViewer, signUpAdmin } from '@server/test-helpers'

const CONFIG = JSON.stringify({ name: 'jellyfin', services: { web: { image: 'nginx:alpine' } } })

async function withApp() {
  const app = await buildTestApp()
  const { cookie } = await signUpAdmin(app)
  app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  app.deps.host.composeResults.set('config --format json', { exitCode: 0, stdout: CONFIG, stderr: '' })
  app.deps.host.images.set('nginx:alpine', { id: 'x', repoDigests: ['nginx@sha256:old'] })
  const adopted = await app.inject({
    method: 'POST', url: '/api/apps/adopt', headers: { cookie },
    payload: { directories: ['jellyfin'] },
  })
  return { app, cookie, id: adopted.json().adopted[0].id as string }
}

describe('image update API', () => {
  it('is empty until a check has run', async () => {
    const { app, cookie, id } = await withApp()
    const res = await app.inject({ method: 'GET', url: `/api/apps/${id}/images`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.close()
  })

  it('reports an available update after a check', async () => {
    const { app, cookie, id } = await withApp()
    app.deps.registryDigests.set('nginx:alpine', 'sha256:new')
    const res = await app.inject({ method: 'POST', url: `/api/apps/${id}/images/check`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()[0]).toMatchObject({
      serviceName: 'web', currentDigest: 'sha256:old', latestDigest: 'sha256:new', updateAvailable: true,
    })
    await app.close()
  })

  it('refuses a viewer', async () => {
    const { app, cookie, id } = await withApp()
    const viewer = await createViewer(app, cookie)
    for (const [method, url] of [
      ['GET', `/api/apps/${id}/images`],
      ['POST', `/api/apps/${id}/images/check`],
    ] as const) {
      expect((await app.inject({ method, url, headers: { cookie: viewer.cookie } })).statusCode).toBe(403)
    }
    await app.close()
  })
})
```

`buildTestApp` gains a `registryDigests` map wired into a fake registry client:

```ts
// in test-helpers.ts
const registryDigests = new Map<string, string>()
const images = new ImageUpdateChecker({
  db, host, composeConfig,
  registry: { latestDigest: async (image) => registryDigests.get(image) ?? null },
})
// expose `registryDigests` on the returned app's deps for tests to script
```

- [ ] **Step 6: Wire and run**

`AppDeps` gains `images: ImageUpdateChecker`. In `src/server/index.ts` build it with the real
client: `createRegistryClient({ fetch })`. Register `imageRoutes` after `containerRoutes`, before
`spaRoutes`.

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm exec biome check .`

- [ ] **Step 7: Commit**

```bash
git add src/server/apps/image-updates.ts src/server/apps/image-updates.test.ts src/server/routes/images.ts src/server/routes/images.test.ts src/server/app.ts src/server/index.ts src/server/test-helpers.ts
git commit -m "Detect available image updates from registry digests"
```

---

## Self-Review

**Spec coverage for 1B-ii's slice:**

| Spec requirement | Task |
|---|---|
| `Host.runCompose` returns `JobHandle` (§4) | 1 |
| Actions become `jobs` rows; argument array, never a shell string (§4) | 1, 4, 5 |
| Per-app mutex prevents `pull` and `down` racing (§4) | 4 |
| Output streams over SSE and is persisted to the job record (§3, §4) | 4, 5 |
| `jobs.output` truncated to a cap (§3) | 4 |
| `graceUntil` set after a lifecycle job (§4) | 4 |
| Logs: Engine API with `follow`, bounded ring buffer, drop-oldest (§4) | 1, 3, 6 |
| Logs demultiplexed using `Config.Tty` and the 8-byte header (§4) | 2, 3 |
| Container detail: image, digest, masked env, mounts, ports, networks, restart policy, exit code, OOM, health history (§4) | 3, 7 |
| Image updates via `WWW-Authenticate` → token → `HEAD`, multi-arch `Accept`, compared to `RepoDigests` (§4) | 8, 9 |
| SSE filtered by the same scope predicate the REST queries use (§5) | 5, 6 |

**Carry-forward items closed:** `runCompose`'s `JobHandle` signature (Task 1), `FakeHost`'s
single-chunk output (Task 1), `runCompose`'s missing `-p`/`env` — **not** closed; see below.

**Deliberately deferred:**

- **The daily schedule for image checks** is 1C's, which owns the scheduler. Task 9 provides
  `ImageUpdateChecker.check(app)` and a manual trigger so 1C wires rather than writes.
- **`runCompose` still passes no `-p`.** The project name comes from the compose file and its
  `.env`, which is what the CLI would use anyway; passing `-p` explicitly only matters once
  something can override it, which nothing here does. Reassess in 1C when the scheduler starts
  acting on apps without a request behind it.
- **`statusFor` is still inside the `appRoutes` closure.** 1C needs it; extracting it there,
  where the second consumer actually appears, beats guessing its shape now.
- **`include:` / `extends:` targets remain outside the config cache hash.** Unchanged from 1B-i.
- **No UI.** Every endpoint here is consumed by 1D.

**Type consistency check:** `JobChunk` is defined in Task 1 and used in Tasks 4 and 5. `LogLine`
is defined in Task 3 and used in Task 6. `ContainerInspect` is defined in Task 3 and returned by
Task 7. `AppRow` is `typeof apps.$inferSelect` in both Task 4 and Task 9. `loadApp(db, ctx, id)`
is extracted in Task 5 and used by Tasks 5, 6, 7 and 9 — Tasks 6, 7 and 9 all depend on Task 5
having exported it, which is why Task 5 precedes them.
