# Phase 2D — carry-forward

Written after a whole-branch review, **two** fix waves and a scoped re-review. The scratch
workspace is git-ignored and has been deleted. Earlier carry-forwards remain live except where
closed.

## What 2D shipped

An app can be put on the internet behind Cloudflare Access and taken off again: the four-step
expose sequence from §6 — ingress, proxied CNAME, Access application, external probe — with
reverse-order rollback, and a deprovision that reverses it while deleting only what Homestead
recorded creating. One `Homestead Monitor` service token and one reusable `non_identity` policy
serve every app, so rotation is a single operation, and the token's `expiresAt` is persisted for
2F to warn from.

Server-side only. The UI is 2F's.

**This was the hardest sub-phase so far by a wide margin** — three Criticals, and one of the
fixes introduced a worse defect than the one it closed.

## The three Criticals, because each is a lesson

**1. Deprovision deleted an admin's own probe.** Probes were removed by `(appId, kind)` rather
than by recorded id, so an `http_external` probe an admin created by hand — and its entire check
history — was destroyed, and the call returned `ok: true`. It was the **fourth** instance of the
adoption-versus-creation confusion in two sub-phases, after the tunnel, the DNS record and the
Access application. Each was found separately. That is the signature of a sweep nobody ran to
completion.

**2. One expose silently broke every other hostname on the tunnel.** The tunnel-config round
trip used a strict zod schema, so `path` and `originRequest` were stripped from every rule and
`warp-routing` was dropped entirely. Since 2C adopts a tunnel the user may have created, a
single expose rewrote their whole routing table. The comment called the stripping "tolerating".
**On a read-modify-write endpoint, stripping unknown fields is data loss**, and that sentence is
the one to remember.

**3. An app left publicly routed with its authentication deleted.** With an adopted ingress rule
and a created Access application, deprovision returned `ok: true` having deleted the Access
application while the hostname was still routed and DNS still resolved — the app on the
internet, unauthenticated, with no local record.

**And then the fix for it created a dead end.** Refusing was right, but the refusal assumed
adopted legs were still live without ever querying them, so an admin who followed the
instructions and cleaned up in Cloudflare by hand *still* got refused — forever, with the app
stuck exposed and the only escape being to edit the database. The comment telling them to clean
up by hand had become false. Fixed by re-reading live state.

## Do these next

**1. 2E — wire the external probe's credentials, and mount the dormant Access JWT path.** The
monitor token's `clientId` and `clientSecret` now exist for it to use. Note the standing Phase 1
defect this closes: every `http_external` probe reports `degraded` permanently because
`index.ts` constructs the runner with no credentials.

**2. Detach the provision POST**, carried from 2C and still open. `stepJobs.start` awaits the
whole sequence, so the route returns only when provisioning finishes — which dies at a 524 once
Homestead is itself behind this tunnel.

**3. Two Minors left unfixed, deliberately**, both recorded rather than forgotten: a swallowed
compensation can permanently mark Homestead's own ingress rule as adopted, so a later deprovision
will refuse to remove a rule we created; and deleting the Cloudflare credentials does not clear
the stored monitor access, leaving a token id pointing at nothing.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | Exposing an app that already has an `http_external` probe **refuses** rather than retargeting | Retargeting would overwrite a target the admin set, and restoring it on deprovision needs persisted state that would carry its own silent-wrong-URL risk. Refusing is honest. |
| 2 | Deprovision continues past a failure rather than stopping at the first | Design choice; failures are collected and reported together. |
| 3 | `findAccessApp` lists all Access applications with no pagination | Small-scale assumption, consistent with a single-household deployment. |

## Things that must not be "simplified" later

- **The tunnel-config schema is `z.looseObject` and every write spreads the whole config.** Four
  write sites. A strict schema on a read-modify-write endpoint destroys fields it has never
  heard of. Verified by round-tripping a config containing fields the schema does not know.
- **All tunnel-config writes take one per-tunnel global mutex, and the read happens inside it.**
  There is no add-one-rule endpoint — the whole array is replaced — so two concurrent exposes
  each read the old array and the second PUT erases the first hostname. §6 calls it a
  correctness bug. **Four call sites, all covered**; the original concurrency test proved only
  one, and three lock removals survived mutation until that was found. This is not `AppLock`,
  which is per-app.
- **The ingress rule is spliced before the `http_status:404` catch-all, and `removeIngress` never
  removes the catch-all.** A rule after it is unreachable and fails silently; removing it breaks
  every other exposed app on the tunnel.
- **Four resources carry a created-by-us flag and every delete reads it**: the ingress rule, the
  DNS record, the Access application and the probe. §6: "only deletes resources Homestead
  recorded creating."
- **Deprovision re-reads live Cloudflare state for legs it did not itself delete.** Without it
  the refusal is permanent and hand cleanup cannot unblock it.
- **The Access application is deleted last, gated on whether the route is still live.** `ok: true`
  must never mean "your app is now public and unauthenticated".
- **`findDnsRecord` matches on type, target and proxied status, not just name.** Matching on name
  alone adopted an unproxied `A` record, so no CNAME to the tunnel was ever created and expose
  reported ready.
- **The monitor policy is `decision: "non_identity"` and is passed to every Access application.**
  Anything else demands a human login, which an automated probe cannot do; the symptom would be
  every external probe getting a redirect rather than an obvious misconfiguration. Dropping the
  policy id left 28 of 28 tests green until a test was written for it.
- **The `exposures` row is deleted last.** If it goes first and a later delete fails, the
  remaining Cloudflare resources are unreachable forever — Homestead no longer knows they exist.

## The failure pattern, eleven phases running

The review applied 35 mutations and killed 29. But the six survivors are not the story of this
phase. The story is that **a fix for a Critical introduced a worse Critical**, and only a
re-review that reproduced the *user's recovery path* — not the original bug — caught it.

The original defect left an app unauthenticated. The fix made deprovision refuse. Every test
passed, the refusal was correct, and the code was strictly safer than before. What nobody tested
was what the user does next: follow the error message, clean up by hand, retry. That path was a
permanent dead end, and the error message was telling them to take it.

So the lesson this phase adds is about where to point tests: **when code refuses to act, test the
path out of the refusal, not just the refusal.** A guard that cannot be satisfied is not a guard,
it is a trap — and it looks identical to a working guard from every angle except the one the user
stands at.
