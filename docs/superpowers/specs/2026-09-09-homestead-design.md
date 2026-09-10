# Homestead — Design

**Date:** 2026-09-09
**Status:** Approved for planning
**Scope:** Whole system. Implementation is phased (see [Phasing](#phasing)).

---

## 1. Overview

Homestead manages self-hosted applications on a Docker host. An **App** is a Docker Compose
stack in its own directory, optionally exposed to the internet through a Cloudflare Tunnel
and protected by a Cloudflare Access application.

Homestead does three things:

1. **Manages stacks** — adopts existing compose directories, authors and edits `compose.yaml`
   and `.env`, and runs lifecycle operations (`up`, `down`, `restart`, `pull`).
2. **Monitors them** — a per-app diagnostic ladder of container status, internal HTTP reachability,
   and external HTTP reachability through Cloudflare Access.
3. **Exposes them** — provisions tunnel ingress, DNS, and Access applications through the
   Cloudflare API, including managing the `cloudflared` container itself.

It serves two audiences: an **admin** who operates the infrastructure, and **viewers** who
only need to know whether things are working and to click through to them.

### Deployment target

Primary host is a UGREEN NAS with stacks under `/volume2/docker/<app>/compose.yaml`, one
directory per app. Homestead runs as a container on that machine. A second host (a VM) is
anticipated but not present; the design keeps a host abstraction so adding one is a new
implementation rather than a refactor.

### Non-goals

- Resource metrics / time-series charting (CPU, memory, disk over time). Prometheus does this better.
- Notifications and alerting. Deliberately deferred; see [Phasing](#phasing).
- Web-based interactive shell (`docker exec`). Explicitly rejected: many images ship no shell,
  and it is effectively host root reachable from a phone. Replaced by a read-only container
  detail panel.
- Kubernetes, Docker Swarm, or any non-Compose orchestrator.
- Managing hosts Homestead does not have Docker socket access to.

---

## 2. Architecture

**Single Node process, hybrid Docker access.** One Fastify process serves the JSON API and the
Vite-built SPA. Everything that touches the machine goes through a `Host` interface.

The defining decision is splitting Docker reads from writes:

- **Mutations** shell out to the real `docker compose` CLI. Compose semantics are deep —
  `depends_on` with `condition: service_healthy`, profiles, `extends`, override merge order,
  network and volume naming. The CLI is the only correct implementation of them, and Homestead
  must behave identically to stacks the user starts by hand over SSH.
- **Reads** use the Docker Engine API via `dockerode` over the socket: structured JSON for
  state and health, and real streams for logs.

### Rejected alternatives

**Pure Engine API (reimplement compose).** Slimmer image, uniform code path. Rejected: this is
rebuilding Compose and will be subtly wrong indefinitely. The failure mode is stacks that behave
*almost* like hand-started ones, diverging during an outage. Directly conflicts with the
requirement to adopt stacks maintained by hand.

**Control plane + per-host agent.** Makes multi-host trivial. Rejected for now: two deployables,
an agent transport, agent auth, and version-skew handling — real cost today for a host that does
not yet exist. The `Host` interface is this design's seam; promoting it to a wire protocol is a
later, contained change.

### Stack

Per the user's global defaults, greenfield web:

| Area | Choice |
|---|---|
| Layout | Single package, `src/{web,server,shared}`, `@shared/*` path alias |
| Package manager | pnpm |
| Language | TypeScript, ESM, `strict: true`, `moduleResolution: bundler`, `target: ES2022` |
| Frontend | Vite + React, react-router-dom v6, TanStack Query v5, Tailwind |
| Backend | Fastify |
| DB | SQLite (libSQL) + Drizzle |
| Auth | Better-Auth + a custom Cloudflare Access plugin |
| Editor | CodeMirror 6 |
| Backend build | tsup (ESM, node target) |
| Tests | Vitest; Playwright optional for e2e |
| Lint/format | Biome |
| Hosting | Self-hosted Docker, multi-stage build on current Node LTS Alpine |

---

## 3. Domain model

Tables are SQLite via Drizzle. `id` columns are text ULIDs unless noted.

### `hosts`

`id, name, kind('local'), composeRoot, dockerSocket, createdAt`

One seeded row (`local` → `/volume2/docker`, `/var/run/docker.sock`). Exists so that no
downstream code assumes a single machine.

### `apps`

`id, hostId, slug, displayName, description, iconRef, category, sortOrder, showOnLauncher,
directory, composeFile, projectName, launchInternalUrl, lastComposeHash, isSystem,
graceUntil, adoptedAt, archivedAt`

Three separate identifiers, deliberately not collapsed: `directory` is the on-disk path segment,
`projectName` is what Docker labels containers with, and `slug` is the URL identity. They are
usually the same string and must not be assumed to be — renaming an app's display identity
should not require moving a directory or recreating containers.

Notable fields:

- **`projectName` is stored, not derived.** Compose normalises the directory name
  (`/volume2/docker/My Media` → project `mymedia`) and a `COMPOSE_PROJECT_NAME` in `.env`
  overrides it entirely. Every container lookup filters on
  `label=com.docker.compose.project=<projectName>`; guessing wrong reports a healthy stack as
  stopped. Resolved at adoption in priority order: `.env` → normalised directory name.
- **`lastComposeHash`** guards on-disk drift (SHA-256 of file bytes). The file is the source of
  truth; the editor submits the hash it loaded and the write is rejected if the file changed
  underneath, so edits made over SSH are never silently clobbered.
- **`launchInternalUrl` is separate from any probe target.** The launcher wants the UI root;
  a probe wants whatever is cheapest to hit. Collapsing them means polling a heavyweight
  dashboard route every 60 seconds.
- **`isSystem`** marks the managed `cloudflared` stack so it cannot be casually deleted.
- **`graceUntil`** suppresses down-reporting after a user-initiated lifecycle action.

### `probes`

`id, appId, kind('docker'|'http_internal'|'http_external'), label, target,
expectedStatusPattern, timeoutMs, intervalSeconds, insecureTls, followRedirects, enabled,
nextRunAt, consecutiveFailures`

Denormalised current state on the same row: `lastStatus, lastLatencyMs, lastDetail,
lastFaultClass, lastCheckedAt, statusSince`.

- One `docker` probe per app, created on adoption.
- Zero or more `http_internal` probes, user-configured. Multiple are supported deliberately:
  an \*arr stack has four web UIs and one URL per app under-reports it.
- Exactly one `http_external` probe, created and destroyed with the exposure.

`expectedStatusPattern` is a comma-separated list of literal codes and `Nxx` classes — e.g.
`2xx,3xx` or `200,204,301`. All numeric defaults in this document (60s interval, 2-failure
threshold, 120s grace, 48h / 90d retention) are per-install settings with these as their
shipped values; only the two-tier retention *structure* is fixed.

Denormalising current state means the launcher and dashboard are a single indexed query with
no aggregation. It is safe because exactly one writer — the scheduler — updates the probe row
and `check_results` in the same transaction.

### `check_results` and `check_rollups`

Two-tier retention, because storing every sample indefinitely does not survive arithmetic:
20 apps × 3 probes at 60s is ~2.6M rows/month, and a 30-day timeline query would scan all of it.

- **`check_results`** — `id, probeId, status, faultClass, latencyMs, detail, checkedAt`.
  Every sample, retained **48 hours**. Powers latency charts and precise recent scrubbing.
- **`check_rollups`** — `probeId, hourStart, upCount, degradedCount, downCount, avgLatencyMs,
  maxLatencyMs`. Retained **90 days**, ~43k rows total. Powers uptime % and the 30-day timeline.

This is the downsampling pattern behind RRDtool and Prometheus: the questions change with age.
Recent data is asked "what was latency at 14:32"; old data is only ever asked "what fraction of
that day was it up".

### `exposures`

`id, appId, hostname, zoneId, dnsRecordId, tunnelId, ingressService, accessAppId, accessAppAud,
state('provisioning'|'ready'|'error'|'drifted'), lastError, lastSyncedAt`

Plus three ownership flags — `dnsRecordCreatedByUs`, `ingressRuleCreatedByUs`,
`accessAppCreatedByUs`. Zero or one exposure per app. Deprovisioning consults these and only
ever deletes resources Homestead recorded creating; an adopted DNS record or Access application
made by hand is left alone.

### `users` and `user_app_scope`

`users`: `id, email, name, passwordHash?, role('admin'|'viewer'), scopeAllApps, disabledAt`
(plus Better-Auth's own `session` / `account` / `verification` tables).

`user_app_scope`: `userId, appId`.

- `passwordHash` is nullable so an Access-only user can exist without one.
- **`scopeAllApps` is an explicit boolean**, not inferred from an empty allowlist. Otherwise
  "all apps" and "no apps" are the same state and a suspended viewer is inexpressible. It also
  makes the check a cheap predicate: `scopeAllApps OR app.id IN (:appIds)`.
- New apps automatically appear for `scopeAllApps` users and never for allowlisted ones, which
  is what "default to all" actually means.

### `jobs`

`id, appId, kind, status, startedAt, finishedAt, exitCode, userId, output` — `output` holding the
captured stdout/stderr, truncated to a cap and pruned with the same retention job that trims
check results. `docker compose pull` on a large stack runs for minutes; it cannot be an HTTP
request.

### `audit_log`

`id, userId, authPath, action, targetType, targetId, detail, ip, createdAt`

Every lifecycle action, config write, secret reveal, user change, and Cloudflare mutation.

### `secrets`

`key, ciphertext, iv, tag` — AES-256-GCM, key from `HOMESTEAD_SECRET_KEY`. Holds the Cloudflare
API token, tunnel token, and monitor service-token secret. Encrypted at rest so a leaked
`homestead.db` from a NAS backup is not immediate account compromise.

### `image_status`

`appId, serviceName, currentDigest, latestDigest, updateAvailable, checkedAt`

### `setup_state`

Singleton row tracking onboarding progress so the wizard is resumable.

---

## 4. Host and Docker layer

### The `Host` interface

Deliberately shaped like a future network boundary — async, serializable arguments, no leaked
handles:

```ts
interface Host {
  listAppDirectories(): Promise<DiscoveredDir[]>
  readTextFile(rel: string): Promise<{ content: string; hash: string }>
  writeTextFile(rel: string, content: string, expectedHash: string | null): Promise<{ hash: string }>

  listContainers(filters: ContainerFilter): Promise<ContainerSummary[]>
  inspectContainer(id: string): Promise<ContainerInspect>
  streamLogs(opts: LogOptions): AsyncIterable<LogLine>

  runCompose(app: App, args: string[]): JobHandle
}
```

`LocalHost` is the only implementation. Nothing above the interface knows whether the machine
is local.

### Path confinement

Every path is resolved with `realpath` **before** the prefix check against `composeRoot`, and
the write target's parent is re-resolved before writing. A plain
`path.resolve(root, rel).startsWith(root)` is insufficient: `/volume2/docker` is a
user-writable NAS share, so anyone with SMB access can place a symlink pointing at `/etc` whose
resolved *string* still sits under the root. Relative paths from clients are additionally
validated against the adopted app set rather than accepted free-form.

### Adoption

A scan joins two independent sources: directories under `composeRoot` containing
`compose.yaml` / `compose.yml` / `docker-compose.yml`, and containers carrying
`com.docker.compose.project` labels.

| Directory | Containers | Meaning |
|---|---|---|
| yes | yes | Adoptable, currently up |
| yes | no | Adoptable, currently down |
| no | yes | Orphan — running stack whose files moved or were deleted |

Adoption is explicit per app, with select-all, and resolves `projectName` first. It is strictly
read-only with respect to the user's files.

### Status rollup

The **expected service set** comes from `docker compose config --format json`, cached and
invalidated by the compose file hash. Using the CLI here is what makes profiles, `extends`,
override files, and `${VAR}` interpolation resolve correctly. The same call doubles as the
editor's semantic validator.

**Live state** comes from `dockerode`. Per expected service:

| Container condition | Service status |
|---|---|
| running + `healthy`, or running with no healthcheck | **up** |
| running + `starting`, or `created` | **starting** |
| `restarting` | **degraded** (crash loop) |
| exited `0` with `restart: no` | **completed** |
| exited non-zero, `unhealthy`, `paused`, or absent | **down** |

Roll up: any down/absent → `down`; else any starting/restarting → `degraded`; else `up`.
Services gated behind an inactive profile are excluded from the expected set.

Treating exited-0 one-shot containers as **completed rather than down** is deliberate — init
and migration containers are normal, and reporting them as failures would make most real stacks
permanently red. The accepted cost is that a service which crashes and then exits cleanly reads
as fine.

### Lifecycle

Actions become `jobs`. `runCompose` spawns via `execFile` with an **argument array, never a
shell string**. A per-app mutex prevents a `pull` and a `down` from racing. Output streams to
the browser over SSE and is persisted to the job record.

After any lifecycle job the app's `graceUntil` is set (default 120s), during which probe
failures render as `starting`.

### Logs

Engine API with `follow`, a bounded ring buffer, and drop-oldest backpressure so a phone on
poor LTE cannot balloon server memory.

**The stream must be demultiplexed.** When a container has no TTY, Docker interleaves stdout
and stderr on one connection, framing each chunk with an 8-byte header (1 byte stream type,
3 padding, 4-byte big-endian length). Treating it as text injects control bytes into log lines.
The code checks `Config.Tty` from inspect and demultiplexes accordingly.

### Container detail panel

Read-only, replacing the rejected web terminal: resolved image and digest, env vars (masked),
mounts, ports, networks, restart policy, exit code and OOM flag, health-check history with
recent probe output. Works identically on distroless images.

### `.env` handling

Parsed preserving order and comments for lossless round-tripping. **Values are masked in every
API response by default**; unmasking is a separate admin endpoint that writes an audit entry.
Viewers never receive the file at all — absent, not masked.

### Image update detection

Registry manifest digests are queried directly — the `WWW-Authenticate` challenge → token →
`HEAD` manifest flow, with `Accept` headers covering multi-arch manifest lists — and compared
against the local image's `RepoDigests`. This detects updates without downloading layers. Runs
daily to stay well inside registry rate limits.

---

## 5. Monitoring

### Scheduler

An in-process tick every 5s selects probes where `nextRunAt <= now`, runs them through a
concurrency limiter (~8), and sets `nextRunAt = now + intervalSeconds ± 10% jitter`.

`nextRunAt` lives in the database rather than in `setInterval` handles so probes can be created
and deleted at runtime, intervals can differ, and restarts resume without a stampede. Jitter
prevents 60 probes created in one adoption pass from firing in the same second forever.

All docker probes in a tick share **one** `listContainers({ all: true })` snapshot indexed by
project label — one Engine API call for the whole host, not one per app.

### Probe interface

```ts
interface ProbeRunner {
  kind: ProbeKind
  run(probe: Probe, ctx: ProbeContext): Promise<ProbeResult>
}

type ProbeResult = {
  status: 'up' | 'degraded' | 'down'
  latencyMs?: number
  detail?: Record<string, unknown>
  faultClass?: 'app' | 'network' | 'config'
}
```

`faultClass` is what turns three signals into a diagnostic ladder rather than three dots, and it
is what the UI spends to say "the app is fine, your tunnel isn't".

### Runners

**`docker`** — the rollup above, from the shared snapshot.

**`http_internal`** — `fetch` with an `AbortSignal` timeout, `redirect: 'manual'`, configurable
accepted-status pattern (default `2xx,3xx`), optional `insecureTls` for LAN self-signed certs,
capped body read. Probe creation suggests targets from the compose file's published ports.

**`http_external`** — GET the public hostname with `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers, classifying rather than asserting `res.ok`:

| Observation | Status | `faultClass` |
|---|---|---|
| Expected 2xx/3xx from origin | up | — |
| Redirect to `*.cloudflareaccess.com` | degraded | config — service token rejected or policy missing |
| Cloudflare 502 / 503 / 1033 | down | network — tunnel disconnected or origin unreachable |
| DNS resolution failure | down | config |
| Timeout | down | network |

**`redirect: 'manual'` is load-bearing.** When Access rejects a request it redirects to the team
login page, and that login page returns `200 OK`. A monitor using default `fetch` behaviour
follows the redirect, sees 200, and reports the app up indefinitely — even with the origin dead.

### Thresholds and grace

Default **2 consecutive failures to go down, 1 success to recover** — asymmetric because the
"action" triggered by a failure is a human looking at their phone, so a false alarm costs more
than 60 seconds of delayed detection. `statusSince` moves only on a confirmed transition, so the
timeline records real outages rather than packet loss.

The post-lifecycle grace window means a restart you initiated is never reported as an outage.

### Persistence and fan-out

Each result writes `check_results` and updates the denormalised `probes` state in **one
transaction**. An hourly job aggregates the previous hour into `check_rollups`, prunes raw
results past 48h and rollups past 90d, and catches up on startup after downtime.

`/api/events` (SSE) emits **transitions only**, filtered server-side by the same scope predicate
the REST queries use.

---

## 6. Cloudflare

*Phase 2. Facts below verified against Cloudflare docs on 2026-09-09.*

### Credentials

One account-owned API token plus account ID, encrypted at rest. Required permissions:

| Scope | Permission | Level | Needed for |
|---|---|---|---|
| Account | Cloudflare Tunnel | Edit | Create/adopt tunnel, write ingress rules |
| Account | Access: Apps and Policies | Edit | Create Access applications and the monitor policy |
| Account | Access: Service Tokens | Edit | Create and rotate the monitor token |
| Zone | DNS | Edit | CNAME to `<tunnel-id>.cfargotunnel.com` |
| Zone | Zone | Read | List zones for selection |

Account-owned tokens are created at **Manage Account → Account API Tokens**, **require Super
Administrator** on the account, carry a `cfat_` prefix, and support an optional expiry date.

### The managed `cloudflared` stack

Homestead creates or adopts **one remotely-managed tunnel** (`config_src: "cloudflare"`), so
ingress lives in Cloudflare's API and the container never needs a local config file or a restart
when an app is exposed. This is what defuses the self-lock hazard: the config Homestead mutates
most often is not one it owns locally, and the file it owns locally never changes.

It then writes `/volume2/docker/cloudflared/` as an ordinary Homestead-managed app running
`cloudflare/cloudflared` with `tunnel --no-autoupdate run`, tunnel token in its `.env`. It
appears on the dashboard with a docker probe and logs, flagged `isSystem`.

### cloudflared networking

cloudflared runs with **`network_mode: host`**, and `ingressService` is
`http://localhost:<published-port>`.

This follows from a requirement that holds independently of Cloudflare: **apps publish their
ports so other devices on the LAN can reach them directly** — a TV streamer hitting Jellyfin, a
phone reaching Home Assistant. Given published ports exist anyway, routing the tunnel through
them costs nothing and keeps the promise that adopting a hand-maintained stack changes nothing
about it. Container-name origins were considered and rejected: they would require an additive
compose edit and a container recreate per app, and their main advantage — an app needing no
published port — is void when ports are published for LAN clients regardless.

The same published ports serve three consumers: LAN devices, the `http_internal` probe, and the
launcher's internal URL. One fact about an app rather than three.

Two consequences, accepted:

- The tunnel container can reach anything on the NAS and its LAN, so **the ingress rule list is
  the effective boundary** on what is exposed. Homestead owns that list exclusively.
- Externally exposed apps remain reachable on the LAN without passing through Access. This is
  intended: Access protects the internet-facing path, not the local network.

Host networking also means non-Docker services on the NAS can be exposed through the same tunnel
if wanted, since cloudflared can address any local port.

### Exposing an app

Four steps, run as a recorded job, each idempotent, with reverse-order rollback on failure:

1. **Ingress** — read tunnel config, splice `{ hostname, service }` before the trailing
   `http_status:404` catch-all, PUT it back.
2. **DNS** — create a proxied CNAME to `<tunnelId>.cfargotunnel.com`, store the record ID.
   Cloudflare only auto-creates this from the dashboard; via API it is ours to create and clean up.
3. **Access application** — `type: self_hosted`, `domain: <hostname>`, policy list containing the
   chosen human policy plus the shared monitor policy **by ID**. Store the app ID and `aud`.
4. **Probe** — create the `http_external` probe.

**All tunnel-config writes are serialised behind a single mutex, with a re-read immediately
before each PUT.** There is no "add one ingress rule" endpoint — the entire array is replaced.
Two concurrent provisions would each read the old array, each append their own rule, and the
second PUT would silently erase the first app's hostname. This is a correctness bug, not a
performance concern.

### One service token, one reusable policy

Homestead creates a single `Homestead Monitor` service token and a single **reusable**
`non_identity` policy including it (`include: [{ service_token: { token_id } }]`), attached to
every provisioned app as `{ "id": "..." }`. One token and one policy for N apps, so rotation is
a single operation.

**Service tokens expire** — the API returns `duration: "8760h"` and a concrete `expires_at`.
A year after setup every external probe would begin failing simultaneously with nothing actually
broken. Homestead surfaces `expires_at` with advance warning and supports rotation via
`client_secret_version`. The Section 5 classifier makes the failure legible: a mass expiry reads
as "service token rejected — config fault" across every app at once, an obviously different
shape from a real outage.

### Deprovisioning, adoption, drift

Deprovisioning reverses all four steps and **only deletes resources Homestead recorded
creating** — an adopted DNS record made by hand is left alone.

Existing tunnels, ingress rules, and Access applications are scanned and offered for adoption by
hostname match. A periodic reconcile compares recorded state against live Cloudflare state and
**flags drift in the UI rather than silently correcting it**; a tool that fights dashboard edits
is worse than one that reports them.

---

## 7. Auth and RBAC

### Two sign-in paths, one session

Both paths terminate in the same Better-Auth session cookie, so there is exactly one
authorization path downstream and no parallel auth system.

**Password.** Standard Better-Auth email/password.

**Cloudflare Access.** A custom Better-Auth plugin endpoint. On a request carrying
`Cf-Access-Jwt-Assertion` with no active session it:

1. Fetches the team JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), cached
   with refresh-on-unknown-`kid`.
2. Verifies the **signature**, `iss`, `exp`, and that **`aud` equals Homestead's own Access
   application AUD**.
3. Looks up the user by the token's email; if present and not disabled, mints a session via
   `internalAdapter.createSession` + `setSessionCookie` — the same internals Better-Auth's admin
   plugin uses for impersonation.
4. Unknown email → **rejected, no auto-provisioning** by default. A setting can enable
   auto-creation as a viewer.

Result: SSO over the tunnel, password on the LAN, and a Cloudflare outage never locks the admin
out of their own dashboard.

**The Access path is inert until configured.** It activates only when a team domain and an
audience tag are both present; with either absent the plugin does not register its hook and
`Cf-Access-Jwt-Assertion` is ignored entirely. Phase 1 therefore ships password auth plus the
dormant plugin, and Phase 2 turns it on once Homestead's own Access application exists. Failing
closed on missing configuration is the correct default anyway: a half-configured Access path
that accepted unverifiable tokens would be strictly worse than no Access path.

**Verifying `aud` is not boilerplate here.** Homestead's purpose is running many Access
applications in one account, all issuing tokens signed by the same team keys with the same
issuer. A user allowed into Jellyfin holds a genuinely valid Access token; without an audience
check they could present it to Homestead and assume whatever their email maps to. The `aud`
claim is the only thing binding a token to the application it was minted for.

Header presence alone is never trusted — Homestead is reachable on the LAN by design, so an
unverified header would let anyone on the network forge an identity.

### Roles and scope

`role` is a Better-Auth `additionalField` declared **`input: false`**. Additional fields are
writable from API input by default, so a plain field would let a sign-up or profile-update body
containing `"role": "admin"` self-promote.

A Fastify `preHandler` builds `AuthContext { userId, role, scopeAllApps, appIds }`. Every
app-reading query composes `scopeAllApps OR app.id IN (:appIds)` — **including the SSE fan-out**,
which is the path most likely to drift from the REST path. A single
`can(ctx, capability, appId?)` helper backs the capabilities: `app:read`, `app:config`,
`app:lifecycle`, `app:secrets`, `cf:write`, `user:manage`.

### Viewer capability

Viewers see, for apps in scope: name, description, icon, launch link, current status, the three
signals, and uptime history. They cannot see compose YAML, `.env`, logs, container details, or
image state, and cannot perform any lifecycle or configuration action.

**Viewers receive a different serializer, not a filtered one.** The viewer DTO is a distinct
type on which compose, `.env`, and log fields do not exist. Field-stripping fails open the day
someone adds a property; a separate projection fails closed.

### Hygiene

First run with zero users serves a one-time setup wizard that creates the initial admin and then
permanently disables itself. Login is rate-limited. Every audit row records which path
authenticated the actor.

**Homestead is reachable at two origins by design** — an internal LAN URL and, optionally, an
external hostname through the tunnel — and this constrains cookie configuration:

- Cookies are httpOnly and `SameSite=Lax`. **`Secure` is conditional on the request actually
  being HTTPS**, which is Better-Auth's default behaviour; `advanced.useSecureCookies` must not
  be forced on. Browsers do not send `Secure` cookies over plain HTTP, and while
  `http://localhost` is treated as a secure context, a LAN address such as
  `http://192.168.1.5:8080` is not — forcing the flag would make LAN logins fail silently, which
  is precisely the access path the dual-auth design exists to protect.
- **Both origins must be registered in `trustedOrigins`**, or Better-Auth's origin check rejects
  whichever one is missing.
- Client IPs come from `advanced.ipAddress.trustedProxies` with `CF-Connecting-IP` among the
  trusted headers, so audit entries record the real client rather than the tunnel — while LAN
  requests, which carry no such header, still record their true source.

If Homestead is never exposed externally, the Access path simply stays dormant and password auth
over the LAN is the whole system.

---

## 8. Frontend

Three distinct surfaces, because consumption and administration are different jobs.

| Route | Audience | Purpose |
|---|---|---|
| `/` — Launcher | everyone; the only route viewers have | Homepage-style card grid. Glance at status, click to open the app. |
| `/apps` — Admin inventory | admin | Add, adopt, edit, delete. |
| `/apps/:slug/*` — Edit | admin | Sticky header, tabs as routes, desktop right rail. |

### Launcher

Grouped card grid — icon, display name, description, status phrase — 2-up on phone, 3–5 across
on desktop. Live search.

**The status line carries the cause, not a duration, whenever something is wrong**:
"Tunnel unreachable — app is fine · 12m" rather than "Degraded · 12m". Healthy cards read simply
"Healthy", staying visually quiet so anything broken is the only thing with contrast on screen.
This is what recovers most of the fault localisation that a single rolled-up indicator would
otherwise discard, at zero cost in height.

- **Card click launches the app. The status chip is a separate tap target** opening a bottom
  sheet (mobile) or popover (desktop) with the three signals and a 30-day sparkline. Checking
  health never risks launching something.
- **A tile opens the external URL whenever the app has one**, falling back to
  `launchInternalUrl` only for apps with no exposure. The link is therefore a property of the
  app, identical for every user on every network — so a bookmark, a shared link, or a
  home-screen shortcut behaves the same everywhere, and no server-side branching on how the
  request arrived is needed. The internal URL stays available from a long-press / context menu.
- The cost is that during a Cloudflare or internet outage, tiles for exposed apps point at a
  path that is down while the app itself is reachable on the LAN. The context menu is the manual
  escape hatch. Automatically swapping the href when the external probe is failing and the
  internal one is passing is a natural extension, deliberately left out of scope for now — it
  makes a tile's destination vary with monitoring state, which is a bigger behavioural change
  than it first appears.
- **Down apps stay clickable, visibly dimmed.** Greying out a tile because a probe failed is
  maddening when the probe is what is broken.
- **The launcher must not depend on the monitoring pipeline being healthy.** Tiles come from one
  cheap indexed query on the denormalised `probes` columns; status arrives afterwards over SSE.
  A wedged Docker socket or a slow Cloudflare API must not degrade the screen whose job is to
  reach Jellyfin.

### Admin inventory

Dense table on desktop — name, status, exposure hostname, image-update count, last deploy, row
actions — collapsing to compact rows on mobile. Two distinct entry points: **Create app** (new
directory, scaffolded compose) and **Adopt from disk** (multi-select scan).

### Edit page

Sticky status header. Tabs are routes: `overview`, `containers`, `compose`, `env`, `logs`,
`exposure`. Bottom action bar on mobile; persistent right rail on desktop carrying actions,
exposure, image updates, and metadata.

Tabs are the data-loading boundary: the compose file, container inspect data, and log stream
load on demand and close on navigate, rather than being produced because someone glanced at
status.

### Live updates

**One `EventSource` for the whole app**, mounted at the shell. Events carry
`{ appId, probeId, status, faultClass }` and are applied with `queryClient.setQueryData` —
patching cached rows, not refetching. Twenty apps flapping during a `docker compose up` must not
fire twenty round-trips at a machine that is by definition busy at that moment; this is why the
event payload is self-sufficient rather than an ID to look up. Job output and log streams get
their own short-lived SSE connections scoped to their route.

### Compose editor

CodeMirror 6 with `@codemirror/lang-yaml` — roughly an order of magnitude smaller than Monaco
and usable on touch.

**Autocomplete, desktop only** (gated behind `(pointer: fine)` and a width check; on touch,
completion popups fight the virtual keyboard). Four sources:

| Source | Offers |
|---|---|
| Compose JSON Schema | Valid keys at the cursor's YAML path; enum values; schema `description` as hover text |
| Current document | Service names for `depends_on`; declared volumes and networks where referenced |
| Sibling `.env` | On `${`, the keys actually defined for that stack, flagging undefined ones |
| Registry *(deferred)* | Available tags on `image:` — rate-limit sensitive |

The schema is `schema/compose-spec.json` from `compose-spec/compose-spec` (verified: JSON Schema
draft 2020-12, 76 KB, `$defs.service` has 93 properties of which 89 carry descriptions, so hover
docs come free). It is **vendored at build time at a pinned commit**, not fetched at runtime —
the NAS may be offline and an upstream edit should not silently change editor behaviour.

**Lint is two-layer.** Client-side YAML parse plus schema validation for instant feedback, and a
debounced server round-trip to `docker compose config` for semantics. The schema cannot know
that `depends_on: [databse]` references an undefined service or that `.env` is missing a
variable; only resolution can. Schema-only feels responsive and lets real breakage through;
server-only is correct but laggy per keystroke.

The `.env` editor is a masked key/value table with reveal-per-row (audit-logged) plus a raw mode
for bulk paste.

### Icons

Sourced from **homarr-labs/dashboard-icons** (verified live: `metadata.json` indexes 3,238 icons
with aliases and categories; kebab-case slugs; `-light` / `-dark` theme variants; jsDelivr CDN).

**Homestead proxies and caches icons rather than hotlinking.** `metadata.json` is 1.15 MB, far
too large to ship to the browser, so the server fetches, caches, and exposes
`/api/icons/search?q=`. Icon files are cached to disk on first use. Beyond size, hotlinking would
tell a public CDN exactly which self-hosted services the user runs, from viewers' networks — an
odd disclosure for a tool premised on not handing infrastructure to third parties — and caching
means the launcher renders during an internet outage, precisely when reaching LAN services
matters most.

On adoption the directory name is matched against slugs and aliases to pre-fill a suggestion.
Fallbacks: manual search, custom upload, generated letter tile. Theme variant follows
`prefers-color-scheme`.

### Cross-cutting

- **PWA manifest, `display: standalone`.** This is a launcher; it belongs on a home screen.
- **Status is never colour alone** — every dot pairs with text or an icon shape.
- **Dark mode via `prefers-color-scheme`**, no toggle initially.
- **Launcher renders from cached data first**; stale status beats a spinner.

---

## 9. Onboarding

Resumable via `setup_state`; every step idempotent. Cloudflare is skippable and can be completed
later from settings.

1. **Create admin.** First account, becomes admin, closes the bootstrap route permanently.
2. **Verify host.** Confirm compose root (default `/volume2/docker`); prove the Docker socket
   works by displaying the actual `docker version` response; run the **mount round-trip
   preflight** from Section 10 and show its result. Fail loudly here rather than later during a
   deploy, when the symptom would be a stack silently starting with empty volumes.
3. **Import from disk.** The adoption scan as a multi-select table: directory, resolved project
   name, compose file, container count, running state, suggested display name and icon.
   Read-only with respect to the user's files.
4. **Cloudflare** *(skippable)*
   1. Explain what will be created and that it can be deferred.
   2. **Token** — deep link to `https://dash.cloudflare.com/?to=/:account/api-tokens`
      (Manage Account → Account API Tokens), with two warnings up front: creating an
      account-owned token requires **Super Administrator**, and these tokens support an expiry
      date — set one, and Homestead will warn before it lapses. Show the permission table from
      Section 6 as a copyable checklist, including Account Resources (this account) and Zone
      Resources (the zones to be exposed).
   3. **Validate** — one read call per capability, rendered as a per-permission pass/fail list.
      A missing scope is named on the setup screen, not discovered as a 403 mid-provision weeks
      later.
   4. **Tunnel** — list existing remotely-managed tunnels to adopt, or create one. If a
      locally-managed tunnel is detected, explain that its config lives in a file rather than the
      API and offer to leave it untouched.
   5. **`cloudflared` container** — detect a running one. If absent, show the exact compose file
      Homestead proposes writing to `/volume2/docker/cloudflared/`, require explicit approval,
      then write, start, and wait for the tunnel to report connected before advancing.
   6. **Monitor credentials** — create the service token and reusable `non_identity` policy;
      display `expires_at`.
5. **Invite users** *(skippable)* — viewers and their scope.
6. **Done** → launcher.

---

## 10. Deployment

Multi-stage Docker build on current Node LTS Alpine. The runtime image must include the
**Docker CLI and the Compose plugin**, since mutations shell out.

Mounts and configuration:

| Item | Value |
|---|---|
| Docker socket | `/var/run/docker.sock` |
| Compose root | `/volume2/docker` — **mounted at the identical path inside the container** |
| Data volume | Holds `homestead.db` and the icon cache |
| `HOMESTEAD_SECRET_KEY` | AES key for the `secrets` table |
| `HOMESTEAD_COMPOSE_ROOT` | Defaults to `/volume2/docker` |
| `HOMESTEAD_ACCESS_TEAM_DOMAIN`, `HOMESTEAD_ACCESS_AUD` | Optional bootstrap override for Access JWT verification |

Access verification settings normally live in the database, written when Homestead provisions
its own exposure in Phase 2. The environment variables exist only as an override for the case
where Homestead is placed behind an Access application it did not create. When neither source
supplies both values, the Access sign-in path stays dormant (Section 7).

### The path-identity constraint

**The compose root must be bind-mounted at the same absolute path inside the container as on the
host.** Homestead runs `docker compose -f /volume2/docker/<app>/compose.yaml`, but the Docker
daemon resolves that stack's own relative bind mounts against the **host** filesystem.

Two behaviours, both verified on the target machine, define the exact constraint:

- **Compose does not canonicalise paths.** Given a compose file under a symlinked directory, it
  emitted the bind source as `/tmp/hs-test/link/myapp/config` — the symlinked path, passed
  through verbatim. So the invariant is not "the container path must be a real directory"; it is
  **the path string Homestead emits must be meaningful on the host**.
- **The daemon resolves symlinked bind sources correctly**, reading through to the real target.

Therefore:

- **Symlinks on the host are supported.** If `/volume2/docker` is itself a symlink on the NAS,
  the daemon follows it and everything works.
- **Mounting the share at a different path inside the container is not supported.** Mounting it
  at `/data` while telling Homestead the root is `/volume2/docker` happens to work only if that
  path also exists on the host; mounting at `/data` *and* configuring `/data` emits host-invalid
  paths.

**The failure mode is silent, which is why this gets a preflight rather than documentation.**
A bind source that does not exist on the host is not an error — Docker creates an empty directory
and proceeds. A misconfigured mount therefore produces a running stack with empty config and data
volumes: Immich or Paperless come up looking freshly installed, which is indistinguishable from
data loss until someone checks.

**Startup preflight.** Before serving traffic, Homestead writes a marker file under the compose
root, launches a throwaway container binding that same path, and reads the marker back through
the daemon. If the marker is missing or the directory reads empty, the mount is misconfigured and
Homestead **refuses to start**, naming the mismatch. This catches the entire class of mount error
at boot rather than at first deploy. The same check runs as onboarding step 2.

Path confinement (Section 4) resolves `realpath` inside the container, which will differ from the
configured root when a symlink is involved; the check therefore accepts membership under **either**
the configured root or its container-resolved real path.

Homestead is a normal container and can, once running, adopt and manage itself — with the same
`isSystem` protection as `cloudflared`.

---

## 11. Testing

- **Unit (Vitest)** — status rollup classification, probe result classification (especially the
  Access redirect cases), `.env` round-tripping, compose project-name resolution, path
  confinement including symlink escapes, scope predicate composition, rollup aggregation.
- **Scheduler** — fake timers: due selection, jitter bounds, threshold transitions, grace windows.
- **Integration** — against a real Docker daemon in CI: adoption of a fixture directory tree,
  lifecycle jobs, log demultiplexing with and without TTY.
- **Cloudflare** — against a recorded/mocked API: the provisioning saga's rollback paths and the
  ingress read-modify-write mutex under concurrency.
- **Auth** — Access JWT verification: valid token, wrong `aud`, expired, unknown `kid`, forged
  header with no signature, unknown email. Role mass-assignment attempts.
- **e2e (Playwright, optional)** — onboarding happy path; launcher at mobile and desktop widths.

---

## 12. Phasing

One design document; separate implementation plans.

**Phase 1 — usable product, no Cloudflare code.**
Foundation (scaffold, SQLite/Drizzle, password auth plus the dormant Access plugin,
users/roles/scope, host abstraction), compose management (adoption, editor with autocomplete, `.env`, lifecycle, logs,
container detail, image updates), monitoring (scheduler, docker + internal probes, history,
timeline), all three UI surfaces, onboarding steps 1–3, 5, 6.

Milestone: manage every NAS stack from a phone and know whether it is healthy.

**Phase 2 — exposure.**
Cloudflare API client, `cloudflared` as a managed app, tunnel/ingress/DNS, Access apps and
policies, service token and rotation, the external probe, exposure UI, drift reconcile,
onboarding step 4.

Phase 2 slots into interfaces Phase 1 already defines: the external probe is a new `ProbeRunner`
plus a migration, not a change to the scheduler, history schema, or status UI.

**Deferred.**
Notifications with flap suppression; activating a second host; registry tag completion in the
editor; resource metrics (likely never — Prometheus does it better).

---

## 13. Decisions log

| Decision | Rationale |
|---|---|
| Full authoring + lifecycle, adopting existing directories | User maintains `/volume2/docker/<app>/compose.yaml` by hand and must keep doing so |
| Files on disk are the source of truth, not the DB | Stacks are edited over SSH; hash guard prevents clobbering |
| CLI for writes, Engine API for reads | Compose semantics are only correct in the CLI; reads need structured data and streams |
| Host modelled as a row from day one, one implementation | Second host anticipated; avoids retrofitting every query |
| Multiple internal probes per app | \*arr-style stacks have several UIs |
| 48h raw / 90d hourly rollups | ~2.6M rows/month otherwise; questions change with data age |
| No web terminal | Many images ship no shell; effectively host root from a phone |
| Read-only container detail panel instead | Most of the diagnostic value, no new risk, works on distroless |
| SSE throughout, no websockets | Nothing needs bidirectional transport once exec is gone; passes Access cleanly |
| Remotely-managed tunnel | Ingress changes need no restart, defusing the self-lock hazard |
| Apps publish host ports | LAN devices (e.g. a TV streamer) must reach apps directly, independent of Cloudflare |
| `network_mode: host` for cloudflared, `localhost:<port>` origins | Published ports exist anyway, so container-name origins buy nothing and would cost a compose edit and recreate per app |
| Startup preflight round-trips a marker file through the daemon | A wrong mount path is silent — Docker creates an empty dir — and looks like data loss |
| Cookie `Secure` conditional on HTTPS, not forced | Homestead is reachable over plain HTTP on the LAN by design; forcing it breaks LAN login |
| One shared monitor service token + reusable policy | Single rotation operation instead of N |
| Local accounts + verified Access bypass | SSO externally, password on LAN, no lockout during Cloudflare outage |
| Viewers: status and health only | Safe to hand a login to housemates; no config exposure |
| Separate viewer serializer, not field-stripping | Fails closed when fields are added |
| Launcher separate from admin inventory | Daily consumption and administration are different jobs |
| Tiles link externally whenever an exposure exists | One canonical URL per app, so bookmarks and shared links behave identically everywhere; internal URL via context menu |
| Icons proxied and cached, not hotlinked | 1.15 MB index; avoids disclosing the app inventory to a CDN; works offline |
| Compose schema vendored at a pinned commit | NAS may be offline; upstream edits shouldn't change behaviour |
