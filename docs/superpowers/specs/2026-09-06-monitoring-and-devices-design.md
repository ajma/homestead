# Homestead — Monitoring and Devices Design

> Plan 5 of the Homestead build. Predecessors: Plan 1 foundation, Plan 2 projects
> and Docker execution, Plan 3 design system and browse, Plan 4 authoring.
> Successors: Dashboard, then Packaging.

---

## 1. Purpose and scope

Homestead's dashboard is made of two kinds of thing — **apps** and **devices** — and
both need to answer one question at a glance: *is it working?* That question is never
answered by a single signal. An app is working when its container is running **and**
its port answers **and** its callback URL returns 200. A device is reachable when
Tailscale says it is connected **and** it answers on a port.

So this plan does not build "device status". It builds a **monitoring subsystem**: a
scheduler that runs checks on a timer, a log of what it observed, and a rule for
turning several signals into one indicator. Devices are its first target type. Apps
are the second, and arrive with the dashboard.

### In scope

- A monitor engine: monitors, a check runner, retries, per-monitor intervals.
- Four monitor types: `tailscale`, `tcp`, `http`, `push`.
- A check log with hourly rollups, retention, and uptime arithmetic.
- Device records — Tailscale-synced and manually added.
- A `/devices` screen: status, history bar, response-time graph, uptime figures.
- The Tailscale API key, stored encrypted.

### Not in scope

- **Notifications.** Alerting on state change is its own subsystem — providers,
  templates, throttling, and a definition of "down long enough to shout about". It
  gets its own plan.
- **Apps as monitor targets.** The engine is built generic over target type and the
  schema reserves it, but wiring apps happens with the dashboard (§9).
- **ICMP ping.** Requires `CAP_NET_RAW` in the container and fails silently without
  it. `tcp` covers everything that listens; Tailscale covers what does not (§5.4).
- **An installed agent.** The `push` monitor is a URL to curl from a cron line, not
  software to deploy.
- **Inferring "at home".** Tailscale reports connectivity, not location. Status is
  shown as Tailscale status and labelled as such (§4.2).

### Plan sequence after this document

Monitoring + Devices (this) → Dashboard → Packaging.

---

## 2. The model

```
target  (device | app)              ← the thing with a status dot
  ├── monitor   tailscale | tcp | http | push
  │     └── checks   (at, up, durationMs, error)
  └── status = rollup of its monitors' current states
```

A target's dot is **green when every required monitor is up**, red when any is down,
and unknown when none has reported yet. This is the product spec's "signal ladder"
for apps (§10 of the product design), generalised so devices get the same treatment.

### 2.1 Required and advisory monitors

Every monitor is either **required** — it gates the dot — or **advisory**: collected,
graphed and displayed, but unable to pull the target red. Default required.

Without this, one flaky signal makes a working app permanently red. The concrete case
is a host that blocks ICMP or a port that is firewalled from the Homestead box: the
service is fine, the check is not, and a user who cannot mark it advisory will delete
the monitor and lose the history instead.

### 2.2 The dot carries a reason

Red alone is not actionable. A tile shows which monitor failed, because "container
exited" and "callback timed out" lead to different places. The status resolution
returns the failing monitor, not just a boolean.

---

## 3. Data model

Four tables. `settings` and the `encrypt`/`decrypt` pair from Plan 1 are reused.

### 3.1 `monitors`

| Column | Notes |
|---|---|
| `id` | uuid |
| `targetType` | `'device'` today; `'app'` reserved for the dashboard plan |
| `targetId` | **`text`, deliberately** — see below |
| `type` | `tailscale` \| `tcp` \| `http` \| `push` |
| `config` | JSON, shape determined by `type` (§5) |
| `intervalSeconds` | per monitor |
| `timeoutMs` | per monitor |
| `retries` | consecutive failures before a down is recorded |
| `required` | false means advisory (§2.1) |
| `enabled` | |
| `nextDueAt` | driven by the runner |

**`targetId` is text, not an integer foreign key.** A device is a row with a uuid, but
an app is not: the product design (§9.2) fixes **the published host port as the single
join key across tiles, exposures and probes**, which is why an exposure row stores no
service name. A monitor for a project-backed app will key on that port; a manual app,
having no local port, is probed by URL. A text column holds both without a migration
and without `monitors` growing a nullable column per target kind.

*Consequence to carry into the dashboard plan:* if a monitor keys on a published port
and the compose file changes that port, the monitor is watching a port nothing serves
— or worse, one that something else has taken. The app-monitor sync must reconcile
against `docker compose config` on every project change, the way the device sync
reconciles against Tailscale.

### 3.2 `checks`

`monitorId`, `at`, `up`, `durationMs`, `error`. The observation log. Uptime
percentages, the history bar and the response-time graph are **queries over this
table**, never stored state.

### 3.3 `check_rollups`

`monitorId`, `hourStartedAt`, `upCount`, `downCount`, `avgDurationMs`,
`maxDurationMs`. Written by the nightly job, read for windows longer than the raw
retention.

### 3.4 `devices`

`id` (uuid), `tailscaleNodeId` (nullable — manual devices have none), `name`, `kind`
(`phone` | `laptop` | `nas` | `vm` | `other`), `notes`, `hidden`, `lastSyncedAt`, plus
the synced Tailscale fields in §4.1.

### 3.5 Current status is computed; observations are stored

The product design already sets this rule for container state — *"persisted status is
always eventually a lie"* — and it holds here. A target's dot is derived at read time
from the latest check per monitor. What is persisted is a log of what was true at a
moment, which is a different claim and does not go stale.

---

## 4. Tailscale sync

### 4.1 What is fetched

`GET /api/v2/tailnet/{tailnet}/devices?fields=all`, authenticated with an API access
token stored encrypted in `settings`. This is the first consumer of the `encrypt` /
`decrypt` pair Plan 1 built.

Per device, the fields Homestead keeps: `nodeId` (the preferred identifier — `id` is
legacy), `name` (MagicDNS), `hostname`, `os`, `addresses`, `user`, `clientVersion`,
`updateAvailable`, `tags`, `isEphemeral`, `isExternal`, `blocksIncomingConnections`,
`connectedToControl`, `lastSeen`.

### 4.2 Verified API behaviours

These were checked against the Tailscale API v2 schema, not assumed. Getting any of
them wrong produces a plausible-looking but incorrect screen.

- **`lastSeen` is omitted when the device is online.** The schema states it is absent
  if the device has never been online *or* if `connectedToControl` is true. Online-ness
  therefore comes from **`connectedToControl`**, and a list sorted by `lastSeen` would
  place every currently-connected device at the end with an undefined value.
- **`clientConnectivity.latency` is a map of DERP relay latencies**, not the device's
  round-trip time. It cannot feed a per-device response-time graph; that data comes
  from `tcp` and `http` monitors.
- **`blocksIncomingConnections`** means the device refuses connections over Tailscale,
  including pings. A `tcp` monitor against such a device will always fail. The UI warns
  when a monitor is created against one rather than letting the user debug a
  permanent red.
- **`isExternal`** devices are shared in from another tailnet; `clientVersion`,
  `created` and `updateAvailable` are empty for them.
- **`isEphemeral`** marks short-lived nodes — CI runners and the like. These are the
  devices most worth defaulting to hidden.

### 4.3 Sync is not the runner

Discovery and enrichment are separate from checking. The sync reconciles the `devices`
table against the tailnet: new nodes are inserted, known nodes have their Tailscale
fields refreshed, and departed nodes are **retained**, not deleted — their history is
the point, and a device that leaves the tailnet is exactly when you want to see when it
was last connected.

A `tailscale` monitor then reads the synced state rather than calling the API itself,
so one API call per sync yields a result row for every device regardless of count.

---

## 5. Monitor types

### 5.1 `tailscale`

Config: none beyond the device link. Up when `connectedToControl` is true at the last
sync. One sync fans out into a result row per device.

### 5.2 `tcp`

Config: `host`, `port`. Opens a socket, records connect time as `durationMs`. No
privileges required, works in any container.

### 5.3 `http`

Config: `url`, `method`, `expectStatus`, optional `expectBodyContains`. Records
response time. This is the app health probe, generalised.

### 5.4 `push`

Config: `token`, `graceSeconds`. Homestead mints a URL; something on the device curls
it on a schedule; the monitor is down when no call has arrived within
`intervalSeconds + graceSeconds`. A dead-man's switch, and the mechanism the product
design already sketched as `POST /api/heartbeat/<token>`.

A push monitor is checked by the runner like any other — it just examines a timestamp
instead of opening a connection.

### 5.5 Why not ICMP

A real ping needs `CAP_NET_RAW`, which means the deployment grows a `--cap-add` and,
without it, every ICMP monitor reports down for a reason the UI cannot explain. The
devices that listen on nothing are also the ones Tailscale already covers, and phones
routinely drop ICMP while asleep — so it would report a phone on the kitchen counter
as offline. Excluded deliberately; `tcp` covers the rest.

---

## 6. The runner

One interval loop, the codebase's first background lifecycle.

- **Tick every 10s.** Select monitors whose `nextDueAt` has passed; execute
  concurrently with a bounded pool; write one `checks` row each; set the next due time.
- **Retries are per monitor.** A failing check is retried up to `retries` times before
  a down is recorded, so a single blip does not punch a hole in the history bar.
- **Backoff.** A monitor failing repeatedly is checked less often rather than hammered
  every interval — a dead host should not generate the most traffic.
- **Timeouts are mandatory.** No check may hang the tick.
- **Explicit `start()` / `stop()`**, and it is **not started in tests**.
- **The nightly job runs on the same loop**: roll raw checks into hourly buckets, then
  prune raw rows past the retention window.

### 6.1 Retention

Raw `checks` are kept **7 days**; hourly `check_rollups` are kept indefinitely. At 60s
across ~30 monitors that is roughly 300k raw rows steady-state and ~260k rollup rows a
year — comfortable for SQLite on a NAS, and it keeps the graph queries quick.

This is fixed now because changing it later is a migration.

---

## 7. Permissions

Two new statements in `src/shared/permissions.ts`, **both admin-only**:

```
device:  ["read", "create", "update", "delete"]
monitor: ["read", "create", "update", "delete"]
```

Viewers continue to hold only `app:read`. This is a deliberate privacy decision as much
as a security one: a device list showing when each phone was last connected is a
presence signal — it says who is home and when they went to bed. Keeping it with
whoever administers the box avoids turning a household dashboard into a tracker. The
consequence is that "family dashboard" here means *an administrator's view of the
household's devices*, not something family members browse.

**This plan modifies `permissions.ts`**, which Plan 4's spec forbade. That prohibition
was specific to Plan 4, whose verbs already existed. Adding a new subsystem legitimately
adds statements — but the file is the one place in Homestead where a mistake hands over
a box that holds the Docker socket, so the change is one commit, reviewed on its own.

**Carried forward from Plan 4:** per-verb permission tests are currently impossible
because `viewerRole` holds only `app:read`, so every `project:*` guard refuses a viewer
identically and no test can tell which verb a route demands. The route exists —
`vi.mock` the permissions module with a test-local role — and this plan, which adds two
new permission families, is where that discipline should start rather than be inherited.

---

## 8. Surface

### 8.1 `/devices`

A list: status dot, name, kind, Tailscale state, last seen (or "connected now", since
`lastSeen` is absent while online). Hidden and ephemeral devices are collapsed behind a
toggle.

### 8.2 Device detail

Its monitors with individual states, the **history bar** (a row of coloured segments
over the retention window), the **response-time graph**, and uptime figures for 24h,
30d and 1y. Add and edit monitors here. Manual devices can be created, renamed,
re-kinded and deleted; synced devices can be renamed, re-kinded, annotated and hidden,
but their Tailscale fields are read-only and refreshed on sync.

### 8.3 Settings

The Tailscale API key and tailnet name, stored encrypted, with a "test connection"
action that reports how many devices were found rather than a bare success.

### 8.4 Charting

The history bar and the response-time graph are **hand-rolled SVG** — a row of rects
and a line path. This keeps the token-only design rule intact (a charting library
styles through its own props, which `design-system.test.ts` cannot police), adds no
dependency to a bundle served from a NAS, and renders correctly in both themes. The
cost is that tooltips and axis labelling are ours to write.

---

## 9. Handoff to the Dashboard plan

- `targetType` / `targetId` already accept `'app'`; no migration needed.
- Apps come from three sources (product design §9.1): managed projects, discovered
  containers carrying `homestead.*` labels, and manual SQLite rows. All three become
  targets.
- The published host port is the join key for project-backed apps; manual apps are
  probed by URL, and their public probe *is* the health signal.
- App monitors must be reconciled against `docker compose config` whenever a project
  changes, or a monitor will outlive the port it watches (§3.1).
- The dashboard renders both target types with the same dot and reason.

---

## 10. Testing

Two hazards this codebase has not faced before.

**Time.** The runner is a scheduler. Its tests take an injected clock and a fake check
executor: no real timers, no real network. The existing discipline — no test starts a
Docker container — extends to *no test opens a socket*. Retention and rollup logic is
pure over a list of rows and tests directly.

**The background lifecycle.** Tests must not start the runner; a test that does owns its
clock. The loop's tests must prove it *executes a due monitor* and *skips one that is
not due*, each verified by reverting the behaviour — not by asserting the loop was
constructed.

**Uptime arithmetic deserves the sharpest tests in the plan.** "98.2% over 30 days" is
easy to compute wrongly in ways nobody notices: gaps where the runner was stopped,
monitors created mid-window, retries counted as separate outages, rollup buckets
double-counting a boundary, or a window that straddles the raw/rollup seam. It is pure
arithmetic over rows, so it can be tested exhaustively — and it is the number that will
actually be read.

**A note on this project's recurring failure.** Twelve test weaknesses were found during
Plan 4, all of one shape, which a reviewer named precisely: *tests verify rendering,
rarely verify behavior*. Two specific traps apply here. A scheduler test that asserts a
monitor "was checked" can pass without the due-time logic working. A history-bar test
over a fixture with no outage in it cannot detect a bar that never renders red. Fixtures
must contain the state being asserted, and every new assertion should be confirmed by
reverting the behaviour it claims to pin.

---

## 11. Deferred, with reasons

- **Notifications** — its own subsystem and its own plan (§1).
- **ICMP** — capability-gated and silently failing; `tcp` covers the need (§5.5).
- **A packaged agent** — `push` gives the same coverage with a cron line.
- **"At home" detection** — Tailscale reports connectivity, not location. The
  `clientConnectivity.endpoints` field does expose LAN-range endpoints and could
  support an inference later, but it would be a guess presented as a fact.
- **Status pages, maintenance windows, certificate expiry** — Uptime Kuma features with
  no household use here.
