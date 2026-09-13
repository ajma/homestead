# Phase 3A — carry-forward

Written after a whole-branch review and two fix waves, with a scoped re-review between them.
The scratch workspace is git-ignored and has been deleted. Earlier carry-forwards remain live
except where closed.

## What 3A shipped

Setting up Cloudflare now creates **both** Access policies — the `non_identity` monitor policy
for the probe's service token, and a shared `allow` policy whose includes are every enabled
Homestead user's email. Neither is a button and neither is pasted in by hand. The human policy
is rewritten in full whenever users change. Exposing an app creates an internal *and* an
external probe, and the expose form asks for a compose service and port rather than a URL
Homestead can work out itself.

§6 of the spec was updated to match — it previously said "the chosen human policy" without
saying where it came from, and Phase 2 had made it a field the admin typed.

## Two rulings, recorded because they are boundaries

**1. One shared human policy, deliberately ignoring per-app scope.** A viewer scoped to one app
is admitted by Cloudflare Access to **every** exposed app. Homestead's own UI still hides the
others, so the tunnel is more permissive than the application. The cost was put to the user
explicitly and this is their choice. It is stated in the spec, in the policy-building code, in
`docs/deployment.md` and in the expose form itself — four places, because the person it will
surprise is the one clicking Expose. **Per-app policies are the upgrade path.**

**2. Removing or disabling a user must succeed in Cloudflare or fail locally.** You cannot
revoke someone while Cloudflare is unreachable; you are never told someone is gone while they
still have internet access. Adding is best-effort by contrast — a delayed grant is an
inconvenience where a delayed revoke is a hole — and both call sites say why.

## The Critical, and where it came from

`accessSync()` trusted a recorded `humanPolicyId` forever, and `DELETE /api/cloudflare/credentials`
never cleared the store. A stale id meant **`DELETE /api/users/:id` and `PATCH {disabled}`
returned 502 permanently**, with recovery only by editing SQLite. Reachable two ordinary ways:
removing and re-adding credentials, or deleting the policy in Cloudflare's dashboard.

**It was on Phase 2D's carry-forward as a Minor** — "deleting the Cloudflare credentials does not
clear the stored monitor access, leaving a token id pointing at nothing." It was accurate, it was
filed, and it was cosmetic *at the time*. 3A promoted it to a lockout by putting user mutations
on that path, and nobody rechecked the list.

That is worth generalising: **a known-cosmetic gap is only cosmetic against the code that exists
when you file it.** A carry-forward is not a decision that something does not matter; it is a
decision deferred, and the next phase that touches the same path inherits it.

## Do these next

**1. Re-attach already-exposed apps after a policy self-heal.** When a missing human policy is
recreated, Access applications created before it still reference the old id. The admin deleted
that policy, so nothing is worse than they left it — but Homestead knows and does not say.
Closest existing surface is the drift reconcile.

**2. Make the reconcile periodic** — still the most valuable open item, carried from 2F. §6 says
periodic; it ships on-demand, so a deleted Access application (a live unauthenticated route)
waits for someone to open that app's tab and click.

**3. The panel copy for the self-healed state reads "Setting up automatically"** when nothing is
in flight. Small, but it tells the admin to wait for something that is not happening.

## Known gaps, consciously left

| # | Gap | Why |
|---|---|---|
| 1 | A recreated human policy is not re-attached to existing Access applications | Above. Same class of drift `reconcile.ts` already declines to auto-fix. |
| 2 | Per-app scope is not reflected in Access | Ruling 1. |
| 3 | The last-admin-versus-Cloudflare race | Needs true concurrency, fails restrictive, self-heals on the next mutation, and the LAN is always a way back in. Its non-racing sibling is now tested. |

## Things that must not be "simplified" later

- **`getPolicy` is called before trusting a recorded policy id**, and a `404` — and only a
  `404` — clears it. A network blip must not clear a good id: that would recreate a policy and
  orphan the old one while exposed apps still point at it. Measured: a thrown fetch and a 503
  both preserve the id.
- **The self-heal clears only `humanPolicyId`, not the whole record.** Clearing everything would
  rotate a perfectly good service token. Clearing nothing would leave `store.get()` reporting
  complete, so Retry Setup would stay a no-op — which is the 2D shape, a refusal whose
  instructions cannot unblock it.
- **Deleting credentials clears the policy store, including the encrypted monitor secret.**
- **The email list is rebuilt from the database every time, never diffed**, and compared
  case-insensitively. Better-Auth lowercases at signup, and 2E fixed a first-run lockout caused
  by comparing a raw body email against that.
- **Disable and delete sync to Cloudflare *before* the local write**; create and re-enable sync
  after and swallow failure. The ordering avoids a revert-after-cascade-delete.
- **DELETE's last-admin check runs before the Cloudflare sync.** Otherwise a sole admin deleting
  their own account is stripped from the Access policy and *then* gets a 409 — still an admin
  locally, no longer admitted by Access.
- **When Access was never configured, none of this runs.** Every user route checks for both
  credentials and a human policy id first.
- **Probes are deleted by recorded id, never by `(appId, kind)`** — both of them now. 2D's
  version of that defect destroyed an admin's own probe and its entire check history.
- **`internalServiceUrl` is computed in exactly one place**, and `upsertProbe` gates exposure on
  exact string equality against it. Two constructions would make exposure silently start
  refusing apps the day they diverged.

## The failure pattern, fourteen phases running

Three findings this phase were **vacuous assertions** — tests that could not observe what they
were named for. The one worth keeping is the mechanism, because it was not a careless test:

`fetchCalls` was **destructured** out of a helper, which collapses a live getter into a value
captured before any request. `expect(fetchCalls).toBe(0)` then read 0 while two real PUTs had
happened. Both tests added specifically to pin that property were asserting nothing, and a third
pre-existing test shared the shape. Nothing about the test reads as wrong.

And the long-running one closed here: **an intermittent suite flake four separate agents reported
and I never reproduced in about sixty runs.** It was a race in a test, not in the code — a
`waitFor` gating on the Deploy button's `disabled` attribute and then asserting the `EventSource`
synchronously, while `use-sse-text` opens the stream in a deferred effect. Under load the button
disables a commit earlier.

The general form is worth stating: **waiting on a proxy for the thing you are about to assert is
a race with no upper bound on how rarely it fires.** It looked like environmental noise for the
whole project. It was a real defect in a test the entire time, and it was found by someone who
treated one failure in eight as a lead rather than as weather.
