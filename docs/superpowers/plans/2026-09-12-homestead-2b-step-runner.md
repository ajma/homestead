# Homestead Phase 2B — System Apps and the Step Runner

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle what a system app is, and build the multi-step job runner with reverse-order rollback that every later sub-phase depends on.

**Architecture:** Two independent pieces that happen to be prerequisites for the same thing. First, `isSystem` — one boolean currently asserting two incompatible meanings — becomes a `systemKind` discriminator, so the protection a self-adopted Homestead needs and the protection `cloudflared` needs stop being the same rule. Second, §6's four-step expose flow needs a runner that `JobRunner` cannot provide: it knows exactly one thing, a single `docker compose` invocation per job. The new runner shares `JobRunner`'s per-app mutex, which has to be extracted to be shared at all.

**Tech Stack:** Fastify, Drizzle, zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — §6.

**Recon:** `docs/superpowers/plans/2-recon.md`, which named this the highest-risk piece of Phase 2 and recommended validating it standalone before anything depends on it. That is why it comes before tunnels.

**Carry-forward:** `docs/superpowers/plans/2026-09-12-homestead-2a-carry-forward.md`.

**Nothing user-visible ships in 2B.** It is infrastructure, built and tested on its own so that 2C and 2D are about Cloudflare rather than about job plumbing.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`.
- Baseline **1398 tests**.
- **Measured libSQL constraint:** a file-backed database rejects overlapping *transactions* with `SQLITE_BUSY`; `:memory:` rejects **any** statement during an open transaction. Tests use `:memory:`. A read inside a transaction will deadlock there.
- **`jobs.kind` is unconstrained `text` at the database level** (`schema.ts:219`) — `JOB_KINDS` is a TypeScript-level constraint only. New kinds need no migration.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, Biome clean **by exit code**:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain` empty at the end of each task. Scratch in `/tmp`.

## The ruling on `isSystem`, made here rather than rediscovered

Today one boolean carries two incompatible meanings, and the guards say so in their own comments:

- `src/server/routes/apps.ts:620` — "marks the managed cloudflared stack, which Phase 2 owns", blocking **delete**.
- `src/server/routes/jobs.ts:33-43` — "a self-adopted Homestead", blocking **every lifecycle action**.

Nothing sets the flag in production code, so nothing is currently broken. But these need genuinely different protections and one boolean cannot express both:

| | Delete | `up` / `pull` | `restart` | `down` |
|---|---|---|---|---|
| **`self`** — this Homestead, adopted | blocked | blocked | blocked | blocked |
| **`cloudflared`** — the managed tunnel | blocked | allowed | allowed | allowed, confirmed |

**`self` keeps Phase 1H's ruling exactly**, and that ruling's reasoning is now correctly scoped rather than accidentally universal: `down` on yourself cannot be undone from the UI that issued it, and `restart` kills the process mid-response.

**`cloudflared` must not inherit it.** Restarting the tunnel is an ordinary operation and Homestead is not cloudflared, so nothing about it is self-destructive. Blocking it would mean an admin has to SSH to the NAS to restart a container Homestead created and manages — which is the opposite of the product. `down` is allowed but confirmed, because it takes every exposed app off the internet at once; that is a consequence worth naming, not a reason to forbid it.

Delete stays blocked for both. Forgetting `cloudflared` would strand every exposure with no UI left to clean them up.

**Cost if this ruling is wrong:** an admin who genuinely wants `cloudflared` gone must remove it by hand on the NAS. That is recoverable. The reverse mistake — letting the UI strand every exposure behind a tunnel it can no longer see — is not.

---

### Task 1: `systemKind` replaces `isSystem`

**Files:**
- Modify: `src/server/db/schema.ts`, `src/server/apps/serialize.ts`, `src/shared/dto.ts`, `src/server/routes/apps.ts`, `src/server/routes/jobs.ts`, `src/web/routes/AdminApps.tsx`, and the affected tests
- Create: a drizzle migration

**Interfaces:**
- Produces: `systemKind: "self" | "cloudflared" | null` on the `apps` row and on the admin DTO.

**Replace the boolean; do not keep both.** Two sources of truth for the same fact is the defect this project keeps finding — a derived `isSystem` alongside a `systemKind` invites them to disagree. If the UI needs a badge, derive it at the render site from `systemKind !== null`.

No data migration is required: nothing sets `isSystem` today, so every existing row is `false`.

- [ ] **Step 1: Write the failing tests**

In `src/server/routes/jobs.test.ts`, replacing the Phase 1H system-app tests:

```ts
// A self-adopted Homestead: every kind refused.
for (const kind of ["up", "down", "restart", "pull"]) { /* expect 409 system_app */ }

// The managed cloudflared stack: lifecycle allowed.
for (const kind of ["up", "restart", "pull"]) { /* expect 202 */ }

// `down` on cloudflared is allowed too — the confirmation is the client's job,
// and a server that refused it would make the UI's confirm dialog a lie.
```

That last case deserves a comment in the test. A reader will otherwise "tighten" it into a 409 and break the UI.

In `src/server/routes/apps.test.ts` (or wherever the delete guard's tests live — **read first**): delete is refused for both kinds, and still 404s rather than 409s for a scoped admin who cannot see the app. That ordering was covered in Phase 1I; keep it covered.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/server/routes/jobs.test.ts`
Expected: FAIL — `systemKind` does not exist.

- [ ] **Step 3: Migrate and implement**

Generate the migration with `pnpm db:generate`. **Read `drizzle/` and `PINNED.md`-style conventions first** — inspect the generated SQL before accepting it rather than trusting the generator.

Update both guards. Each keeps a comment, and each comment now states **which kind it protects and why that protection differs from the other** — that difference is the whole point of this task and is exactly what a future reader will collapse back into one rule.

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 5: Prove the bindings**

1. Make the lifecycle guard block `cloudflared` too. The "lifecycle allowed" tests must fail.
2. Make the lifecycle guard allow `self`. Those tests must fail.
3. Make delete allow `cloudflared`. Its test must fail.

Report each as "broke X → test Y failed → restored → green".

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Replace isSystem with systemKind, which says which system app

One boolean was asserting two incompatible meanings, and its two guards
said so in their own comments. A self-adopted Homestead must refuse every
lifecycle action because down cannot be undone from the UI that issued
it. The managed cloudflared stack must not inherit that: restarting a
tunnel is ordinary, and Homestead is not cloudflared."
```

---

### Task 2: One lock per app, shared by both runners

`JobRunner`'s mutex is a private `Map` keyed by `appId` (`job-runner.ts:49`). The step runner is per-app too. Two runners with two private maps do not mutex against each other at all — an expose job and a `docker compose down` would run concurrently on the same app, which is the kind of thing that works in every test and fails once in production.

**Files:**
- Create: `src/server/apps/app-lock.ts` + test
- Modify: `src/server/apps/job-runner.ts` and its test

**Interfaces:**
- Produces:
  ```ts
  export class AppBusyError extends Error {
    constructor(readonly appId: string, readonly holder: string) {}
  }
  export class AppLock {
    tryAcquire(appId: string, holder: string): boolean;
    release(appId: string): void;
    heldBy(appId: string): string | undefined;
  }
  ```
  `holder` is a description used in the error message, so a user learns *what* is running rather than only that something is.

**`tryAcquire` must be synchronous and must not be async.** `JobRunner.start` has a documented synchronous window (`job-runner.ts:103`) that exists because two `start` calls in one tick both spawned `docker compose up` on the same stack. An async acquire reintroduces exactly that. Read that comment before you touch it.

- [ ] **Step 1: Write the failing tests**

- A second `tryAcquire` for the same app returns false while held; true after release.
- Different apps do not block each other.
- `heldBy` names the holder.
- Release of an unheld app is a no-op, not a throw.
- **Two `tryAcquire` calls in the same synchronous tick: exactly one succeeds.** This is the test that matters; write it without any `await` between the calls.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/server/apps/app-lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement, and move `JobRunner` onto it**

`JobRunner` keeps its own `running` map for the *registry* role — the SSE route reads it to attach to a live job — but takes the lock for the *mutex* role. Those are two jobs one map was doing; separating them is the point.

`JobBusyError` already exists and carries `runningJobId`. Keep it: the route maps it to a 409 with that id, and changing that contract is not this task's business.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm exec vitest run src/server/apps`
Expected: PASS, including every pre-existing `job-runner` test unchanged.

- [ ] **Step 5: Prove the binding**

Make `tryAcquire` always return true. The same-tick test must fail, and so must `JobRunner`'s own double-start test. If `JobRunner`'s test stays green, the runner is not actually using the lock — say so.

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Extract the per-app lock so two runners can share it

JobRunner's map was doing two jobs: a mutex and a registry the SSE route
reads. The step runner needs the first and not the second, and two
private maps keyed by the same id do not exclude each other."
```

---

### Task 3: The step sequence, with reverse-order rollback

§6: "Four steps, run as a recorded job, each idempotent, with reverse-order rollback on failure."

**Files:**
- Create: `src/server/apps/step-sequence.ts` + test

**Interfaces:**
- Produces:
  ```ts
  export type Step<C> = {
    name: string;
    run(ctx: C): Promise<void>;
    undo?(ctx: C): Promise<void>;
  };
  export type StepOutcome =
    | { ok: true; completed: string[] }
    | { ok: false; failed: string; error: unknown; undone: string[]; undoFailures: Array<{ step: string; error: unknown }> };

  export function runSteps<C>(steps: Array<Step<C>>, ctx: C, opts?: { onProgress?: (event: StepEvent) => void }): Promise<StepOutcome>;
  ```

This task is **pure logic with no Cloudflare and no database** — that is deliberate. It is the piece most likely to be subtly wrong, so it gets tested in isolation where every path is reachable with a fake step.

- [ ] **Step 1: Write the failing tests**

The ordinary paths:
- All steps succeed: `ok: true`, `completed` in order, no `undo` called.
- Step 3 of 4 fails: steps 1 and 2 are undone **in reverse order**, step 3 is not undone, step 4 never ran.

The paths that are actually hard, and where the bugs live:
- **The failing step is not undone.** Its `run` did not complete, so undoing it is undoing something that did not happen — and for an idempotent create that means deleting a resource someone else owns. Assert `undo` was not called on it.
- **A step with no `undo` is skipped during rollback without aborting the rollback.** A read-only step needs no undo, and rollback must continue past it.
- **An `undo` that throws does not abort the remaining rollback.** This is the one that matters most: if undoing step 2 throws, step 1 must still be undone. Otherwise one failure during cleanup strands everything before it.
- Those undo failures are reported in `undoFailures`, not swallowed — partial rollback leaves real resources behind and the user must be told which.
- `onProgress` fires for each step's start and end, including during rollback.
- An empty step list succeeds trivially.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/server/apps/step-sequence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Keep it small and keep it pure. The doc comment should state the two rules that are not obvious from the signature: **the failing step is never undone**, and **rollback continues through an undo failure**, collecting them.

- [ ] **Step 4: Run and watch them pass**

Expected: PASS.

- [ ] **Step 5: Prove the bindings**

1. Undo in forward order. The reverse-order test must fail.
2. Include the failing step in the rollback. Its test must fail.
3. Let an `undo` throw abort the remaining rollback. That test must fail.

Report each. **If any comes back green, the test is not binding** — say so rather than accepting it.

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Run a step sequence with reverse-order rollback

Two rules the signature does not show: the failing step is never undone,
because its run did not complete and undoing an idempotent create that
did not happen deletes someone else's resource; and an undo that throws
does not abort the rest of the rollback, or one cleanup failure strands
everything before it."
```

---

### Task 4: Recording a step sequence as a job

A step sequence has to be visible in the UI the same way a deploy is: a `jobs` row, streamed progress, a terminal status.

**Files:**
- Create: `src/server/apps/step-job-runner.ts` + test
- Modify: `src/server/apps/job-runner.ts` (`JOB_KINDS`), `src/shared/admin.ts` if the DTO needs it

**Interfaces:**
- Consumes: `AppLock` (Task 2), `runSteps` (Task 3), the `jobs` table.
- Produces:
  ```ts
  export class StepJobRunner {
    start<C>(app: AppRow, kind: string, steps: Array<Step<C>>, ctx: C, userId: string): Promise<{ id: string }>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

- A successful sequence writes a `jobs` row that ends `succeeded`, with each step's name in the output.
- A failing sequence ends `failed`, and **the output names which step failed and what was rolled back** — a user reading it must be able to tell whether their Cloudflare account now has orphaned resources.
- `undoFailures` appear in the output prominently. This is the case where a human has to go clean up by hand.
- The app lock is taken for the sequence's duration and released afterwards, **including on failure**. Assert via `heldBy` before and after.
- A sequence cannot start while a `docker compose` job holds the lock, and vice versa — **both directions**, because a one-directional test passes against a runner that takes the lock but never checks it.
- The startup sweep from Phase 1H repairs a stranded step job the same as any other: it writes `status: "running"` and the sweep's predicate is status-based, so this should already hold. **Verify it does** rather than assuming.

- [ ] **Step 2: Run them and watch them fail**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`JOB_KINDS` gains the new kinds. `jobs.kind` is unconstrained text at the database level, so no migration — but check whether anything switches exhaustively on `JobKind` and would now be non-exhaustive. `tsc` will tell you; **do not silence it with a default case that hides a real gap.**

Register it in `AppDeps` the way `jobs` is, so routes can reach it in 2D.

- [ ] **Step 4: Run and watch them pass**

Expected: PASS.

- [ ] **Step 5: Prove the bindings**

1. Release the lock only on success. The failure-path lock test must fail.
2. Let a step job start while a compose job holds the lock. That test must fail.

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Record a step sequence as a job, under the same per-app lock

A failed sequence's output names the step that failed and what was rolled
back, because the question a user actually has is whether their Cloudflare
account now holds orphaned resources."
```

---

## Self-Review

**1. Spec coverage.** 2B implements no §6 feature. It delivers the two prerequisites §6's expose flow needs — "run as a recorded job, each idempotent, with reverse-order rollback on failure" — and settles the `isSystem` meaning §6 assumes when it says `cloudflared` is "flagged `isSystem`". Idempotency of the individual steps is 2C's and 2D's to provide; this runner's contract is ordering and rollback.

**2. Placeholder scan.** No "TBD". Three places delegate with the decision named: Task 1 step 3 (inspect the generated migration rather than trusting it), Task 2 step 3 (which of the map's two roles moves), Task 4 step 3 (whether anything switches exhaustively on `JobKind`).

**3. Type consistency.**
- `AppLock` produced in Task 2, consumed in Task 4. `tryAcquire` synchronous in both.
- `Step<C>` and `runSteps` produced in Task 3, consumed in Task 4. The generic context parameter is what lets 2D pass a Cloudflare client and an exposure record without this module knowing either.
- `StepOutcome`'s `undoFailures` is read by Task 4's output formatting — it exists on the failure arm only, so the discriminant has to be checked first.
- `systemKind` from Task 1 is unrelated to Tasks 2-4 and shares no file with them except tests.

**4. The risk worth a reviewer's attention.** Task 3 is pure and fully testable, which makes it *look* like the safe one. It is the opposite: every later sub-phase's correctness under failure runs through it, and its three hardest rules — the failing step is not undone, rollback continues through an undo failure, and undo failures are reported rather than swallowed — are each one line that a plausible-looking implementation gets wrong in the safe-seeming direction. All three have named mutations. If any of those mutations comes back green, that is the finding.
