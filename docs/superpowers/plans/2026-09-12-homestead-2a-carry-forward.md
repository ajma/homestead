# Phase 2A — carry-forward

Written at the end of Phase 2A, after a task review, a whole-branch review, a fix wave and a
scoped re-review. The per-task scratch workspace it was assembled from is git-ignored and has
been deleted.

Phase 1A's through 1I's carry-forwards remain live except where closed below.

## What 2A shipped

The first sub-phase of Phase 2, and only its first: an admin pastes a Cloudflare API token and
account ID into Settings, Homestead verifies them against the real API, and lists the zones it
can see. A Cloudflare API client owning transport, the v4 envelope, fault classification and
bounded retry. No migration — `secrets` and `settings` were already flat key-value tables.

Nothing is exposed yet. That starts in 2C.

## Phase 2's decomposition

| | Delivers | State |
|---|---|---|
| **2A** | **Credentials and the API client** | **done** |
| 2B | Resolve the `isSystem` conflict; a step-sequence job runner with reverse-order rollback | next |
| 2C | Tunnel provisioning and the managed `cloudflared` app | |
| 2D | Expose / deprovision, the service token and the reusable policy | largest |
| 2E | Wire the external probe's credentials; mount the dormant Access JWT path | |
| 2F | Exposure UI, onboarding step 4, drift flagging | |

**Deferred from §6 deliberately:** adoption of pre-existing tunnels, ingress rules and Access
applications by hostname match. The account is a clean slate, so create-only covers the real
case. Revisit if that stops being true.

## Two Phase 1 defects this phase surfaced

Neither is 2A's to fix, and both are assigned.

**1. Every `http_external` probe reports `degraded`, permanently.** The runner exists and is
wired into the scheduler, but `index.ts:59` constructs it with no `accessCredentials`, so it is
structurally complete and functionally inert. An admin can create one through the API and the
UI today and it will never report anything else. **2E closes it.** Harmless until then only
because nothing could have configured Cloudflare.

**2. `isSystem` means two different things.** `apps.ts` says it marks the managed `cloudflared`
stack that Phase 2 owns; `jobs.ts` says it marks a self-adopted Homestead. Nothing sets it in
production code. Phase 1I dropped the item rather than guess; **2B must resolve it**, because
2C is what finally sets the flag.

## Do these next

**1. 2B, and resolve `isSystem` as its first act.** The step-sequence runner is the other half:
§6's expose flow is four steps with reverse-order rollback, and `JobRunner` knows exactly one
thing — a single `docker compose` invocation per job. That is new infrastructure, not an
extension of `JOB_KINDS`. Recon named it the highest-risk piece of Phase 2, which is why it is
built and validated before anything depends on it.

**2. The wire-format assumption is still outstanding, and 2A could not close it.** Every test in
this phase runs against an injected `fetch`, so the phase is verified against beliefs about
Cloudflare's API rather than against Cloudflare. The plan wrote those beliefs down explicitly so
they could be challenged, and the review found one that had leaked into the code anyway — a
required `result_info.count`. **The first real token save is the moment this gets tested**, and
it exercises transport, auth, envelope parsing and pagination at once, loudly, with a human
watching. Until then, treat every Cloudflare fact not in the plan's "known" list as unverified.

**3. Verify against the real API before 2C depends on it.** The user has a Cloudflare account
and a domain with nothing built. Saving a token in Settings is now a five-minute check that
would de-risk four sub-phases.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | Verification proves Zone:Read and nothing more | §6 lists five permissions; probing the other four means writing calls against endpoint groups this phase has no other reason to touch, and getting them wrong in a way that rejects a valid token. The `permission` fault carries the diagnosis to wherever it eventually surfaces. **Written beside the code, not only here.** |
| 2 | A token missing `Cloudflare Tunnel:Edit` verifies happily and fails in 2C | Follows from gap 1. The failure is legible rather than mysterious, which was the design goal. |
| 3 | Pagination caps at 50 pages and throws rather than truncating | 2,500 zones is unreachable for a home NAS. Throwing is deliberate: a partial zone list would let an admin pick a zone a later sub-phase cannot find. |

## Things that must not be "simplified" later

- **`gcTime` is not the fix; not using `useMutation` is.** The plaintext token lived in
  TanStack's `MutationCache` as `state.variables` on the app-wide singleton, on success *and*
  failure, for the default five minutes — while the panel's comment said "nothing here puts the
  token in a query at all." That is Phase 1F's measured defect one layer down. The panel's
  pending state and error handling were already plain `useState`, so nothing was lost by
  bypassing the hook.
- **`RETRYABLE_FAULTS` is the single source the code reads.** It was decorative: the catch block
  never consulted it, so deleting `"network"` from the set left 30 of 30 tests green. A named
  constant that documents a policy nothing enforces is worse than no constant.
- **401 and 403 are never retried.** A permission error does not improve by being asked again;
  retrying it three times only delays the message the user needs.
- **A 200 with `success: false` is an error.** Cloudflare answers a failed request with HTTP 200
  and `success: false`, so the status code alone is not the signal. The fault is taken from the
  envelope's error codes, not the status — a code 9109 was being misreported as a transient
  Cloudflare fault and retried.
- **Pagination compares locally-tracked page numbers, not the response's, and is bounded.**
  Advancing on the response's page number with no cap loops forever against an API that ignores
  `?page=` — measured at 203 calls and still going, hanging the Fastify handler.
- **Only fields on the plan's known-facts list are required by the zod schema.** A required
  `result_info.count` meant a success response omitting it failed whole-envelope parse, burned
  three API calls, and made credentials impossible to save.
- **The token is write-only end to end.** No endpoint returns it, the panel clears it on
  success, the status DTO carries four characters, and the audit row carries none. Each of
  those has a test that fails if the token leaks into it.
- **`save()` is one transaction.** Un-transacted, a partial failure orphaned an encrypted token
  the UI had no button to remove. It contains only writes — no read — which matters because
  `:memory:` rejects **any** statement during an open transaction and the tests use `:memory:`.

## Toolchain notes

- **Editor diagnostics contradicted a clean `tsc` five more times this phase**, including
  reporting type errors in a reviewer's scratch files after they had been deleted. Trust `tsc`.
- **`pnpm exec biome check . | tail -1` hides the exit code.** Redirect and check `$?`.

## The failure pattern, eight phases running

Three of this phase's five Important findings were the same shape, and it is worth stating as
one sentence: **a claim and the code drifted apart, and only the claim was visible.** A comment
saying the token was never cached while it sat in the mutation cache. A `RETRYABLE_FAULTS`
constant documenting a policy the catch block never read. A commit message advertising a
`setToken("")` line that no test could see.

The variant worth remembering came from Important 5. The fixer reported it as "test-only — the
code was already correct", which sounded like a dodge and was not: the re-review confirmed it,
and explained why the original probe had passed. **The configured branch renders no form, so a
test looking for a pre-filled field found nothing and went green — the absence of the bug and
the absence of the test's subject are indistinguishable.** That is a vacuous pass with no bad
code behind it, which makes it the hardest kind to notice, because nothing is wrong except the
evidence.
