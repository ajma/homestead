# The Dashboard — Design

**Status:** approved for planning
**Supersedes:** §9 and §10 of `2026-09-05-homestead-design.md`, which this expands and amends
**Depends on:** the monitoring engine (`2026-09-06-monitoring-and-devices-design.md`) and
Cloudflare exposures (`2026-09-07-cloudflare-tunnel-and-access-design.md`)

---

## 1. Purpose

The screen you open to answer one question: is everything working?

Homestead already knows how to monitor a device and roll several checks into one
dot. This plan points that machinery at **apps** — the services you actually use —
and builds the grid that shows them.

### 1.1 Not in scope

- **Per-viewer app visibility** (§6.1 of the product design). Every viewer sees
  every app for now. The mechanism — a `sees_all_apps` flag and a grants table —
  is worth building when there is something to hide from someone, not before.
- **Icon uploads.** Slug lookup and an explicit URL cover nearly every real app.
- **Discovered containers** as an app source. Managed projects and manual rows
  only.
- Notifications, the response-time graph, and latency. Still deferred.

---

## 2. What an app is

A **target** with a status dot, from two sources:

1. **A service in a managed project** that publishes a port. Inferred, not
   declared — adopting a directory of existing stacks produces a populated grid
   with no annotation. `homestead.app.enabled: "false"` suppresses a tile for a
   database or a sidecar. **One tile per service, not per port**: a service
   publishing several uses `homestead.app.port` if present, otherwise the lowest.
2. **A manual row** — a name, a URL and an icon, with no container behind it. For
   the things Homestead does not run: a router admin page, a printer, a NAS UI.

### 2.1 Identity, and a correction

An app's key is **`project_slug:service`**, or **`manual:<id>`**. That is what
`monitors.targetId` holds.

The `monitors` table currently carries a comment saying an app is keyed by its
published host port. **That comment is wrong and this plan corrects it.** Keying
identity on a port means moving a service to a different port silently discards
its entire uptime history — the record would belong to the port, not the app.

The port remains the **join key to exposures**, which is what §9.2 of the product
design was actually about: a tile finds its public hostname through the published
port, because the exposure row deliberately stores no service name. Identity and
join key are different jobs and this plan keeps them separate.

A service **rename** does change the key, and therefore does orphan its history.
That is accepted: a renamed service is arguably a different app, and the
alternative — a stable synthetic id — means reconciling renames against a compose
file that has no stable identifier to reconcile against.

---

## 3. The `docker` monitor type

A sixth type, alongside `tailscale`, `tcp`, `http`, `dns`, `push` and
`reachability`. It reads container state and the container's `HEALTHCHECK` result
through the existing `composePs` wrapper, and **opens no socket** — `push` and
`tailscale` already established that a check need not be a network call.

Config: `{ projectSlug, service }`.

It reports **down** when the container is absent, exited, or restarting, and when
`HEALTHCHECK` reports unhealthy. It reports **up** when the container is running
and either healthy or has no healthcheck defined.

The distinction that makes it worth having: a container can be `running` and
crash-looping. Restart count over a window is the signal, and plain state hides it.

---

## 4. Auto-provisioned monitors

A project-backed app provisions its own monitors. The set depends on what there is
to check:

| Monitor | Provisioned when | Required |
|---|---|---|
| `docker` — container state | always | yes |
| `tcp` — internal published port | always | yes |
| `http` — `http://127.0.0.1:<port>` | always | yes |
| `dns` — the exposure hostname | an exposure exists | yes |
| `reachability` — the public URL | an exposure exists | **no, advisory** |

DNS and reachability need a hostname to be about, so an unpublished app gets three
monitors and a published one gets five.

**Reachability is advisory on purpose.** A Cloudflare or DNS failure means the app
is unreachable from outside; it does not mean the app is broken. Making it required
would turn every published tile red during a Cloudflare incident, which reads as
your services failing rather than theirs. It still appears in the detail as
"publicly unreachable" — real information, without conflating two different
outages.

A **manual app** provisions a single required `http` monitor against its URL.
Without one its dot would be permanently grey, which reads as broken rather than
unmonitored, and the URL is the only thing we know about it.

### 4.1 Reconciliation

The provisioned set is reconciled against `docker compose config`:

- **on project create, compose save, and delete** — so the common case is
  immediate and a new app has a dot straight away;
- **and on a periodic sweep** on the monitor runner that already ticks, to catch a
  compose file edited directly on disk.

Reconciliation is **converging, not additive**: it adds monitors for services that
gained a published port, removes those whose service or port is gone, and leaves
existing ones alone so their history survives. A monitor that outlives the port it
watches is the failure this exists to prevent.

**A monitor a user edited is not overwritten.** Changing an interval or marking one
advisory is a deliberate act; reconciliation preserves those fields and only
reconciles existence and target.

---

## 5. Status

Reuses `resolveStatus` unchanged. Green when every required monitor is up, red when
any is down, grey when none has reported. Advisory monitors are displayed and
cannot pull a tile red.

### 5.1 The confidence tier is detail text, not a colour

The product design's §10.2 defines six tiers — Verified, Responding, Degraded,
Down, Blocked, Unknown. Those are **rendered as the dot's reason**, not as six
colours:

| Tier | Earned by |
|---|---|
| Verified | `HEALTHCHECK` healthy, or a fresh push |
| Responding | HTTP answered 2xx/3xx/401/403 |
| Degraded | recent restarts, or publicly unreachable while locally up |
| Down | not running, connection refused, or 5xx |
| Blocked | probe rejected by Access |
| Unknown | nothing reported yet |

Three colours stay scannable across a grid of twenty tiles; six do not. The tier
carries the information, the dot carries the summary.

---

## 6. Tiles

**A tile links to its exposure hostname only.** No LAN URLs — a link that works
only inside the house is worse than no link, because it fails silently when you are
away. A tile with no exposure is unclickable for a viewer and offers an "Expose…"
action to an admin, which now has somewhere to go.

The tile shows: icon, name, status dot, and the dot's reason when it is not green.

### 6.1 Icons

Resolved by slug against the dashboard-icons set, or by an explicit URL. Fetched
icons are cached to `$HOMESTEAD_DATA/icons/` so a box with no outbound internet
still renders after the first fetch. A failed fetch falls back to a generated
glyph rather than a broken image.

---

## 7. The viewer's dashboard is apps only

Devices remain admin-only. A device list showing when each family member's phone
was last connected is a presence signal, and that was a deliberate decision in the
monitoring plan; the dashboard does not quietly reverse it.

So an admin sees apps and devices; a viewer sees apps. The device section is
filtered **server-side, before serialisation** — never hidden in the React router.
A viewer must not receive data it cannot see.

---

## 8. Permissions

`app` gains `create`, `update` and `delete` for managing manual apps, admin-only.
Viewers keep `app: ["read"]` and nothing more.

`src/server/auth/permissions.ts` and `src/shared/permissions.ts` are changed in
**exactly one task** and by exactly one line each. Homestead holds the Docker
socket, so an admin is root-equivalent on the host; that file is where a mistake
hands over the machine.

---

## 9. Failure modes worth naming

| Situation | Behaviour |
|---|---|
| Service renamed in compose | Old app key orphaned, history lost, new app provisioned. Accepted — see §2.1 |
| Service loses its published port | Its monitors are removed; the tile disappears |
| Compose file unparseable | Reconciliation skips that project and leaves its monitors alone, rather than deleting them on a syntax error |
| Icon fetch fails | Generated glyph; no broken image, no retry storm |
| Exposure deleted | DNS and reachability monitors removed; the tile stops linking |
| Cloudflare down | Reachability advisory goes down; tiles stay green; detail says publicly unreachable |
| No apps at all | Empty state distinguishes "no projects yet" from "projects exist but none publishes a port" |

---

## 10. Testing

- **No test starts a container, opens a socket, or reaches the network.** The
  `docker` executor takes its container state through the existing injectable
  wrapper; icon fetching takes an injectable `fetch`.
- Reconciliation is tested as a pure function over a parsed compose document and an
  existing monitor set, so the add/remove/preserve behaviour is checked without a
  daemon.
- A test asserts a user-edited monitor survives reconciliation, since that is the
  property most easily lost to a rewrite-everything implementation.
- A test asserts a viewer receives **no device data at all** from the dashboard
  endpoint — not merely that the UI hides it.
- A test asserts an unparseable compose file does not delete existing monitors.

---

## 11. Handoff to packaging

- `$HOMESTEAD_DATA/icons/` is a new directory the container image must persist.
- The icon cache is the first outbound HTTP Homestead makes on its own behalf; the
  packaging plan should note it for anyone running fully air-gapped.
