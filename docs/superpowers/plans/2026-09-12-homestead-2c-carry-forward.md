# Phase 2C — carry-forward

Written after a whole-branch review, a fix wave and a scoped re-review. The scratch workspace
is git-ignored and has been deleted. Earlier carry-forwards remain live except where closed.

## What 2C shipped

An admin clicks Provision and Homestead creates a remotely-managed Cloudflare tunnel
(`config_src: "cloudflare"`), writes `cloudflared` as an ordinary compose stack with the tunnel
token in a sibling `.env`, registers it as an app flagged `systemKind: "cloudflared"` with a
docker probe, and brings it up — with reverse-order rollback if any step fails.

This was 2B's step runner's first real consumer, which was the point of building it first.

## The finding worth remembering

**The rollback deleted a Cloudflare tunnel it had merely adopted.** Step 1 matches an existing
tunnel by name rather than creating a second one — sound, because it closes an orphan window
that a failed `deleteTunnel` opens. But its `undo` then deleted that tunnel. Measured: seed
`{id: "users-own-tunnel", name: "homestead"}`, fail a later step, and rollback reports
`created: []`, `deleted: ["users-own-tunnel"]`.

A user with a tunnel called `homestead` would have lost it to a failed provision. Spec §6 says
deprovisioning "only deletes resources Homestead recorded creating"; this violated it in the
first place the rule could apply. Fixed with a `ctx.created` flag, and the re-review confirmed
both halves — an adopted tunnel survives, a created one is still cleaned up.

**The general shape, worth carrying into 2D:** *adoption and deletion were authorised by the
same match.* Every remaining resource in the expose flow — the DNS record, the Access
application, the ingress rule — has exactly this structure, and §6 calls it out for DNS
specifically. Each needs its own created-by-us flag, and the `exposures` table already has
`dnsRecordCreatedByUs`, `ingressRuleCreatedByUs` and `accessAppCreatedByUs` columns waiting.
**Use them.**

## Do these next

**1. 2D — expose and deprovision, the service token and the reusable policy.** The largest
sub-phase.

**2. Detach the provision POST.** `stepJobs.start` awaits the whole sequence, so the route
returns only when provisioning finishes. That is not a defect today — the client passes a
six-minute timeout override against `apiFetch`'s 30-second default — but it **dies at a 524
once Homestead is itself behind this tunnel**, and it causes two known limitations: the
initiating tab sees no live output until the POST resolves, and the audit row had to be moved
ahead of the sequence to exist at all. Every other piece of the non-blocking design is already
built and tested. There is a comment at the route saying so.

**3. `runSteps` never undoes the step that failed, so a step making two external writes must
compensate its own first write inline.** Two steps here do. That is a real consequence of 2B's
contract and it will recur in 2D, where several steps touch two things. Neither the rule nor
the obligation is discoverable from the type.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | The initiating tab sees no streamed output until the provision POST resolves | Root cause is the blocking await above. The test was **renamed to describe the real behaviour** rather than changed to hide it, and cross-references the route comment. |
| 2 | The scaffolded compose file pins `cloudflare/cloudflared:latest` | Unpinned. Consistent with how a human writes this stack, and the image-update checker already exists to surface drift. |
| 3 | Delete idempotency on the tunnel endpoint is assumed, not verified | The plan listed it as unverified and the comment now says "assumed" rather than stating it as fact. |

## Things that must not be "simplified" later

- **`create-tunnel`'s undo is gated on `ctx.created`.** Adoption and deletion must not be
  authorised by the same name match.
- **`config_src: "cloudflare"` is asserted on the request body, not the response.** Nothing else
  in the system would notice it being dropped, and the entire no-restart design rests on it:
  ingress lives in Cloudflare's API, so exposing an app later needs no container restart.
- **`cloudflared` runs with `network_mode: host`.** The ingress service for an app is
  `http://localhost:<published-port>`, and those ports are published for LAN clients anyway. A
  bridged container's localhost would be its own. Two accepted consequences are commented in
  the scaffolded file itself, where someone reading it over SSH will find them: the tunnel can
  reach anything on the NAS and its LAN, so the ingress list is the effective boundary; and
  exposed apps stay reachable on the LAN without passing through Access.
- **The undo deletes `compose.yaml` and `.env` independently, not sequentially.** Sequential
  deletes meant a throw on the first left the `.env` — holding a live tunnel token — on disk,
  unnamed in the cleanup banner.
- **`write-files` compensates inline for its own partial failure.** A failing `.env` write
  otherwise strands `compose.yaml`, which the adoption scanner then offers the user as an app.
  No-oping that compensation left 132 of 132 tests green.
- **The audit row is written before the sequence, not after.** `stepJobs.start` blocks, so
  auditing on completion meant zero audit rows mid-flight: a crash after `create-tunnel` left a
  real tunnel with no record of who asked for it.
- **The tunnel token lives only in the `.env` and `secrets`.** Never inline in the compose file,
  never in the job output, never in an error. `maskEnv` covers it and there is a test saying so.

## The failure pattern, ten phases running

The review applied 18 mutations to load-bearing lines and killed 16. Both survivors were the
same shape as ever — a compensation and an undo that no test could observe — and were found
only because someone broke the line and looked.

What is new is where the worst finding lived. It was not an untested line; it was a **correctly
tested line whose test asserted the wrong thing**. The rollback tests all passed, because they
checked that the tunnel was deleted — which is right when the tunnel was created and exactly
wrong when it was adopted. The test encoded the happy path's expectation and the code matched
it. Finding it needed someone to ask a question no test was asking: *whose tunnel is this?*
