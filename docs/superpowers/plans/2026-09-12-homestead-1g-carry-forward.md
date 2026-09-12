# Phase 1G — carry-forward, and the close of Phase 1

Written at the end of Phase 1G, after the whole-branch review, its fix wave and a scoped
re-review. The per-task scratch workspace it was assembled from is git-ignored and has been
deleted.

Phase 1A's through 1F's carry-forwards remain live except where closed below.

## What 1G shipped

The first-run setup wizard — create admin, verify host, import from disk, invite users, done
— resumable through the `setup_state` table, which existed since 1A and which nothing had
ever read or written. Every step is idempotent and the flow re-enterable at the step the
server says you are on, not the step the client remembers.

Also: `Host.dockerVersion()`, so step 2 proves the Docker socket works by showing the
daemon's actual response rather than asserting it; the users-management UI, closing a gap
where the full CRUD API had shipped in 1A with no way to reach it; and a real `/settings`,
which had been a `Placeholder` for six phases.

And the debt: Tasks 9, 10 and 11 closed five carried items, four of them carried since 1E
and one since 1C.

## Closed from the 1E and 1F carry-forwards

- **The `.env` table save no longer receives every secret.** `PUT /api/apps/:id/env` takes a
  `changes` array applied server-side through the `upsertEnv` that already lived in
  `src/shared/env-file.ts`. The rare 409-recovery paths still make one whole-file fetch,
  which is unavoidable: showing the user the concurrent value requires having it.
- **`intervalSeconds` now moves `nextRunAt`.** Carried since 1C. An admin who shortened a
  daily probe to thirty seconds previously waited up to a day to see it take effect.
- **`statusSince` comes from the server's transition time.** This needed both halves — the
  frame did not carry the transition time at all, so the client had nothing better to use
  than its own clock.
- **Inventory row actions and right-rail metadata exist**, the spec §8 items 1E's
  Self-Review wrongly claimed as delivered. They reuse `ActionBar`'s mutation path rather
  than growing a second one, and a row action invalidates only that app's key.
- **An admin can re-run the host check from Settings.** `finish` is one-way, so before this
  an admin who continued past a failing preflight could never re-verify the mount from any
  UI. `HostCheckPanel` is shared with `StepVerifyHost`.

**Still open from 1E:** `target="_blank"` from a standalone PWA, which needs ten minutes on a
real phone and cannot be settled from here; and the startup sweep of `jobs` rows stuck at
`running`, which belongs to the deployment task below.

**Still open from 1F:** the compose editor's lack of in-SPA unsaved-changes protection, which
needs `createBrowserRouter` and `useBlocker` — a router migration, not a component change;
and the absence of any drift signal on the vendored schema pin.

## Do these next

**1. Spec §10, Deployment, has never been planned.** Three carry-forwards now point at it and
it is the last thing standing between this and running on the NAS: the Dockerfile, the
multi-stage build, the SIGTERM handler, and the startup sweep of orphaned `running` jobs.
Phase 1E made that last one visible — `ActionBar` resumes from such a row, so every page load
after a crash flashes a phantom running job before self-healing, and nothing ever fixes the
row. **This should be the next phase.**

**2. `RowActions` mounts `useJobs` per row**, so a twenty-app inventory fires twenty `/jobs`
requests on load. Measured during the fix wave: twenty requests, no polling storm, and
DB-only rather than the Docker-touching endpoint — which is why it was left. De-duping needs
a batch endpoint, which is real plumbing and was out of scope for a fix wave. It is the same
shape as the defect 1E fixed in `EditApp`, one order of magnitude cheaper.

**3. `SetupWizard`'s original "does not double-fire" test is still blind.** It was written
against `StepPlaceholder`, which this branch deleted; it now drives the real `StepImport`,
whose Skip self-disables and masks the guard. A new test backstops the guard properly, but
the blind one remains in the file and will mislead the next person who reads it. Either fix
it or delete it.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | The finish-step counts are unscoped totals | Correct only because nothing can exist before the wizard runs on a first install. True today; a lie the first time anything can create an app outside the wizard. |
| 2 | A second client joining an in-flight `runPreflightOnce` gets the shared result | The comment now says so rather than claiming a fresh answer. |
| 3 | The `preflight.ts` ENOENT retry is a single retry, not a loop | The race is microseconds wide and a genuine failure still reports on the second attempt. |
| 4 | One `ActionBar.test.tsx` failure appeared once during the fix wave | Did not reproduce in fifteen subsequent full runs, in isolation or in suite. Recorded rather than dismissed: an unreproduced failure is a latent flake, and this suite has had two before that took a phase each to find. |

## Things that must not be "simplified" later

Each closes a defect that was measured, not hypothesised.

- **`App.tsx` resolves an absent session to `Login` before a setup-state failure can resolve
  to "Homestead is unavailable".** Before this, once an admin existed but setup was
  unfinished, a visitor with no session got 401 from both `/api/me` and `/api/setup/state`
  and landed on a dead end — **no login form, and no recovery short of the original cookie or
  hand-editing SQLite.** It fired on a second device, an expired session, or a private
  window mid-setup: precisely the situations resumability exists for. The ordering is the
  whole fix, and the opposite direction matters too — a genuinely unreachable backend must
  still say so rather than showing a login form to someone whose server is down. Both
  directions have tests.
- **`LocalHost.dockerVersion` validates the daemon's response at the call site**, and the
  presence check is not decorative: a missing field dropped by JSON previously produced a
  "success" with no version in it. `FakeHost.dockerVersion` returns a fixed literal and
  validates nothing, which is why the call site needs its own test and not just
  `parseDockerVersion`'s.
- **`runMountPreflight` removes only its own marker and does a non-recursive `rmdir`.** It
  used to wipe the shared `.homestead-preflight` directory recursively, so concurrent runs
  deleted each other's markers and reported a working mount as broken.
- **`SetupWizard` gates `markComplete` on `pendingRef`, not only on the step's own disabled
  state.** The two are not the same guard, and the step's disable is the one that happens to
  be visible.
- **The viewer boundary is tested by navigation, not by nav-link visibility.** Breaking the
  `isAdmin` guards fails eight tests across `/apps`, every edit tab, and `/settings`. "The
  link is hidden" is a different claim about a different thing, and passes against a viewer
  who types the URL.
- **A row action invalidates only that app's key, never `adminAppsKey`.** Carried verbatim
  from 1E, and re-proven here: adding the list invalidation back to a row action is caught by
  its own test. `/api/apps` is the endpoint that spawns up to four `docker compose config`
  processes.
- **`ComposeTab` and `EnvTab` stay lazy.** The initial chunk closed this phase at 355.62 kB
  against 329 kB at the end of 1F; CodeMirror remains its own 586 kB chunk. `pnpm build` is
  the only gate that would notice this regressing.

## Toolchain notes

Additions to the earlier lists, which all still hold.

- **Editor diagnostics in this repo contradicted a clean `tsc` four more times this phase**,
  including twice reporting a symbol unused that was used three lines down. Trust `tsc`.
- **`pnpm exec biome check . | tail -1` hides the exit code.** Redirect and check `$?`.
- **Concurrent `pnpm` operations corrupt `package.json`.** Unchanged and still enforced: no
  dependency-installing task runs alongside another agent.
- **RTL's `act()` can mask TanStack's `notifyManager` `setTimeout(0)` deferral.** When a
  binding check comes back green, suspect the harness before believing the code.

## The failure pattern, five phases running

It has been the same one every time, and this phase's whole-branch review found it again by
the same method: **twenty-five mutations applied to load-bearing lines, twenty-one died, and
the four survivors were the four findings.** Two of them were tests that had gone blind
without anyone touching them — a test written against `StepPlaceholder` kept passing after
`StepPlaceholder` was deleted and the real component took its place, because the real
component happened to disable its own button. Nobody broke that test. It rotted.

That is the new thing this phase teaches, and it is worth stating plainly: **a test can stop
testing its target without its file ever being edited.** The counter-measure is unchanged and
still mechanical — break the line, require red — but the trigger for re-running it is
broader than "this code changed." When a component a test drives is replaced, the test's
binding to its target is no longer established by the fact that it once passed.

The Critical finding this phase makes the same point from the other side. `App.tsx`'s
comment asserted that the wizard "only needs a session from the second step on." It needed
one throughout and offered no way to get one. Four consecutive phases have now produced a
finding of the form *a comment claiming a guarantee the code does not provide*, and this one
locked users out of their own installation.
