# Phase 2F — carry-forward, and the close of Phase 2

Written after a whole-branch review and a fix wave. The scratch workspace is git-ignored and has
been deleted. Earlier carry-forwards remain live except where closed.

## What 2F shipped

The exposure tab, the Cloudflare sections of Settings, onboarding step 4, an on-demand drift
reconcile, and the two things that had no home before: detaching the long-running provision and
expose requests, and **teaching Homestead which app is itself** — deferred in 1I, 2B and 2E.

Eleven Cloudflare routes existed with one UI consumer. They all have one now.

## Phase 2 is complete, with two honest exceptions

| | Delivers | State |
|---|---|---|
| 2A | Credentials and the API client | done |
| 2B | `systemKind`; the step runner with rollback | done |
| 2C | Tunnel provisioning and the managed `cloudflared` app | done |
| 2D | Expose / deprovision, service token, reusable policy | done |
| 2E | External probe credentials; the Access sign-in path | done |
| 2F | Exposure UI, onboarding step 4, drift | done |

**§6 is not fully closed and the plan's claim that it was is corrected here:**

1. **The reconcile is on-demand, not periodic.** §6 says "a periodic reconcile". It ships as a
   route and a button, so `access_app_deleted` — a hostname routed and no longer protected —
   surfaces only if an admin opens that app's tab and clicks. `Scheduler` and `RetentionTimer`
   are the precedents and make this cheap. **This is the most valuable remaining item.**
2. **Adoption of pre-existing tunnels and Access applications by hostname scan** remains
   deferred from 2A, because the account was a clean slate. Note that 2C and 2D handle the
   *adopted* case correctly wherever a resource turns out to pre-exist — what is unbuilt is the
   discovery scan, not the safety.

## The Critical, because it is the phase's whole lesson

**Self-detection could never have worked in production.** It read `HOSTNAME` and matched it
against container ids — but `compose.example.yaml` mandates `network_mode: host`, and under host
networking `HOSTNAME` is the **host's** hostname, not a container id. Measured on Docker 29.8.0:
bridged gives `b2b8ca80590f`, `--network host` gives the machine's name.

So detection returned `null` forever, nothing was marked `self`, and `resolveAccessSettings`
stayed `null` — **silently**, with no UI path to the override either.

Every test fed `HOSTNAME="abc123"` against a container `abc123000…`. **The production
configuration was the one configuration never tested** — 2E's carry-forward names this exact
shape, and it is the third time this session a test helper's convenient value removed the real
case from coverage.

The fix reads the container id from this process's own `/proc/self/mountinfo`, via Docker's
`…/containers/<id>/hostname` bind-mount source. That survives host networking because it comes
from the mount table rather than the UTS namespace. **Verified against a real daemon by
`scripts/verify-self-detect.sh`**, which brings up four real compose stacks matching the shipped
layout — all four pass.

## Do these next

1. **Make the reconcile periodic.** See above.
2. **Consider a drift surface outside the per-app tab** — a deleted Access application means a
   live unauthenticated route, and it currently waits for someone to go looking.
3. **Deploy and use it.** Phase 2 has never run against real Cloudflare. Every test uses an
   injected `fetch`, so the whole of Phase 2 is verified against beliefs about Cloudflare's wire
   format. The plans separate known facts from unverified ones throughout, and reviews caught
   three assumptions that had leaked into code. **The first real token save, tunnel provision and
   expose are the moment this gets tested.**

## Known gaps, consciously left

| # | Gap | Why |
|---|---|---|
| 1 | Reconcile is on-demand | Above. |
| 2 | At-most-one `self` app is enforced at the route, not by a database constraint | A partial unique index would be better; the route guard is tested. |
| 3 | The team domain is a manual admin field | No Cloudflare API or token scope was found to derive it. |
| 4 | `POST /api/cloudflare/tunnel`'s client timeout dropped from six minutes to the 30-second default | Correct now that the route is detached and returns promptly, but it is a behaviour change made during a fix wave rather than deliberately designed. |

## Things that must not be "simplified" later

- **Self-detection reads `/proc/self/mountinfo`, not `$HOSTNAME`.** Under `network_mode: host`,
  which the shipped compose file mandates, `$HOSTNAME` is the host's. There is a real-daemon
  script proving the replacement works; run it rather than trusting a unit test whose fixture
  you chose.
- **Detection degrades to `null` and never guesses**, and an unreachable Docker socket does not
  fail the whole adopt route.
- **The reconcile never writes to Cloudflare.** All eleven mutating client methods are asserted
  unused. §6: a tool that fights dashboard edits is worse than one that reports them.
- **The reconcile compares the Access application's id, not merely its presence.** A *replaced*
  application reported clean while its stale `aud` broke self sign-in and its missing monitor
  policy failed every external probe.
- **The exposure tab gates on a job being in progress before rendering the exposed view.** The
  `exposures` row is inserted at step 1 of 5, so a reload mid-expose otherwise showed a Remove
  button, no streamed output, and "Access application: Unknown" — and a failing sequence's
  orphan list never reached the tab that needed it.
- **`ensureMonitorAccess` deduplicates concurrent calls.** It read the store and created a token
  with an `await` between, so a double-click created **two real Cloudflare service tokens** and
  orphaned the first.
- **Adding a step to `SETUP_STEPS` must not reopen a finished wizard.** `App.tsx` gates on
  `completedAt`; verified against a real `setup_state` row rather than assumed, because 1G
  shipped a Critical from a comparable assumption.
- **`drift_findings` is its own column.** Drift findings were JSON-encoded into `lastError`,
  two lines from `state: "error"` — the next error path would have written a plain string and
  made the parser silently return `[]`.

## The failure pattern, thirteen phases running

The same one, and this phase's instance is the most expensive version of it: **the production
configuration was the only configuration not under test.** Self-detection had unit tests, they
passed, and they encoded a value that cannot occur in the deployment the project ships.

Three times now the mechanism has been a helper supplying something convenient — `test-helpers.ts`
appending a synthetic trusted proxy in 2E, a fixture hostname here. In each case the tests were
not weak; they were precise about the wrong thing.

The counter-measure this phase found is worth keeping: **where a value comes from the
environment, get one test's fixture from the real environment.** `self-detect.test.ts` now uses
mountinfo text captured verbatim from a real host-networked container, and
`scripts/verify-self-detect.sh` runs the unmodified detector against a real daemon. Neither is
clever. Both would have caught it on day one.
