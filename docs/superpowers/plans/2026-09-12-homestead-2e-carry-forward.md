# Phase 2E — carry-forward

Written after a whole-branch review and two fix waves, each followed by a scoped re-review.
The scratch workspace is git-ignored and has been deleted. Earlier carry-forwards remain live
except where closed.

## What 2E shipped

The two things Phase 1 built and left inert are now on.

**The external probe has credentials.** `createHttpRunners` had accepted an `accessCredentials`
callback since Phase 1 and `startup.ts` never passed one, so every `http_external` probe an
admin could create reported `degraded` forever. Credentials are read per run, so 2D's rotation
takes effect on the next probe.

**The Cloudflare Access sign-in path is mounted.** It was correct, tested, and registered
nowhere — its only exercise was its own test file. It now resolves its team domain and audience
from the database with the environment as an override, and it is inert unless both are present.

## Closed

- The standing Phase 1 defect recorded in 2A's and 2D's carry-forwards: `http_external` probes
  permanently `degraded`.
- The dormant Access plugin, carried since Phase 1A.
- **A permanent first-run lockout that predates Phase 2 entirely.** Better-Auth lowercases email
  at signup, but `routes/users.ts` compared the raw body email — so `POST /api/setup/admin` with
  a mixed-case address created an unpromoted viewer and then returned `409 already_initialised`
  **forever**. No admin, and the only route that makes one refusing. Found by a re-reviewer
  looking at something else.

## The security result worth recording

A reviewer attacked the audience check directly rather than reading it, and **it held**:
`aud` absent, `null`, `[]`, a prefix, a superstring, and an array containing another
application's audience alongside the right one were all rejected; `alg: none` and HS256 keyed on
the RSA modulus *and* on the SPKI were rejected; a foreign `kid` did not steer key selection.
The issuer and the JWKS cache are both keyed to the configured team domain.

That matters because the audience comparison is the entire boundary: every Access application in
the same Cloudflare account issues a structurally valid, correctly signed, unexpired JWT.

## Do these next

**1. 2F — exposure UI, onboarding step 4, drift flagging, and the service-token expiry warning.**
The last sub-phase. Three routes now exist with no UI consumer: `GET /api/cloudflare/access`,
the expose and deprovision routes from 2D, and the tunnel status route from 2C.

**2. Nothing marks an app `systemKind: "self"`, so 2E's database path is unreachable in
production.** Only the environment override actually activates Access sign-in today. This has
now been deferred three times — 1I dropped it, 2B settled what `self` *means* without assigning
who sets it, and 2E resolves from a `self` app that cannot exist. **2F or a follow-up must close
it**, and the honest options are self-detection at adoption (the running container's compose
project) or an explicit admin choice. Nothing in the code pretends otherwise.

**3. Detach the provision POST**, carried from 2C and still open. It dies at a 524 once Homestead
is itself behind this tunnel — which is exactly what marking an app `self` and exposing it does.
These two items are more coupled than they look.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | An Access assertion for an unknown email does not create a user | Deliberate. Auto-provisioning would let anyone the Access policy admits become a Homestead user — a policy decision belonging to the admin, not to this code. |
| 2 | `config.accessEnabled` is now unread in production | Superseded by `resolveAccessSettings`, still covered by its own test. Harmless, and removing it is a change to `config.ts`'s public shape. |

## Things that must not be "simplified" later

- **`accessCredentials` is a required parameter, not optional.** Reverting `index.ts` to
  `createHttpRunners({ fetch })` — the verbatim Phase 1 defect — left all 1650 tests green *and*
  `tsc` clean while it was optional. It is now a compile error. This is the second time this
  project has fixed a safety property by deleting a `?` rather than by adding a test; the first
  was `JobRunner`'s `appLock` in 2B. **Where correctness depends on a dependency being supplied,
  make omitting it impossible to type.**
- **The Access hook returns early when a session already exists.** Without it, a valid assertion
  for a viewer, sent alongside an admin's session cookie, **replaced the admin with the viewer**.
  The test that was supposed to cover this sent `"not.a.jwt.at.all"`, which is rejected either
  way — vacuous.
- **`authPath: "access"` is recorded on the session**, because §7 requires the audit trail to
  record which path authenticated a request. Flipping it to `"password"` left 1650 tests green.
- **The Access hook is gated on the raw TCP peer, not `request.ip`.** Fastify's `trustProxy`
  resolves `.ip` *past* the immediate peer, so for genuine tunnel traffic `.ip` is the visitor's
  address and would never match a trusted proxy — checking it would reject real cloudflared
  requests while accepting LAN ones. The raw peer is unspoofable.
- **That gate matches with `net.BlockList`, not `includes()`.** `trustProxy` accepts CIDR and
  IPv4-mapped IPv6; a plain `includes()` accepts neither, so an operator setting a CIDR got a
  working `request.ip` and a **silently dead Access sign-in**. Node's stdlib covers it; no
  dependency was added.
- **An `undefined` peer fails closed**, and there is a test pinning it.
- **Email is normalised at every comparison and lookup.** See the lockout above.

## The failure pattern, twelve phases running

Every finding in this phase was a **surviving mutation** rather than a broken behaviour: the
probe wiring, the session-precedence guard, the audit path, the trusted-peer default, the
`undefined` peer. Each was correct code that no test could see, and each would have survived any
amount of reading.

Two are worth naming as a pair, because they are the same idea arriving from opposite
directions. The `accessCredentials` fix made a mistake **impossible to type**. The
trusted-peer-default fix made a mistake **visible to a test** that did not exist, because every
Access test routed through a synthetic address `test-helpers.ts` appends — so the shipped default
of `127.0.0.1,::1` was exercised by nothing at all.

That second one generalises uncomfortably: **a test helper that supplies a convenient value
silently removes the production value from coverage.** Every test passed through the helper's
address, so the configuration users actually run was the one configuration never tested.
