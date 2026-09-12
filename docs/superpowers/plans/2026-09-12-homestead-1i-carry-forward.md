# Phase 1I — carry-forward

Written at the end of Phase 1I, after the whole-branch review, its fix wave, a scoped
re-review and one correction the re-review forced. The per-task scratch workspace it was
assembled from is git-ignored and has been deleted.

Phase 1A's through 1H's carry-forwards remain live except where closed below.

## What 1I shipped

Five carried items, and the sixth dropped on purpose.

The compose and `.env` editors now warn before an in-SPA navigation discards unsaved work,
which needed a router migration first — `useBlocker` throws under a plain `BrowserRouter`.
The admin inventory fetches its running jobs in one grouped query instead of one request per
row. The vendored compose schema has a drift check. And two tests exist that should have:
one that had gone blind, and one that never existed.

**Also deployed.** Phase 1's `main` is running on `homestead-test.hippo-ule.ts.net:3000` over
Tailscale. Built on that VM from `main`, four stages, about two minutes. The mount preflight
passed, migrations ran, health answers, and a compose file written under the compose root was
confirmed byte-identical inside the container at the same path. The setup wizard is
deliberately not completed — the first account created becomes the admin, and that is the
user's to make.

## Closed from earlier carry-forwards

- **In-SPA unsaved-changes protection.** Carried from 1F. `beforeunload` covered closing the
  tab and nothing else, so switching tabs inside the app discarded a half-written compose
  file silently. `EnvTab` had no protection at all, and it edits credentials.
- **The per-row jobs query.** Carried from 1G. Measured 3 requests → 0 on a three-row
  inventory.
- **A drift signal for the pinned schema.** Carried from 1F.
- **The blind `SetupWizard` test** and **the missing delete-route ordering test.** Carried
  from 1G and 1H.

**Dropped deliberately: nothing creates the self-managed Homestead row.** Recon found the
reason this is not a bug fix — **the two guards disagree about what `isSystem` means.**
`apps.ts:599` says it marks the managed cloudflared stack that Phase 2 owns; `jobs.ts:33-38`
says it marks a self-adopted Homestead. Those imply different setters, different UI and
different rules: cloudflared is provisioned by Homestead, Homestead is adopted by a human.
Settling that here would be guessing at Phase 2's design. **Carried to Phase 2 as a design
question.** The protection being unreachable is the safe direction — nothing is marked
system, so nothing is wrongly blocked.

**Still open, and needing the user rather than an agent:** `target="_blank"` from a standalone
PWA may eject to a full browser. Carried since 1E and now the oldest open item. The test VM
makes it checkable on a real phone for the first time.

## Do these next

**1. Phase 2 — exposure.** Spec §6 and §12. The Cloudflare API client, `cloudflared` as a
managed app, tunnel/ingress/DNS, Access apps and policies, service token and rotation, the
external probe, exposure UI, drift reconcile, and onboarding step 4. The user has a
Cloudflare account and a domain with nothing built, which is the clean-slate case the spec
assumes — Homestead provisions everything itself. **Resolve the `isSystem` disagreement above
as part of that design**, because `cloudflared` is the thing that forces it.

**2. Verify the router migration in a real browser.** Task 3's manual click-through could not
be run — all three browser MCP servers were disconnected. The suite proves 11 routes intact
and all eight viewer-boundary tests still bind, but jsdom cannot tell you the back button
works. **Redeploy to the test VM after this merges and click through it**: a deep link to
`/apps/<slug>/compose`, the back button between edit tabs, and a viewer landing on the
launcher from `/apps`.

**3. `docs/deployment.md` has three gaps its first real user found.** No explicit callout to
build on the target host or libc; no guidance on compose-root ownership and permissions, or
on choosing a root on a brand-new host where `/volume2/docker` does not exist; and no mention
that `docker compose config` validates a deployment without printing the secret.

**4. Routers are never disposed.** An eager `.initialize()` leaks a popstate and a pagehide
listener per router instance — one per sign-in cycle. Measured and small. Left because
`useMemo` has no cleanup hook and patching it with a ref during render is unsafe under Strict
Mode's double invocation. It wants a different shape, not a patch.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | jsdom cannot verify that `beforeunload`'s `returnValue` affects any real browser | The tests now prove both lines execute with the right values, and say so precisely. Whether a given engine shows a prompt needs a real browser; no jsdom version can answer it. |
| 2 | `App.tsx:136`'s explicit `/setup` guard is masked by the `*` catch-all | Pre-existing and carried verbatim through the migration; removing it keeps all 24 App tests green. Harmless, but it reads as load-bearing and is not. |
| 3 | The main chunk grew 355.72 → 411.16 kB (105 → 122 kB gzip) | **An explicit overrule of this phase's own "must not regress" constraint.** That constraint exists to keep CodeMirror out of the main chunk — 1F took it from 928 kB to 329 kB and the editor is still lazy at 586 kB. A 55 kB router runtime is a different animal from a 600 kB editor, it is inherent to the API switch rather than a wiring mistake, and it buys protection against silently discarding a half-written compose file. The cost if wrong: a housemate who only opens the launcher pays 17 kB gzip for an admin-only feature. |
| 4 | `ConfirmDialog` fires `proceed()` then `cancel()` on confirm | Traced through react-router 7.18.3 and benign there; pinned by the integration tests so a future version changing it would be caught. |

## Things that must not be "simplified" later

- **The router is built with `useMemo` inside the component, not at module scope.** A module
  singleton freezes `window.location` at import time and breaks the fresh-per-mount
  assumption `App.test.tsx` relies on. The two are not interchangeable, and this plan's brief
  wrongly treated them as if they were.
- **Its dependency list is `[isAdmin, me]`, and both ends matter.** Too narrow and a demoted
  admin keeps admin routes; too wide and the router is recreated, remounting the tree and
  silently discarding editor state. Both failure modes are invisible to a passing suite.
- **`handleJobDone` patches the cached row with `setQueryData`; it does not invalidate
  `adminAppsKey`.** 1E's carry-forward forbids invalidating that key on a status frame,
  because `/api/apps` spawns up to four `docker compose config` processes and a flapping probe
  would become a load generator. A job finishing is a discrete user-initiated event and would
  have been safe to invalidate on — patching is better still, and the distinction is now
  written down rather than rediscovered.
- **`runningJobs` and `deployTimestamps` are gated on `detailed`.** A viewer must not run
  either query, and after this phase a test enforces it. Before, removing the gate left all
  1327 tests green.
- **`GET /api/apps/:id` returns `toViewerApp` before the running-jobs query runs.** Verified
  twice, independently, because it is the security-shaped surface: a viewer never receives
  `runningJobId` from the single-app route any more than from the list.
- **`useUnsavedChanges` sets both `preventDefault()` and `returnValue = ""`.** Engines have
  historically disagreed about which triggers the prompt. A fix round deleted the second as
  redundant, citing jsdom; the re-review showed the cited mechanism was false even in jsdom,
  and that the tests dispatched a plain `Event` on which `.returnValue` is an inert expando —
  so they could never have observed either line. Both are now separately mutation-tested.
- **The drift script verifies the vendored file's content against the pinned commit's
  content, not just the SHAs.** It shipped comparing two strings and printing "the vendored
  schema matches the tip". Deleting `image`, `ports` and `depends_on` from the vendored schema
  produced "no drift" and exit 0.

## The failure pattern, seven phases running

The same one, and this phase's instance is the sharpest statement of it yet, because the
script it appeared in **existed specifically to be a gate.** `check-schema-drift.ts` printed
"the vendored schema matches the tip of compose-spec's default branch" after comparing two
SHA strings and never opening the file. Its whole justification — accepted on the precedent of
1H's manual preflight gate — was that a manual gate which actually runs beats an automated
test that cannot fail. It could not fail.

The second instance is the one worth studying, because the correction itself was wrong. A
fix round deleted `event.returnValue = ""` as redundant, saying it had confirmed in jsdom that
both lines set the same flag. The re-review checked and found jsdom's setter stores an
independent field and never touches that flag — and, more damningly, that the tests dispatched
a plain `Event`, where `.returnValue` is an inert expando connected to nothing. **The tests
could not have observed either line, so the experiment that justified deleting one of them
had no signal in it at all.**

That is a new variant of the pattern and it deserves its own name: not a test that cannot
fail, but **a measurement that cannot measure, used to justify removing code.** The
counter-measure is the same one this project keeps relearning, applied one level up: before
believing an experiment's result, break the thing it is measuring and require the measurement
to move.
