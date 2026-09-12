# Phase 2B — carry-forward

Written at the end of Phase 2B, after a whole-branch review, a fix wave and a scoped
re-review. The per-task scratch workspace is git-ignored and has been deleted.

Earlier carry-forwards remain live except where closed below.

## What 2B shipped

Infrastructure only; nothing user-visible. `systemKind` replaced an `isSystem` boolean that
was asserting two incompatible meanings. `AppLock` extracted the per-app mutex out of
`JobRunner` so two runners can actually exclude each other. `runSteps` executes a step
sequence with reverse-order rollback, and `StepJobRunner` records one as a `jobs` row.

2C and 2D can now be about Cloudflare rather than about job plumbing, which was the point.

## The `isSystem` ruling, now settled

One boolean, two guards, two incompatible meanings — resolved into a discriminator:

| | Delete | `up` / `pull` | `restart` | `down` |
|---|---|---|---|---|
| **`self`** — this Homestead, adopted | blocked | blocked | blocked | blocked |
| **`cloudflared`** — the managed tunnel | blocked | allowed | allowed | allowed |

`self` keeps Phase 1H's ruling, now correctly scoped rather than accidentally universal.
`cloudflared` does not inherit it: restarting a tunnel is ordinary, Homestead is not
cloudflared, and forcing an admin to SSH to the NAS to restart a container Homestead created
is the opposite of the product. Confirming `down` is the **client's** job — a server that
refused it would make the UI's confirm dialog a lie, and there is a test saying so, because a
future reader will otherwise tighten it into a 409.

## Do these next

**1. 2C — tunnel provisioning and the managed `cloudflared` app.** This is what finally sets
`systemKind`.

**2. Cancelling an in-flight step sequence on shutdown is deferred to 2D, deliberately.**
Shutdown now *waits* for a sequence rather than killing it, which closes the orphaned-resource
hole. Cancelling needs a tear-down-versus-resume decision that cannot be made before there is
something to tear down. The deferral is commented at the site, not left silent.

**3. A step job is invisible to the UI's busy indicator.** `runningJobs()` and the client's
`useAppActions` both filter to `JOB_KINDS`, so buttons stay enabled while a sequence runs.
Safety is preserved — `AppLock` rejects the click with an honest 409 — but the affordance is
wrong and 2C/2D own the new surface that fixes it.

**4. The external-probe credential gap and the dormant Access JWT path** are still 2E's, unchanged.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | `StepJobRunner` waits on shutdown but cannot cancel | See above. The wait is bounded at 10s inside a 40s budget against a 55s `stop_grace_period`. |
| 2 | Step jobs do not drive the busy indicator | The lock still refuses the action; only the affordance is wrong. |
| 3 | A latent, unreproduced suite flake | Three agents reported one; I ran the suite 25 times (15 isolated `EnvTab`, 10 full) without reproducing it. Recorded rather than declared gone — Phase 1H has an identical entry, and this project has twice spent a phase finding a flake that "went away". |

## Things that must not be "simplified" later

- **`runSteps` never undoes the step that failed.** Its `run` did not complete, so undoing an
  idempotent create that did not happen deletes a resource someone else owns.
- **Rollback continues through an `undo` that throws, and reports the failures.** Otherwise one
  cleanup failure strands everything before it, and the user is never told which Cloudflare
  resources are now orphaned. `undoFailures` is that list.
- **A throwing `onProgress` cannot fail the job it reports on.** It escaped `runSteps` and
  skipped the terminal-row write.
- **`AppLock.tryAcquire` is synchronous, and `JobRunner`'s `appLock` is required, not optional.**
  The synchronous window at `job-runner.ts` exists because two `start` calls in one tick both
  spawned `docker compose up` on the same stack — measured. And while `appLock` was optional,
  unsharing it in `test-helpers.ts` compiled and left all 1424 tests green while the comment
  above it claimed real mutual exclusion. It is now a compile error, which is stronger than a
  test.
- **`JobRunner` keeps its `running` map as a registry and not as a mutex.** Those were two jobs
  one map was doing; the SSE route reads the registry to attach to a live job.
- **Three separate paths could hand the client a job id whose stream it cannot follow**, each
  found one at a time: `JobBusyError`, `runningJobs()`, and `useAppActions` via
  `GET /api/apps/:id/jobs`. All three filter by kind now. A fourth was searched for and not
  found — every path from a job id to the client was audited, and `POST /actions/:kind`'s
  `z.enum(JOB_KINDS)` makes starting a step job through that route impossible.

## Toolchain notes

**Drizzle's libsql migrator gates on journal timestamps, not content hashes.** A database that
has already applied a migration will **silently no-op** against a rewritten version of it —
zero new rows in `__drizzle_migrations`, and the intended change never happens. Proved with the
real migrator during this phase's re-review.

This phase rewrote `0001` and `0002` in place rather than adding `0003`, and that was safe only
because it was verified that **no database anywhere had applied them**: `main` carries only
`0000`, and the test VM was confirmed still to have `is_system` and no `system_kind`. **Do not
rely on that again.** Once a migration may have been applied anywhere, add a new one.

The corrected migration was verified independently against a database in the test VM's exact
shape — `0000` only, then real rows: `is_system = 1` became `systemKind = 'self'`, an ordinary
row became `NULL`, rows were preserved, and foreign keys, integrity and all four indexes
survived.

**The test VM now holds real data** — one user and one app — so it is no longer a throwaway.
Migrations reaching it are reaching something worth not breaking.

## The failure pattern, nine phases running

Two of this phase's four Importants were the shape this project keeps finding, and one of them
is the purest instance yet of a specific variant: **an optional parameter that makes a safety
property opt-in.** `JobRunner`'s `appLock?` was optional, so `test-helpers.ts` could construct a
runner with its own private lock — no mutual exclusion at all — and it compiled, and all 1424
tests passed, underneath a comment asserting that the two runners excluded each other. The fix
was not a test. It was deleting the `?`, which turns the mistake into a compile error.

That is worth generalising: **where a correctness property depends on two things being the same
object, make passing the wrong thing impossible to type rather than testing that nobody does.**

The other was `docs/deployment.md` telling operators to set a column a migration then dropped —
a defect that existed only in the join between a document and a schema change, which is exactly
the seam no test covers.
