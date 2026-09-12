# Homestead Phase 1H — Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Homestead in a container that runs on the NAS, shuts down cleanly, and repairs the jobs a crash left behind — the last thing between Phase 1 and its milestone of managing every NAS stack from a phone.

**Architecture:** A four-stage Docker build on `node:24-alpine`. `tsup` externalises every dependency, so `node_modules` ships with the bundle and the production install must run *inside* the Alpine stage — that is what makes the libSQL native binding resolve to its musl variant rather than the glibc one on the build host. Four runtime paths are relative to `process.cwd()` (the database, the icon cache, the migrations folder, the SPA static root), so `WORKDIR` and the copied directories have to agree or the defaults silently point at nothing. On top of the image: a SIGTERM handler that stops work in a specific order, a startup sweep that repairs jobs stranded by a crash, and an `isSystem` guard so Homestead cannot stop itself out of existence.

**Tech Stack:** Docker multi-stage build, `node:24-alpine`, `docker-cli` + `docker-cli-compose` from apk, pnpm, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — section 10 is this plan's authority.

**Recon:** `docs/superpowers/plans/1h-recon.md`. **Read it before Task 1.** It is accurate and carries `file:line` for every claim. Two things it settled shrink this phase and must not be re-done:

- `runMountPreflight` (`src/server/host/preflight.ts:37-145`) **already performs the full container round-trip** spec §10 describes — writes a marker, launches a container binding the compose root, reads the marker back through the daemon. It needs no work.
- `PathGuard` (`src/server/host/paths.ts:20-25`) **already accepts membership under either the configured root or its container-resolved realpath**. It needs no work.

**Carry-forward:** `docs/superpowers/plans/2026-09-12-homestead-1g-carry-forward.md` names this phase as next and lists the two items that belong to it.

## Global Constraints

- **Runtime image must include the Docker CLI and the Compose plugin.** Mutations shell out: `src/server/host/local-host.ts:508` spawns `docker compose -f <path> …`. `dockerode` speaks to the socket over HTTP and is pure JS, but it does not replace the CLI.
- **The compose root is bind-mounted at the identical absolute path inside the container as on the host.** Spec §10's path-identity constraint. The daemon resolves a stack's relative bind mounts against the *host* filesystem, and a bind source that does not exist on the host is not an error — Docker creates an empty directory and proceeds. The failure is silent and looks exactly like data loss.
- **Compose root default: `/volume2/docker`.** Socket default: `/var/run/docker.sock`. Port default: `3000`. All three from `src/server/config.ts:11-15`.
- **Add no npm dependencies.** Do not run `pnpm add`. Alpine packages via `apk add` inside the Dockerfile are expected and are not npm dependencies.
- **Do not modify `runMountPreflight` or `PathGuard`.**
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, and Biome clean **by exit code**, never piped to `tail`:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- **Docker 29.8.0 is available in this environment.** Tasks 5 and 6 must actually build the image and actually start the container. A Dockerfile that has only been written has not been tested.
- `.tsx` test files need `// @vitest-environment jsdom` as line 1; `src/web/test-environment.test.ts` enforces it. This phase is server-side and should need none.

## Two rulings already made

State these rather than rediscovering them.

**1. A swept job becomes `failed`, not a new status value.** The status union is `"queued" | "running" | "succeeded" | "failed"` (`src/shared/admin.ts:38`, `src/server/db/schema.ts:214-231`) and is consumed across the server, the shared DTOs and the web client. Adding `"crashed"` means touching every consumer and every exhaustive switch, to distinguish a case the user reads as "it didn't work" either way. The distinction lives in the `output` text instead.

**2. The `isSystem` lifecycle guard blocks every job kind, not a chosen subset.** `up`, `down`, `restart` and `pull` all return 409 `system_app` for a system app, matching the shape of the existing delete guard at `src/server/routes/apps.ts:599-600`. The cost, stated plainly: an admin cannot restart Homestead from Homestead's own UI and must do it from the NAS. That is the correct trade — a `down` on yourself is unrecoverable from the UI that issued it, and a `restart` kills the process mid-response.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/server/apps/sweep.ts` | `sweepStrandedJobs` — repairs `running`/`queued` rows at startup |
| `src/server/apps/sweep.test.ts` | Its tests |
| `src/server/shutdown.ts` | `createShutdown` — the ordered, idempotent, time-bounded shutdown sequence |
| `src/server/shutdown.test.ts` | Its tests |
| `Dockerfile` | Four-stage build |
| `.dockerignore` | Keeps the build context small and `node_modules` out of it |
| `compose.example.yaml` | The deployment compose file, honouring path identity |
| `docs/deployment.md` | How to deploy, and what each mount is for |

**Modify:**

| File | Change |
|---|---|
| `src/server/apps/job-runner.ts` | Add `shutdown()` — cancels in-flight children so they land as `failed` rows rather than stranded ones |
| `src/server/apps/job-runner.test.ts` | Its tests |
| `src/server/routes/jobs.ts:30-31` | The `isSystem` lifecycle guard |
| `src/server/routes/jobs.test.ts` | Its test |
| `src/server/index.ts` | Thread the libSQL `client` handle out of `createDb`; call the sweep; install the signal handlers |

---

### Task 1: Startup sweep of stranded jobs

Carried since Phase 1B-ii. `JobRunner.finish` (`job-runner.ts:117-134`) is the only writer of a terminal status, and it only runs if the in-memory `running` Map survives — which a crash wipes. So a row sits at `status: "running"` with a null `finishedAt` forever, and `ActionBar` (`src/web/components/ActionBar.tsx:24-25`) treats the most recent row's `running` status as a live job. Every page load after a crash flashes a phantom running job before self-healing, and nothing ever repairs the row.

**Files:**
- Create: `src/server/apps/sweep.ts`
- Create: `src/server/apps/sweep.test.ts`
- Modify: `src/server/index.ts:32` (after `runMigrations`)

**Interfaces:**
- Consumes: `Db` from `src/server/db/client.ts:16`; the `jobs` table from `src/server/db/schema.ts:214-231`.
- Produces: `sweepStrandedJobs(db: Db, nowSeconds: number): Promise<number>` — returns the number of rows repaired.

- [ ] **Step 1: Write the failing tests**

Create `src/server/apps/sweep.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { apps, hosts, jobs } from "../db/schema.js";
import { sweepStrandedJobs } from "./sweep.js";

const NOW = 1_700_000_000;

async function seedApp(db: Db, id: string): Promise<void> {
  await db.insert(hosts).values({ id: "host-1", name: "local", kind: "local" }).onConflictDoNothing();
  await db.insert(apps).values({
    id,
    hostId: "host-1",
    name: id,
    slug: id,
    directory: id,
    composeFile: "compose.yaml",
  });
}

describe("sweepStrandedJobs", () => {
  let db: Db;

  beforeEach(async () => {
    ({ db } = await createDb(":memory:"));
    await runMigrations(db);
    await seedApp(db, "app-1");
  });

  it("marks a row stranded at running as failed, naming the interruption", async () => {
    await db.insert(jobs).values({
      id: "job-1",
      appId: "app-1",
      kind: "up",
      status: "running",
      startedAt: NOW - 60,
    });

    const repaired = await sweepStrandedJobs(db, NOW);

    expect(repaired).toBe(1);
    const [row] = await db.select().from(jobs);
    expect(row.status).toBe("failed");
    expect(row.finishedAt).toBe(NOW);
    expect(row.output).toContain("interrupted");
  });

  it("repairs a queued row too", async () => {
    await db.insert(jobs).values({ id: "job-2", appId: "app-1", kind: "pull", status: "queued" });

    expect(await sweepStrandedJobs(db, NOW)).toBe(1);
    const [row] = await db.select().from(jobs);
    expect(row.status).toBe("failed");
  });

  it("leaves a job that already finished completely alone", async () => {
    await db.insert(jobs).values({
      id: "job-3",
      appId: "app-1",
      kind: "up",
      status: "succeeded",
      startedAt: NOW - 120,
      finishedAt: NOW - 100,
      exitCode: 0,
      output: "done",
    });

    expect(await sweepStrandedJobs(db, NOW)).toBe(0);
    const [row] = await db.select().from(jobs);
    expect(row).toMatchObject({
      status: "succeeded",
      finishedAt: NOW - 100,
      exitCode: 0,
      output: "done",
    });
  });

  it("does not overwrite a failed job's own output with the sweep message", async () => {
    await db.insert(jobs).values({
      id: "job-4",
      appId: "app-1",
      kind: "up",
      status: "failed",
      finishedAt: NOW - 50,
      exitCode: 1,
      output: "service web failed to start",
    });

    await sweepStrandedJobs(db, NOW);
    const [row] = await db.select().from(jobs);
    expect(row.output).toBe("service web failed to start");
  });

  it("reports zero on a clean database rather than throwing", async () => {
    expect(await sweepStrandedJobs(db, NOW)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm exec vitest run src/server/apps/sweep.test.ts`
Expected: FAIL — `Failed to resolve import "./sweep.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/apps/sweep.ts`:

```ts
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";

/**
 * The message a swept job carries. `failed` rather than a new status value is deliberate:
 * the status union at `@shared/admin.ts` is consumed in many places and a user reads
 * "crashed" and "failed" the same way. The distinction lives here instead.
 */
const SWEPT_OUTPUT =
  "This job was interrupted: Homestead restarted while it was running. " +
  "The compose command may or may not have completed — check the app's containers.";

/**
 * Repairs jobs a crash left mid-flight.
 *
 * `JobRunner.finish` is the only writer of a terminal status and it runs off the in-memory
 * `running` Map, which does not survive a restart. Without this, a killed process leaves a
 * row at `running` with a null `finishedAt` forever, and `ActionBar` resumes from the most
 * recent row — so every page load after a crash shows a job that will never end.
 *
 * Runs once at startup, after migrations and before `listen`, when nothing can be running
 * yet by definition: this process has started no jobs, and Homestead is one process by
 * design (spec §2). Any `running` row it finds therefore belongs to a previous life.
 *
 * `exitCode` stays null on purpose. No process exited; inventing a code would put a number
 * in the UI that never came from anywhere.
 */
export async function sweepStrandedJobs(db: Db, nowSeconds: number): Promise<number> {
  const stranded = await db
    .update(jobs)
    .set({ status: "failed", finishedAt: nowSeconds, output: SWEPT_OUTPUT })
    .where(inArray(jobs.status, ["running", "queued"]))
    .returning({ id: jobs.id });

  return stranded.length;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run src/server/apps/sweep.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into startup**

In `src/server/index.ts`, immediately after line 32 (`await runMigrations(db);`), add:

```ts
// Before anything can start a new job. A `running` row at this point is from a previous
// life of this process — see `sweepStrandedJobs`.
const swept = await sweepStrandedJobs(db, Math.floor(Date.now() / 1000));
if (swept > 0) console.warn(`[startup] Marked ${swept} interrupted job(s) as failed.`);
```

and add the import alongside the other `./apps/*` imports at the top:

```ts
import { sweepStrandedJobs } from "./apps/sweep.js";
```

- [ ] **Step 6: Prove the binding**

The point of this task is the *route-level* consequence, not the row. Add to `src/server/apps/sweep.test.ts`:

```ts
it("leaves no job that a jobs listing would report as running", async () => {
  await db.insert(jobs).values([
    { id: "job-a", appId: "app-1", kind: "up", status: "running", startedAt: NOW - 10 },
    { id: "job-b", appId: "app-1", kind: "pull", status: "queued" },
  ]);

  await sweepStrandedJobs(db, NOW);

  const rows = await db.select().from(jobs);
  expect(rows.filter((r) => r.status === "running" || r.status === "queued")).toEqual([]);
});
```

Then break it: change the `where` clause to `inArray(jobs.status, ["queued"])` and run the file. Expect the `running` tests and this one to fail. Restore, confirm green, and **report the mutation and its result**.

- [ ] **Step 7: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add src/server/apps/sweep.ts src/server/apps/sweep.test.ts src/server/index.ts
git commit -m "Repair jobs a crash stranded at running, at startup

Carried since 1B-ii. JobRunner.finish writes terminal status off an
in-memory Map that a restart wipes, so a killed process leaves a row at
running forever and ActionBar resumes from it — a phantom job on every
page load, self-healing in the UI and never fixed in the database."
```

---

### Task 2: `JobRunner.shutdown()`

Task 1 is the crash net. This is the graceful path: when Homestead is asked to stop while a deploy is in flight, the child process should be cancelled and its row written as `failed` *now*, rather than left for the next boot's sweep.

**Ruling to state in the code:** cancel rather than wait. `JOB_TIMEOUT_MS` is 30 minutes (`job-runner.ts:20`) and Docker sends SIGKILL ten seconds after SIGTERM by default. Waiting for a `pull` to finish is not an option that exists; the honest choice is to cancel it and say so.

**Files:**
- Modify: `src/server/apps/job-runner.ts`
- Modify: `src/server/apps/job-runner.test.ts`

**Interfaces:**
- Consumes: the private `running` Map (`job-runner.ts:49`), `JobHandle.cancel()` and the `done` promise set at `job-runner.ts:113`.
- Produces: `JobRunner.shutdown(timeoutMs?: number): Promise<void>` — resolves when every in-flight job has written its terminal row, or when `timeoutMs` elapses, whichever comes first. Default 10000.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/apps/job-runner.test.ts`, following the existing describe structure and its helpers:

```ts
describe("shutdown", () => {
  it("cancels an in-flight job and lets it write its terminal row", async () => {
    const { runner, db, host, app } = await makeRunner();
    host.holdCompose = true; // the compose child does not exit on its own

    const job = await runner.start(app, "up", "user-1");
    const before = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(before[0].status).toBe("running");

    await runner.shutdown(2000);

    const after = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after[0].status).toBe("failed");
    expect(after[0].finishedAt).not.toBeNull();
  });

  it("frees the per-app slot, so nothing is left wedged", async () => {
    const { runner, host, app } = await makeRunner();
    host.holdCompose = true;

    await runner.start(app, "up", "user-1");
    await runner.shutdown(2000);

    // A second start would throw JobBusyError if the slot were still held.
    host.holdCompose = false;
    await expect(runner.start(app, "up", "user-1")).resolves.toBeDefined();
  });

  it("returns rather than hanging when a child ignores cancellation", async () => {
    const { runner, host, app } = await makeRunner();
    host.holdCompose = true;
    host.ignoreCancel = true;

    await runner.start(app, "up", "user-1");

    const started = Date.now();
    await runner.shutdown(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("resolves immediately when nothing is running", async () => {
    const { runner } = await makeRunner();
    await expect(runner.shutdown(2000)).resolves.toBeUndefined();
  });
});
```

`makeRunner` may not exist under that name. **Read the top of `src/server/apps/job-runner.test.ts` and reuse whatever setup the existing tests use**, rather than adding a second one. `holdCompose` and `ignoreCancel` are new affordances on the fake host used by that file — add them where that fake lives, as the smallest possible additions: `holdCompose` makes `runCompose`'s `result` promise stay pending, and `ignoreCancel` makes `cancel()` a no-op so the promise stays pending even after cancellation.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm exec vitest run src/server/apps/job-runner.test.ts`
Expected: FAIL — `runner.shutdown is not a function`.

- [ ] **Step 3: Implement `shutdown`**

Add to the `JobRunner` class in `src/server/apps/job-runner.ts`, after `cancel` (line 66):

```ts
  /**
   * Cancels every in-flight job and waits for each to write its terminal row.
   *
   * Cancelling rather than waiting is the only option that exists: `JOB_TIMEOUT_MS` is
   * thirty minutes and Docker SIGKILLs ten seconds after SIGTERM. A cancelled job lands as
   * `failed` through the normal `finish` path, which is the same place the startup sweep
   * would have put it — the difference is that this one happens while we can still write
   * it, so the next boot has nothing to repair.
   *
   * `timeoutMs` bounds the wait. A child that ignores SIGTERM must not be able to hold the
   * process open past the orchestrator's grace period; the row it leaves behind is the
   * sweep's problem on the next boot, which is exactly what the sweep is for.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    const inFlight = [...this.running.values()];
    if (inFlight.length === 0) return;

    for (const job of inFlight) job.handle.cancel();

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });

    try {
      await Promise.race([Promise.allSettled(inFlight.map((job) => job.done)), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run src/server/apps/job-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the binding**

Delete the `for (const job of inFlight) job.handle.cancel();` line and run the file. The first two tests must fail — without the cancel, `done` never settles and the timeout path leaves the row at `running`. Restore, confirm green, and **report the mutation and result**.

Then delete the `clearTimeout(timer)` in the `finally` and run the full suite with an eye on whether it still exits. If nothing catches a leaked timer, say so — a leaked `setTimeout` keeps the process alive past shutdown, which is precisely the bug this task exists to avoid, and a test that cannot see it is the failure pattern this project has named in five consecutive phases.

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add src/server/apps/job-runner.ts src/server/apps/job-runner.test.ts
git commit -m "Cancel in-flight jobs on shutdown so they write their own terminal rows

Waiting is not an option that exists: the job timeout is thirty minutes
and Docker SIGKILLs ten seconds after SIGTERM. A bounded wait means a
child that ignores cancellation leaves a row for the startup sweep
rather than holding the process open."
```

---

### Task 3: Graceful shutdown

`src/server/index.ts:108-114` describes the required order in a comment and implements none of it. The comment is the specification, written by the phase that measured it:

> stop `scheduler` and `retention` first so no new work starts, then `events.closeAll()` so every open `/api/events` stream ends — **`app.close()` measurably does not resolve while one is still open** — and only then `app.close()` itself.

Task 2 adds one more step: jobs cancel after the timers stop and before the streams close, so a job's final output still reaches an attached client.

The libSQL client is closed last, and closing it at all requires a change first: `createDb` returns `{ client, db }` (`db/client.ts:13`) but `index.ts:31` destructures only `db`, so **the handle with `.close()` on it is discarded at the moment it is created.**

**Files:**
- Create: `src/server/shutdown.ts`
- Create: `src/server/shutdown.test.ts`
- Modify: `src/server/index.ts:31`, and the block at `108-119`

**Interfaces:**
- Consumes: `Scheduler.stop()` (`monitoring/scheduler.ts:81`), `RetentionTimer.stop()` (`monitoring/retention.ts:121`), `JobRunner.shutdown()` from Task 2, `EventBus.closeAll()` (`routes/events.ts:141`), Fastify's `app.close()`, and the libSQL client's `close()`.
- Produces:
  ```ts
  export type Closeable = {
    scheduler: { stop(): void };
    retention: { stop(): void };
    jobs: { shutdown(timeoutMs?: number): Promise<void> };
    events: { closeAll(): void };
    server: { close(): Promise<void> };
    db: { close(): void };
  };
  export function createShutdown(
    parts: Closeable,
    opts?: { timeoutMs?: number; onError?: (stage: string, error: unknown) => void },
  ): () => Promise<void>;
  ```
  The returned function is idempotent: a second call returns the first call's promise.

- [ ] **Step 1: Write the failing tests**

Create `src/server/shutdown.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { type Closeable, createShutdown } from "./shutdown.js";

function parts(overrides: Partial<Closeable> = {}): { parts: Closeable; order: string[] } {
  const order: string[] = [];
  const base: Closeable = {
    scheduler: { stop: () => void order.push("scheduler") },
    retention: { stop: () => void order.push("retention") },
    jobs: {
      shutdown: async () => {
        order.push("jobs");
      },
    },
    events: { closeAll: () => void order.push("events") },
    server: {
      close: async () => {
        order.push("server");
      },
    },
    db: { close: () => void order.push("db") },
    ...overrides,
  };
  return { parts: base, order };
}

describe("createShutdown", () => {
  it("stops the timers before it closes the server", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.indexOf("scheduler")).toBeLessThan(order.indexOf("server"));
    expect(order.indexOf("retention")).toBeLessThan(order.indexOf("server"));
  });

  it("ends the SSE streams before closing the server, which cannot close while one is open", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.indexOf("events")).toBeLessThan(order.indexOf("server"));
  });

  it("cancels jobs after the timers stop and before the streams close", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.indexOf("scheduler")).toBeLessThan(order.indexOf("jobs"));
    expect(order.indexOf("jobs")).toBeLessThan(order.indexOf("events"));
  });

  it("closes the database last", async () => {
    const { parts: p, order } = parts();
    await createShutdown(p)();

    expect(order.at(-1)).toBe("db");
  });

  it("runs once however many times it is called", async () => {
    const { parts: p, order } = parts();
    const shutdown = createShutdown(p);

    await Promise.all([shutdown(), shutdown(), shutdown()]);

    expect(order.filter((s) => s === "server")).toHaveLength(1);
    expect(order.filter((s) => s === "db")).toHaveLength(1);
  });

  it("still closes the database when the server refuses to close", async () => {
    const onError = vi.fn();
    const { parts: p, order } = parts({
      server: {
        close: async () => {
          throw new Error("still serving");
        },
      },
    });

    await createShutdown(p, { onError })();

    expect(order).toContain("db");
    expect(onError).toHaveBeenCalledWith("server", expect.any(Error));
  });

  it("still closes the database when a timer throws on the way down", async () => {
    const onError = vi.fn();
    const { parts: p, order } = parts({
      scheduler: {
        stop: () => {
          throw new Error("bad timer");
        },
      },
    });

    await createShutdown(p, { onError })();

    expect(order).toContain("db");
    expect(order).toContain("server");
    expect(onError).toHaveBeenCalledWith("scheduler", expect.any(Error));
  });

  it("gives up on a server that never closes, rather than hanging forever", async () => {
    const { parts: p, order } = parts({
      server: { close: () => new Promise<void>(() => {}) },
    });

    await createShutdown(p, { timeoutMs: 100 })();

    expect(order).toContain("db");
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm exec vitest run src/server/shutdown.test.ts`
Expected: FAIL — `Failed to resolve import "./shutdown.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/shutdown.ts`:

```ts
/**
 * The ordered, idempotent, time-bounded shutdown sequence.
 *
 * The order is not arbitrary and is not a preference — each step exists because of
 * something measured:
 *
 * 1. `scheduler` and `retention` stop first, so no new probe or prune starts against a
 *    database that is about to close.
 * 2. `jobs.shutdown()` cancels in-flight compose children while their output streams are
 *    still attached, so a user watching a deploy sees it end rather than go silent.
 * 3. `events.closeAll()` ends every open `/api/events` stream. This must precede
 *    `server.close()`: Fastify's close does not resolve while a stream is open, and
 *    1C's launcher streams stay open for as long as a tab is.
 * 4. `server.close()` drains in-flight requests.
 * 5. `db.close()` last, once nothing can still be reading.
 *
 * Every stage is individually guarded. A stage that throws must not strand the ones after
 * it — the database handle in particular gets closed even when the server refuses to.
 */
export type Closeable = {
  scheduler: { stop(): void };
  retention: { stop(): void };
  jobs: { shutdown(timeoutMs?: number): Promise<void> };
  events: { closeAll(): void };
  server: { close(): Promise<void> };
  db: { close(): void };
};

export type ShutdownOptions = {
  /**
   * The whole-sequence budget. Must stay under the orchestrator's grace period, or the
   * SIGKILL arrives mid-sequence and the careful ordering above buys nothing.
   * `compose.example.yaml` sets `stop_grace_period: 30s` against this default.
   */
  timeoutMs?: number;
  onError?: (stage: string, error: unknown) => void;
};

const DEFAULT_TIMEOUT_MS = 20_000;

export function createShutdown(parts: Closeable, opts: ShutdownOptions = {}): () => Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onError =
    opts.onError ?? ((stage: string, error: unknown) => console.error(`[shutdown] ${stage}:`, error));

  // A second SIGTERM — or a SIGINT chasing a SIGTERM — must join the running sequence, not
  // start a parallel one that closes the database out from under it.
  let inProgress: Promise<void> | undefined;

  async function stage(name: string, run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      onError(name, error);
    }
  }

  async function sequence(): Promise<void> {
    await stage("scheduler", () => parts.scheduler.stop());
    await stage("retention", () => parts.retention.stop());
    await stage("jobs", () => parts.jobs.shutdown());
    await stage("events", () => parts.events.closeAll());
    await stage("server", () => parts.server.close());
    await stage("db", () => parts.db.close());
  }

  return function shutdown(): Promise<void> {
    if (inProgress) return inProgress;

    // The budget covers the whole sequence. `db.close()` is reached either way: if the
    // budget expires the race resolves, and the abandoned sequence still gets there on its
    // own — but the process is no longer waiting on it.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        onError("timeout", new Error(`Shutdown exceeded ${timeoutMs}ms; exiting anyway.`));
        resolve();
      }, timeoutMs);
    });

    inProgress = Promise.race([sequence(), deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    return inProgress;
  };
}
```

**Note on the timeout test:** `it("gives up on a server that never closes…")` asserts `order` contains `db`, but under the race the sequence is abandoned at the `server` stage and never reaches `db`. **This test as written will fail against the implementation above, and that is a real disagreement you must resolve, not paper over.** Resolve it by deciding what the timeout means and making code and test agree:

- If the budget should still close the database, give `server.close()` its own inner timeout so the sequence always completes, and keep the outer budget as a backstop.
- If the budget means "stop waiting and let the orchestrator kill us", change the test to assert that the returned promise resolves within the budget and that `db` is *not* reached.

Pick one, implement it, and **say which you picked and why**. The first is better behaviour — an unflushed SQLite handle is worth avoiding — but it is more code, and a `file:` libSQL client with WAL is durable at every committed write regardless. Either answer is defensible; an untested timeout is not.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run src/server/shutdown.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Thread the database handle out of `createDb`**

In `src/server/index.ts`, change line 31 from:

```ts
const { db } = await createDb(config.dbPath);
```

to:

```ts
const { client: dbClient, db } = await createDb(config.dbPath);
```

`createDb` already returns it (`db/client.ts:13`) — this is the whole change. No signature moves.

- [ ] **Step 6: Install the handlers**

Replace the comment block at `src/server/index.ts:108-114` with:

```ts
const shutdown = createShutdown({
  scheduler,
  retention,
  jobs,
  events,
  server: { close: () => app.close() },
  db: { close: () => dbClient.close() },
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal} received.`);
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
```

Add the import with the other local imports at the top:

```ts
import { createShutdown } from "./shutdown.js";
```

Leave the `unhandledRejection` and `uncaughtException` handlers at `index.ts:120-126` exactly as they are. They are deliberate — a single-process appliance logs and keeps serving rather than vanishing — and they are not shutdown.

- [ ] **Step 7: Prove it end to end**

Unit tests cannot show that a real process exits. Start the built server and signal it:

```bash
pnpm build
mkdir -p /tmp/hs-shutdown-root
HOMESTEAD_SECRET_KEY=$(head -c32 /dev/urandom | base64) \
HOMESTEAD_BASE_URL=http://localhost:3000 \
HOMESTEAD_DB_PATH=/tmp/hs-shutdown/homestead.db \
HOMESTEAD_ICON_CACHE_DIR=/tmp/hs-shutdown/icons \
HOMESTEAD_COMPOSE_ROOT=/tmp/hs-shutdown-root \
HOMESTEAD_SKIP_MOUNT_PREFLIGHT=true \
node dist/server/index.js &
PID=$!
sleep 3
curl -sf http://localhost:3000/api/health && echo " health OK"
kill -TERM $PID
# The point: this must terminate on its own, promptly, with status 0.
time wait $PID; echo "exit status: $?"
```

Record the exit status and the elapsed time. Then run the same thing with the `for (const signal of …)` block commented out and record what happens.

**Corrected after measurement:** an earlier draft of this step predicted the handler-less process would hang, on the grounds that `scheduler`'s interval is deliberately ref'd (`scheduler.ts:74-79`). That is wrong, and the implementer who measured it was right to say so. A ref'd timer blocks Node's natural exit-when-idle; it does not block a signal. Without a handler, SIGTERM's OS-default disposition terminates the process immediately — measured at ~100 ms, exit 143.

So the contrast this step actually demonstrates is not hang-versus-exit. It is **exit 143 with no shutdown sequence run, versus exit 0 with the sequence run** — the database handle closed, the streams ended, in-flight jobs cancelled and written as terminal rows rather than left for the next boot's sweep. **Report both measurements and both exit codes.** Restore the block afterwards.

- [ ] **Step 8: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add src/server/shutdown.ts src/server/shutdown.test.ts src/server/index.ts
git commit -m "Shut down in the order index.ts has described since 1C

Timers first so no new work starts, then in-flight jobs while their
output streams are still attached, then the SSE streams — app.close()
measurably does not resolve while one is open — then the server, then
the database handle that createDb has been returning and index.ts has
been discarding since it was written."
```

---

### Task 4: `isSystem` protects the lifecycle, not only deletion

Spec §10: "Homestead is a normal container and can, once running, adopt and manage itself — with the same `isSystem` protection as `cloudflared`." Today that protection is one guard, on delete: `src/server/routes/apps.ts:599-600`. Nothing stops `POST /api/apps/:id/actions/down` on a system app, which for a self-adopted Homestead means stopping the process handling the request.

Apply **ruling 2** above: every job kind is blocked.

**Files:**
- Modify: `src/server/routes/jobs.ts` (after the `loadApp` at lines 30-31)
- Modify: `src/server/routes/jobs.test.ts`

**Interfaces:**
- Consumes: `loadApp` from `./apps.js` (already imported at `jobs.ts:10`); the `isSystem` column (`db/schema.ts:96`), already on the row `loadApp` returns.
- Produces: nothing new. `POST /api/apps/:id/actions/:kind` gains a 409 `{ error: "system_app" }` response, the same shape the delete guard already returns.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/routes/jobs.test.ts`. **Read the file first** and reuse its existing setup helpers and its way of creating an app; the snippet below names what to assert, not a second harness to build.

```ts
describe("system apps", () => {
  it("refuses every lifecycle action on a system app", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const id = await createApp(app, cookie, { name: "homestead" });
    await app.deps.db.update(apps).set({ isSystem: true }).where(eq(apps.id, id));

    for (const kind of ["up", "down", "restart", "pull"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/apps/${id}/actions/${kind}`,
        headers: { cookie },
      });
      expect(res.statusCode, `${kind} should be refused`).toBe(409);
      expect(res.json().error, `${kind} should say why`).toBe("system_app");
    }
  });

  it("still allows every lifecycle action on an ordinary app", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const id = await createApp(app, cookie, { name: "ordinary" });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
  });

  it("refuses before it starts anything", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const id = await createApp(app, cookie, { name: "homestead" });
    await app.deps.db.update(apps).set({ isSystem: true }).where(eq(apps.id, id));

    await app.inject({ method: "POST", url: `/api/apps/${id}/actions/down`, headers: { cookie } });

    // No job row, and nothing reached the host — a 409 that still ran the command would be
    // the worst of both.
    expect(await app.deps.db.select().from(jobs)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm exec vitest run src/server/routes/jobs.test.ts`
Expected: FAIL — actions on a system app currently return 202.

- [ ] **Step 3: Add the guard**

In `src/server/routes/jobs.ts`, directly after line 31 (`if (!row) return reply.code(404).send({ error: "not_found" });`):

```ts
    // Every kind, not a chosen subset. `down` on a self-adopted Homestead is unrecoverable
    // from the UI that issued it and `restart` kills the process mid-response; `up` and
    // `pull` are merely useless against a container that is by definition already running.
    // Same shape as the delete guard at `apps.ts:599`. The cost is real and accepted: an
    // admin restarts Homestead from the NAS, not from Homestead.
    if (row.isSystem) {
      return reply.code(409).send({
        error: "system_app",
        message: "Homestead does not run lifecycle actions against a system app.",
      });
    }
```

Placement matters: it is **after** `loadApp` so scope and existence still resolve first — a scoped admin must get 404 for an app they cannot see, not a 409 that confirms it exists — and **before** `runner.start`, so nothing spawns.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run src/server/routes/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the binding and the ordering**

Two mutations, both required:

1. Delete the guard. The system-app tests must fail. Restore.
2. Move the guard **above** the `loadApp` call (guarding on a row you have not loaded will not compile — instead, move it to just after the `kindSchema` check and have it re-query the row without `loadApp`'s scope filter). Confirm whether any existing scope test catches that a scoped admin now learns of an app's existence. **If none does, that is a finding — report it** and add the test:

```ts
it("tells a scoped admin nothing about a system app outside their scope", async () => {
  // 404, never 409 — a 409 confirms the app exists.
});
```

Restore the correct ordering afterwards.

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add src/server/routes/jobs.ts src/server/routes/jobs.test.ts
git commit -m "Refuse lifecycle actions on a system app

Spec section 10 says Homestead can manage itself with cloudflared's
isSystem protection; that protection was one guard, on delete. A down
on a self-adopted Homestead stops the process serving the request."
```

---

### Task 5: The image

Four stages. The third exists for one reason: **the production `node_modules` must be installed inside Alpine**, because `@libsql/client` resolves a native binding by platform and libc, and the only variant present on a glibc build host is `@libsql/linux-x64-gnu`. Copying a host-built `node_modules` into an Alpine runtime produces a container that starts and then dies at `createClient()` in `db/client.ts:10`.

**Ruling to state: the container runs as root.** Mounting `/var/run/docker.sock` is root-equivalent by construction — anything that can talk to the daemon can start a privileged container. A non-root user that must still be in the socket's group buys no isolation and adds a uid/gid matching problem across NAS models.

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Write `.dockerignore` first**

Without this the build context includes `node_modules` and `dist`, which is slow and risks a glibc `node_modules` shadowing the musl one.

```
node_modules
**/node_modules
dist
data
.git
.github
.superpowers
coverage
*.log
.env
.env.*
docs
```

- [ ] **Step 2: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1

# Node 24 is current LTS and matches the `--target node24` that `pnpm build:server` uses.
ARG NODE_VERSION=24-alpine

# ── deps ─────────────────────────────────────────────────────────────────────
# Full install, dev dependencies included, for the build stage. pnpm-workspace.yaml is
# not optional: it carries `minimumReleaseAgeExclude`, without which install fails with
# ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ── prod-deps ────────────────────────────────────────────────────────────────
# Runtime dependencies only, installed INSIDE Alpine. This is the stage that makes the
# libSQL native binding resolve to its musl variant; a node_modules built on a glibc host
# produces a container that dies at createClient().
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# Mutations shell out to `docker compose` (local-host.ts:508). dockerode talks to the
# socket over HTTP and does not replace the CLI.
RUN apk add --no-cache docker-cli docker-cli-compose

ENV NODE_ENV=production
ENV PORT=3000

# Every one of these paths is resolved against process.cwd(), so WORKDIR and this copy
# list have to agree or the defaults point at nothing:
#   ./data/homestead.db   config.ts:13
#   ./data/icons          config.ts:28
#   ./drizzle             db/client.ts:19 — migrations, and they live at the repo root,
#                         outside dist/
#   dist/web              routes/spa.ts:7 — and spa.ts only warns when it is missing, so
#                         getting this wrong produces a silent 404 rather than a crash
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Runs as root deliberately: /var/run/docker.sock is root-equivalent by construction, so a
# non-root user that must still reach it buys no isolation and adds uid/gid matching
# across NAS models.

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
```

- [ ] **Step 3: Build it — this is the gate, not a formality**

```bash
docker build -t homestead:dev . 2>&1 | tail -30
echo "build exit: $?"
```

Expected: a successful build. If `pnpm install --frozen-lockfile` fails inside Alpine, read the error before changing anything — `pnpm-workspace.yaml` being absent from the copy list and a lockfile that genuinely does not match are different problems with different fixes, and loosening to a non-frozen install hides both.

- [ ] **Step 4: Prove the musl binding actually resolved**

This is the specific risk this stage exists for, so test it specifically rather than inferring it from a successful build:

```bash
docker run --rm homestead:dev node -e "
  const { createClient } = require('@libsql/client');
  const c = createClient({ url: ':memory:' });
  c.execute('SELECT 1').then(() => { console.log('libsql OK'); process.exit(0); })
   .catch((e) => { console.error('libsql FAILED:', e.message); process.exit(1); });
"
```

Expected: `libsql OK`. A failure here names a missing `.node` binding and means the install did not run in Alpine.

If `require` is unavailable because the package is ESM-only, use `node --input-type=module -e` with an `import` instead. **Report which form worked.**

- [ ] **Step 5: Prove the CLI and the plugin are both present**

```bash
docker run --rm homestead:dev docker --version
docker run --rm homestead:dev docker compose version
```

Both must succeed. `docker compose version` failing while `docker --version` passes means `docker-cli-compose` is missing — the plugin is a separate apk package from the CLI, and only the plugin form (`docker compose`, not `docker-compose`) is what `local-host.ts` spawns.

- [ ] **Step 6: Prove every cwd-relative path landed where the code will look**

```bash
docker run --rm homestead:dev sh -c "pwd && ls -d dist/server dist/web drizzle node_modules data && ls drizzle"
```

Expected: `/app`, all five present, and at least one `.sql` file plus `meta` inside `drizzle`. A missing `drizzle/` means migrations fail at first boot; a missing `dist/web` means the SPA 404s silently, because `spa.ts:8-10` only logs a warning.

- [ ] **Step 7: Record the image size**

```bash
docker images homestead:dev --format "{{.Size}}"
```

Report it. It is a number to watch across phases, not a gate.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "Build the runtime image, installing production deps inside Alpine

tsup externalises every dependency, so node_modules ships. Installing it
in a separate Alpine stage is what makes the libSQL native binding
resolve to musl instead of the build host's glibc — the alternative
produces a container that starts and dies at createClient()."
```

---

### Task 6: Deploying it

The image running is not the same as the deployment being correct. The path-identity constraint is the thing most likely to be got wrong by someone following a README, and its failure is silent: a bind source that does not exist on the host is not an error — Docker creates an empty directory and proceeds, so Immich or Paperless come up looking freshly installed.

**Files:**
- Create: `compose.example.yaml`
- Create: `docs/deployment.md`

- [ ] **Step 1: Write `compose.example.yaml`**

```yaml
# Homestead's own deployment. Copy to compose.yaml, set the two required values, and
# `docker compose up -d`.
#
# THE ONE THING TO GET RIGHT: the compose root is mounted at the SAME absolute path
# inside the container as on the host. `/volume2/docker:/volume2/docker`, not
# `/volume2/docker:/data`. Homestead runs `docker compose -f /volume2/docker/<app>/...`,
# and the daemon resolves that stack's own relative bind mounts against the HOST
# filesystem — so the path string Homestead emits has to mean something on the host.
# Get it wrong and your stacks come up with empty config and data directories, which is
# indistinguishable from data loss until somebody looks. Homestead runs a preflight at
# boot that catches exactly this and refuses to start.

services:
  homestead:
    image: homestead:dev
    container_name: homestead
    restart: unless-stopped

    # Must exceed the shutdown budget in src/server/shutdown.ts (20s), or SIGKILL lands
    # mid-sequence and the ordering buys nothing.
    stop_grace_period: 30s

    ports:
      - "3000:3000"

    volumes:
      # Read-write: Homestead runs compose commands and writes compose files.
      - /var/run/docker.sock:/var/run/docker.sock
      # Identical path on both sides. See the note above.
      - /volume2/docker:/volume2/docker
      # homestead.db and the icon cache.
      - homestead-data:/app/data

    environment:
      # REQUIRED. 32 bytes, base64. Generate once and keep it:
      #   head -c32 /dev/urandom | base64
      # Losing it makes every stored secret undecryptable.
      HOMESTEAD_SECRET_KEY: "${HOMESTEAD_SECRET_KEY:?set HOMESTEAD_SECRET_KEY}"
      # REQUIRED. The URL you reach Homestead on; used for cookies and CSRF.
      HOMESTEAD_BASE_URL: "${HOMESTEAD_BASE_URL:?set HOMESTEAD_BASE_URL}"

      # Defaults shown. Change COMPOSE_ROOT only together with the bind mount above.
      HOMESTEAD_COMPOSE_ROOT: /volume2/docker
      HOMESTEAD_DOCKER_SOCKET: /var/run/docker.sock
      PORT: "3000"

      # Optional: only for placing Homestead behind a Cloudflare Access application it did
      # not create. Phase 2 writes these to the database when it provisions its own
      # exposure. With neither source supplying both, the Access sign-in path stays
      # dormant and password login is unaffected.
      # HOMESTEAD_ACCESS_TEAM_DOMAIN: your-team.cloudflareaccess.com
      # HOMESTEAD_ACCESS_AUD: <application audience tag>

volumes:
  homestead-data:
```

- [ ] **Step 2: Run it, against the real daemon**

`/volume2/docker` does not exist on this machine, but the constraint the preflight enforces is path *identity*, not that particular path — so exercise it faithfully with a path that does exist on both sides.

```bash
mkdir -p /tmp/hs-root/demo
printf 'services:\n  hello:\n    image: alpine:3\n    command: ["true"]\n' > /tmp/hs-root/demo/compose.yaml

cat > /tmp/hs-deploy.yaml <<'YAML'
services:
  homestead:
    image: homestead:dev
    restart: "no"
    stop_grace_period: 30s
    ports: ["3000:3000"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /tmp/hs-root:/tmp/hs-root
      - hs-data:/app/data
    environment:
      HOMESTEAD_SECRET_KEY: "0000000000000000000000000000000000000000000="
      HOMESTEAD_BASE_URL: "http://localhost:3000"
      HOMESTEAD_COMPOSE_ROOT: /tmp/hs-root
volumes:
  hs-data:
YAML

docker compose -f /tmp/hs-deploy.yaml up -d
sleep 12
docker compose -f /tmp/hs-deploy.yaml logs --no-log-prefix | tail -25
curl -sf http://localhost:3000/api/health && echo " health OK"
```

The `HOMESTEAD_SECRET_KEY` above is a throwaway 32 zero-bytes for this test only; it must not appear in the example file or the docs as anything but a generated value.

Four things must hold, and all four are the point of the task:

1. **The mount preflight passes.** It runs before anything else and refuses to start on failure (`index.ts:23-29`). Passing means it wrote a marker under `/tmp/hs-root`, launched a container binding that same path, and read the marker back through the daemon.
2. **Migrations ran** — no `no such table` in the logs.
3. `/api/health` answers.
4. The startup sweep logged nothing, there being nothing to repair on a fresh database.

- [ ] **Step 3: Prove the preflight actually catches a wrong mount**

This is the highest-value check in the phase, because the failure it guards against is silent. Deliberately break path identity — mount the share somewhere else while telling Homestead the root is unchanged:

```bash
sed 's|- /tmp/hs-root:/tmp/hs-root|- /tmp/hs-root:/mnt/wrong|' /tmp/hs-deploy.yaml > /tmp/hs-broken.yaml
docker compose -f /tmp/hs-broken.yaml up -d 2>&1 | tail -5
sleep 12
docker compose -f /tmp/hs-broken.yaml logs --no-log-prefix | tail -20
docker compose -f /tmp/hs-broken.yaml ps -a
```

Expected: the container exits non-zero with `PreflightError` naming the mismatch. **If it starts successfully, that is a Critical finding — report it and stop**, because it means the guard spec §10 requires does not actually hold in a container, and every claim in this phase's docs about silent mount failure being caught is false.

- [ ] **Step 4: Prove graceful shutdown works in the container**

```bash
docker compose -f /tmp/hs-deploy.yaml up -d
sleep 10
time docker compose -f /tmp/hs-deploy.yaml stop
docker inspect --format '{{.State.ExitCode}}' $(docker compose -f /tmp/hs-deploy.yaml ps -aq)
```

Expected: stops in well under `stop_grace_period` — a container that takes the full 30s was SIGKILLed, which means the handler from Task 3 did not run. Exit code 0. **Report the elapsed time**; it is the only end-to-end evidence the signal handler works where it matters.

- [ ] **Step 5: Clean up the test deployment**

```bash
docker compose -f /tmp/hs-deploy.yaml down -v
docker compose -f /tmp/hs-broken.yaml down -v 2>/dev/null
rm -rf /tmp/hs-root /tmp/hs-deploy.yaml /tmp/hs-broken.yaml
docker ps -a --filter name=homestead
```

Leave no containers or volumes behind. Do not remove the `homestead:dev` image.

- [ ] **Step 6: Write `docs/deployment.md`**

Cover, in this order, and keep it to what someone deploying actually needs:

1. **Prerequisites** — Docker with the Compose plugin on the NAS; the compose root already in use at `/volume2/docker`.
2. **Build** — `docker build -t homestead:dev .`
3. **The path-identity constraint, and why it is first.** Quote spec §10's reasoning: compose does not canonicalise paths, so the path string Homestead emits must be meaningful on the host; the daemon resolves symlinked bind sources correctly, so **a symlinked `/volume2/docker` on the host is supported**; mounting the share at a different path inside the container is not. The failure is silent — Docker creates an empty directory for a bind source that does not exist — so the boot preflight exists precisely because documentation is not enough. Say that it refuses to start and names the mismatch.
4. **Configuration** — a table of every variable from `src/server/config.ts:9-29`, its default, and whether it is required. `HOMESTEAD_SECRET_KEY` and `HOMESTEAD_BASE_URL` are the only two with no default. State plainly that losing the secret key makes stored secrets undecryptable.
5. **Volumes** — what each of the three is for, and that `/app/data` holds the database and the icon cache.
6. **First run** — the container starts, migrations run, and the browser lands on the setup wizard: create admin, verify host, import from disk, invite users.
7. **Upgrading** — rebuild, `docker compose up -d`; migrations run at startup; `stop_grace_period` must stay above the shutdown budget.
8. **Managing Homestead with Homestead** — it can be adopted like any other app. Mark it `isSystem` and lifecycle actions are refused (Task 4), so restarts happen from the NAS. Say why: a `down` on yourself cannot be undone from the UI that issued it.
9. **Troubleshooting** — three real failures and what they look like: the preflight refusing to start and what to change; `HOMESTEAD_SKIP_MOUNT_PREFLIGHT=true` existing for dev and CI and why it must not be set on the NAS; and a missing `dist/web` producing a silent SPA 404 rather than a crash (`spa.ts:8-10`).

- [ ] **Step 7: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add compose.example.yaml docs/deployment.md
git commit -m "Document deploying Homestead, leading with path identity

The constraint most likely to be got wrong by someone following a
README, and the one whose failure is silent: Docker creates an empty
directory for a bind source that does not exist on the host, so a
misconfigured mount looks exactly like data loss."
```

---

## Self-Review

**1. Spec coverage.** Walking spec §10 line by line:

| Spec requirement | Task |
|---|---|
| Multi-stage build on current Node LTS Alpine | 5 |
| Runtime image includes Docker CLI and Compose plugin | 5, step 5 verifies both |
| Docker socket mount | 6 |
| Compose root mounted at identical path | 6, steps 1-3; step 3 verifies the guard |
| Data volume for `homestead.db` and the icon cache | 5 (`VOLUME`), 6 (named volume) |
| `HOMESTEAD_SECRET_KEY`, `HOMESTEAD_COMPOSE_ROOT` | Already honoured (`config.ts:12-14`); documented in 6 |
| `HOMESTEAD_ACCESS_TEAM_DOMAIN` / `_AUD` as bootstrap override | Already honoured (`config.ts:22-23`); documented in 6 as commented-out |
| Access path dormant when neither source supplies both | Already true (`config.ts:84`); stated in 6 |
| Path-identity constraint and its reasoning | 6, step 6 item 3 |
| Symlinks on the host supported | 6, step 6 item 3 |
| Startup preflight refusing to start | **Already implemented** — `preflight.ts:37-145`, `index.ts:23-29`. Task 6 step 3 verifies it in a container rather than reimplementing it |
| Same check as onboarding step 2 | Already true — `setup.ts:103-136` calls the same function |
| Path confinement accepting either root | **Already implemented** — `paths.ts:20-25` |
| Homestead can adopt and manage itself with `isSystem` protection | 4 |

Two items in scope come from the carry-forward rather than §10 — the stranded-jobs sweep (Task 1) and graceful shutdown (Tasks 2, 3) — and both are named in `index.ts:108-114` as this phase's work.

**No spec gap found.** Two §10 requirements are already met and are verified rather than rebuilt.

**2. Placeholder scan.** No "TBD" or "handle errors appropriately". Three places deliberately delegate and each says exactly what to decide and on what grounds: Task 2 step 1 (reuse the existing test setup rather than build a second — the helper's real name has to be read from the file), Task 3 step 3 (the timeout-semantics disagreement, with both options and their trade-off), and Task 4 step 5 mutation 2 (report if no existing test catches the ordering). Task 6 step 6 specifies the doc as nine ordered items with their content, not "write documentation".

**3. Type consistency.**

- `sweepStrandedJobs(db, nowSeconds) → Promise<number>`: defined Task 1 step 3, used Task 1 step 5. Consistent.
- `JobRunner.shutdown(timeoutMs?) → Promise<void>`: defined Task 2 step 3, consumed by `Closeable.jobs` in Task 3. Consistent — `Closeable` declares `shutdown(timeoutMs?: number)`, and `createShutdown` calls it with no argument, taking the 10s default inside the 20s budget.
- `Closeable`'s `server.close(): Promise<void>` against Fastify's `app.close()`: wrapped as `{ close: () => app.close() }` in Task 3 step 6, so the structural type is satisfied without depending on Fastify's overloads.
- `db.close(): void` against libSQL's `client.close()`: `@libsql/client`'s `close()` is synchronous and returns void. If it turns out to return a promise, the `stage` helper awaits its return value anyway.
- `dbClient` is named in Task 3 step 5 and used in step 6. Consistent.
- 409 `system_app` in Task 4 matches the existing delete guard's shape at `apps.ts:599-600`.
- Timeout constants: `shutdown.ts` 20s, `JobRunner.shutdown` 10s, `stop_grace_period` 30s. Strictly increasing, which is the relationship that matters — Task 6 step 4 measures whether it holds.

**4. One risk worth naming.** Task 3's test list contains a test that will fail against the implementation the same task specifies. That is deliberate and flagged in place: the disagreement is a real design question about what the shutdown budget means, and the two defensible answers are written out with their trade-off. An implementer who silently deletes the test to get green has done the wrong thing; an implementer who picks either answer and says why has done the right one.
