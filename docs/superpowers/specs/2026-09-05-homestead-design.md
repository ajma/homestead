# Homestead — Design

**Date:** 2026-09-05
**Status:** Approved for implementation planning

---

## 1. Purpose

Homestead manages self-hosted Docker containers on a home server. Everything is
organised around a **Project**, which maps to one Docker Compose file plus an
optional `.env`. A project may publish any number of its ports through a single
Cloudflare Tunnel. A dashboard presents the results as a grid of apps.

It runs on a plain Linux VM and on every major NAS (Synology, QNAP, UGREEN,
TrueNAS SCALE, Unraid), either as a native service or as a container.

### Goals

- Manage compose stacks without hiding the compose file.
- Adopt stacks that already exist on the box, without modifying them first.
- Publish selected ports through one Cloudflare Tunnel, with DNS handled.
- Report whether an app is actually working, not merely reachable.
- Support several people with different levels of access.

### Non-goals for v1

Container exec/shell, git-clone projects, multiple project roots, notification
delivery, backup/restore, and compose version history beyond snapshots. See §16.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Project** | A directory containing `docker-compose.yml`, optionally `.env`. Identified by its **slug**. |
| **Slug** | The project's directory name. Also the Compose project name for projects Homestead creates. |
| **Compose project name** | What Docker calls the stack. Read from `docker compose config`, never computed. |
| **Endpoint** | A published host port of a project. |
| **Exposure** | A binding of a host port to a public hostname on the tunnel. |
| **App** | A dashboard tile. Derived from a service, a discovered container, or a manual entry. |
| **Probe** | A configured health check. An app may have a local one and a public one. |
| **Operation** | A tracked, streamed invocation of `docker compose` (`up`/`down`/`pull`/…). |

---

## 3. Architecture

Single pnpm package, three zones, per the standing stack defaults.

```
src/
  web/        Vite + React, Tailwind, TanStack Query v5, react-router-dom v6
  server/     Fastify, Drizzle + libSQL, Better-Auth
  shared/     types and zod schemas, imported by both via @shared/*
```

TypeScript, ESM, `strict: true`, `moduleResolution: bundler`, `target: ES2022`.
Biome for lint/format. Vitest for unit and integration, Playwright for two e2e
flows. tsup builds the server; Vite builds the SPA; one Node process serves both.

### 3.1 Server module seams

Each module has one responsibility, a narrow interface, and is testable alone.

| Module | Responsibility |
|---|---|
| `docker/compose.ts` | **The only** code that shells out to `docker compose`. `up/down/restart/pull/ps/logs/config`. Owns host-path translation (§7.2). |
| `docker/engine.ts` | Read-only Engine API: event stream, container inspect, stats, image digests. |
| `projects/store.ts` | Disk CRUD: list, read, atomic write + snapshot, rename, delete. |
| `projects/compose-model.ts` | Parse canonical config → services, published ports, `x-homestead`, `homestead.*` labels. Comment-preserving YAML edits. |
| `tunnel/cloudflare.ts` | Typed Cloudflare API client. |
| `tunnel/reconciler.ts` | Desired ingress → `PUT`, behind a mutex. Drift detection. |
| `tunnel/runtime.ts` | Detect/adopt/deploy `cloudflared`. |
| `status/prober.ts` | Probe scheduling, signal ladder, status resolution. |
| `ops/registry.ts` | Operation lifecycle, SSE fan-out, per-project mutex. |
| `updates/checker.ts` | Registry digest polling and cache. |
| `auth.ts` | Better-Auth instance, access control statements, role definitions. |

---

## 4. Data ownership

| State | Home | Rationale |
|---|---|---|
| Compose YAML, `.env` | Disk | Source of truth. Portable, git-able, editable over SSH. |
| Project display name, description, icon, source | `x-homestead:` in the compose file | Travels with the project. |
| Per-app name, icon, port, path | `homestead.*` service labels | Readable from the Engine API at runtime; enables discovery. |
| Users, sessions, roles, app grants | SQLite | References users; no natural file form. |
| Cloudflare credentials, tunnel id/token, Access service tokens | SQLite, encrypted | Secrets must not sit in a copyable project directory. |
| Exposures (host port → hostname) | SQLite | A hostname belongs to the Cloudflare account, not the project. |
| Manual apps, probe config, operation history, update cache, audit log | SQLite | Instance-level. |
| Running / stopped / health / CPU / memory | **Nowhere** | Read live from Docker. Persisted status is always eventually a lie. |

### 4.1 Directory layout

```
$HOMESTEAD_DATA                  # default /var/lib/homestead
├── homestead.db                 # SQLite (must be on a local filesystem)
├── secret.key                    # 0600, generated if HOMESTEAD_SECRET_KEY unset
├── icons/                        # cached and uploaded icons
└── run/                          # generated compose overrides (ephemeral)

$HOMESTEAD_PROJECTS              # default /opt/stacks
├── jellyfin/
│   ├── docker-compose.yml
│   ├── .env
│   └── .snapshots/               # pre-write copies, last N retained
└── homestead-tunnel/            # cloudflared, if Homestead deployed it
```

`$HOMESTEAD_DATA` must not be on a network filesystem — SQLite locking is
unreliable over NFS/SMB. Homestead detects this at startup and refuses to run.

---

## 5. Project model

### 5.1 Identity

The slug is the directory name. For projects Homestead creates, it also writes
an explicit top-level `name:` equal to the slug, pinning the Compose project
name.

**Homestead never computes the Compose project name.** It reads it from
`docker compose config --format json` → `.name`. This is not a stylistic
preference: Compose derives the default name by normalising the directory name
(`My_Stack.v2` → `my_stackv2`), and `COMPOSE_PROJECT_NAME` in `.env` overrides
that. An adopted stack whose name was guessed wrong would be brought up as a
**second copy alongside the running one**. Both behaviours are verified in
§17.1.

### 5.2 Metadata in the compose file

There is no sidecar metadata file. Project-level metadata uses a top-level
extension field; app-level metadata uses service labels. Compose has no
project-level `labels` key — it is rejected by the schema (§17.2).

```yaml
x-homestead:
  schemaVersion: 1
  displayName: Media Stack
  description: Jellyfin and friends
  icon: jellyfin
  source: { kind: template, id: jellyfin }
  system: false            # true hides it from the grid and blocks deletion

services:
  jellyfin:
    image: jellyfin/jellyfin
    ports: ["127.0.0.1:8096:8096"]
    labels:
      homestead.app.name: Jellyfin
      homestead.app.icon: jellyfin
      homestead.app.port: "8096"      # container port
      homestead.app.path: /web
      homestead.app.enabled: "true"
```

Edits are made with `yaml`'s `parseDocument` so comments and formatting survive.
Every write snapshots the previous file into `.snapshots/` first.

### 5.3 Creating and adopting

Three entry points, all landing in the same YAML editor:

1. **Blank** — an empty compose scaffold.
2. **Template catalog** — a built-in set of common self-hosted apps that prefill
   compose + `.env` and prompt for the few values that matter. Templates seed the
   editor; they are not a live abstraction.
3. **Import / adopt** — paste, upload, or scan `$HOMESTEAD_PROJECTS`.

Adoption is **read-only until the user acts**. A scan lists what was found and
writes nothing. Directories with no compose file are listed as "not a project"
rather than hidden.

The scan **ignores directories whose name begins with `.`**. This matters
because a common deployment puts `$HOMESTEAD_DATA` inside the projects root
(e.g. `/volume2/docker/.homestead`), which would otherwise be scanned as a
candidate project.

Generated compose files bind published ports to `127.0.0.1` by default when the
port is intended for exposure (§7.4).

### 5.4 Rename

Renaming changes the directory name and the Compose project name, which prefixes
every container, network, and **named volume**. Bringing the stack up under a new
name would otherwise create fresh, empty volumes and appear to lose all data.

Rename is therefore an explicit migration:

1. Require the stack to be stopped. `down` never passes `-v`.
2. Show a dry run: directories moved, volumes copied, containers recreated.
3. Move the directory; update `name:`.
4. For each named volume, create the new volume and copy contents with a helper
   container (`docker run --rm -v old:/from -v new:/to alpine cp -a /from/. /to/`).
5. Bring up under the new name. Old volumes are retained, not deleted, and
   listed for manual cleanup.

### 5.5 Deletion

Requires typing the slug. `down` without `-v`; volume removal is a separate,
explicitly-checked option. Deleting a directory Homestead did not create needs
a second confirmation. `x-homestead.system: true` projects cannot be deleted
from the normal project UI.

---

## 6. Roles and access

Better-Auth with the admin plugin and `createAccessControl`, spreading
`defaultStatements` and `adminAc.statements` so built-in user management
permissions are preserved.

Two roles:

| | admin | viewer |
|---|---|---|
| See permitted app tiles, with status indicator | ✓ | ✓ |
| Start / stop / restart, read logs, view CPU/memory stats | ✓ | |
| Edit compose and `.env` | ✓ | |
| Tunnels, exposures, users, settings, updates | ✓ | |

`compose:read` is an admin permission. The compose file and `.env` are where the
passwords are, so "view configuration" is a write-equivalent privilege.

### 6.1 Per-viewer app visibility

A viewer either sees all apps or an explicit list:

- `user.sees_all_apps` boolean
- `user_app_access(user_id, app_key)` where `app_key` is `project_slug:service`
  or `manual:<id>`

If a service is renamed, the grant no longer matches and **fails closed** — the
viewer loses access rather than inheriting a different app.

**Enforcement is server-side at the action boundary.** The app list is filtered
before serialisation; a viewer never receives tiles it cannot see. Role checks
never live in the React router — a viewer who could edit a compose file could
mount `/` into a container and take the host.

---

## 7. Docker execution

### 7.1 Compose CLI, not the Engine API

All lifecycle operations shell out to `docker compose`. Compose is a
specification interpreter — profiles, `depends_on` health conditions, `.env`
interpolation, project naming, network and volume lifecycle — and
reimplementing it over the Engine API is a large, bug-prone project.

The Engine API is used only for things it is genuinely better at: the event
stream, container inspect, stats, and image digests.

Ports and volumes are read from `docker compose config --format json`, which
normalises every legal syntax to long form and resolves interpolation. Homestead
does not parse compose syntax by hand.

### 7.2 Host-path translation

Bind-mount sources are resolved **twice**: once by the compose CLI, in its own
filesystem namespace, to produce an absolute path; and again by the Docker
daemon, in the host namespace, when the container is created. The socket is an
RPC channel and performs no path translation. Containers Homestead launches are
siblings created by the host daemon, not children.

If those two namespaces disagree about what a path means, the daemon mounts the
wrong directory — or silently creates an empty root-owned one. There is no error
path. Verified in §17.3.

Two configuration variables:

```
HOMESTEAD_PROJECTS       # where Homestead reads project files
HOMESTEAD_PROJECTS_HOST  # what the daemon is told; defaults to the above
```

**When equal** (native install, or an identity-mapped container), nothing
special happens.

**When they differ**, before each compose invocation Homestead derives the
canonical config, rewrites relative bind sources to `$HOMESTEAD_PROJECTS_HOST/…`,
writes `$HOMESTEAD_DATA/run/<slug>.override.yml`, and passes it as a second
`-f`. Named volumes and already-absolute binds pass through untouched.

`--project-directory` is **not** used for this. It does redirect bind resolution,
but it also relocates client-side file reads: `.env` silently stops loading
(variables interpolate to empty strings) and relative build contexts hard-fail.
The override file moves only the value that crosses the boundary. All three
behaviours are verified in §17.4.

Only relative bind mounts are affected by any of this. Absolute binds are already
host paths; named volumes involve no host path; build contexts, `env_file`, and
`secrets: file:` are read client-side and streamed as content (§17.3).

Because Homestead-in-a-container cannot see arbitrary host paths, validation of
absolute bind mounts in the editor is **advisory, not blocking**.

### 7.3 Operations

`compose pull` on a large stack takes minutes, so lifecycle calls are not
request/response. Each becomes an **operation**: an id, a status, an SSE stream
of output, and a terminal result persisted to SQLite for history.

A **per-project mutex** serialises operations. Two concurrent `up`s on one
project is a corruption path. A single Node process means no external queue is
needed.

### 7.4 Loopback binding

Because `cloudflared` runs in the host network namespace, it can reach loopback.
A project can therefore publish `127.0.0.1:8096:8096` — invisible on the LAN,
fully reachable through the tunnel. This is the default for generated compose
files, and the UI shows a per-port indicator distinguishing *LAN-reachable* from
*tunnel-only*.

---

## 8. Cloudflare Tunnel

### 8.1 Model

One shared, remotely-managed tunnel per Homestead instance, created through the
API with `config_src: "cloudflare"`. Ingress rules are pushed from Cloudflare, so
adding a hostname requires no daemon restart.

### 8.2 Setup

1. The user supplies an API token. Required scopes: Account →
   *Cloudflare Tunnel: Edit*; Zone → *DNS: Edit* and *Zone: Read*. Homestead
   verifies it and lists accounts for selection.
2. `POST /accounts/{account_id}/cfd_tunnel` with `config_src: "cloudflare"`; then
   `GET …/cfd_tunnel/{id}/token` for the run token.
3. **Runtime detection**: `cloudflared` on `PATH` → offer a systemd unit; an
   existing cloudflared container → adopt; neither → deploy one.

A deployed `cloudflared` is itself a Homestead project, in
`$HOMESTEAD_PROJECTS/homestead-tunnel/`, with `network_mode: host`, the token
in its `.env`, and `x-homestead.system: true`. It gets logs, restart, and image
updates from the same machinery as everything else. It must live under
`$HOMESTEAD_PROJECTS` because its compose path is passed to the daemon.

### 8.3 Zones

Zones are listed live from the account (`GET /zones`, cached), not fixed at
onboarding. An exposure chooses a zone and a subdomain, so hostnames across
several domains can share one tunnel. `zone_id` lives on the exposure row.

### 8.4 Exposures

An exposure is `(project_slug?, host_port, zone_id, hostname, scheme,
no_tls_verify, label?, enabled)`.

**It does not store a service name.** With host networking the origin is
`http://localhost:<host_port>`; the port is the wiring and the service name is a
label attached to it. Storing both stores a derivation next to its source, and
they drift — rename a service, or move a port to a front-end, and the stored name
points at nothing while routing keeps working. The service name is derived at
read time from `docker compose config`. `label` is a display-only fallback for
when derivation fails.

`project_slug` is nullable: an exposure is fundamentally "host port → hostname",
so a bare host service or an unmanaged stack can be tunnelled.

`scheme` and `no_tls_verify` exist because some apps (Unifi, Proxmox) serve
HTTPS with a self-signed certificate and `cloudflared` refuses them by default.

### 8.5 Reconciler

`PUT /accounts/{account_id}/cfd_tunnel/{id}/configurations` **replaces the entire
ingress array**; there is no add-one endpoint, and the array must end with a
catch-all.

```
desired = [ …enabled exposures, { service: "http_status:404" } ]
PUT  /accounts/{acct}/cfd_tunnel/{id}/configurations
then per hostname: CNAME → {tunnel_id}.cfargotunnel.com, proxied: true
```

SQLite is authoritative; Cloudflare is a projection that gets pushed. Concurrent
edits serialise against a transaction rather than a network round-trip — a
read-modify-write over a full-replace API only narrows the race.

The reconciler **refuses to clobber**. Before each push it diffs remote ingress
against what it believes it wrote. Rules it does not recognise stop the push and
raise an adopt-or-overwrite prompt. Removing an exposure also deletes its DNS
record.

---

## 9. Apps and the dashboard

### 9.1 Sources

1. **Services in managed projects.** A tile is **inferred** for any service with
   a published port; labels only refine it. Adopting a directory of existing
   stacks therefore produces a populated grid immediately, with no annotation.
   `homestead.app.enabled: "false"` suppresses tiles for databases and sidecars.
   **One tile per service**, not per port: a service publishing several ports
   uses `homestead.app.port` if present, otherwise the lowest published port,
   and the remainder are listed on the project detail view.
2. **Discovered containers** — any running container carrying `homestead.*`
   labels, including outside `$HOMESTEAD_PROJECTS`. Deduped against (1) by
   container id; the managed record wins, since it also has lifecycle controls.
3. **Manual apps** — SQLite rows with a name, URL, and icon. No container.

### 9.2 Links

Tiles link to the **exposure hostname only**. No LAN URLs. A tile with no
exposure is unclickable for viewers and offers an "Expose…" action to admins.

**A tile finds its exposure through the port**, end to end: the service label
declares a container port, `docker compose config` maps it to a published host
port, and the exposure is keyed on that same published port. The port is the
single join key across tiles, exposures, and probes — which is why the exposure
row stores no service name (§8.4).

### 9.3 Icons

Resolved by slug against the dashboard-icons set, or an explicit URL, or an
upload. Fetched icons are cached to `$HOMESTEAD_DATA/icons/` so a box with no
outbound internet still renders.

---

## 10. Status

"Is it working" is three questions; one indicator cannot answer them. Apps have
up to two probes:

- **Health probe** — `http://127.0.0.1:<host_port>` when backed by a project.
  Cloudflare is not in this path, so there is no login-page interference.
- **Reachability probe** — the public hostname. Tests DNS, tunnel, and Access.

A manual app has no local port, so its public probe *is* the health signal.

### 10.1 Signal ladder

1. **Docker `HEALTHCHECK`** (`State.Health.Status`) — best available when
   present, because the image author defined what working means.
2. **Container state, restart count over a window, `OOMKilled`** — a container
   can be `running` and crash-looping; plain state hides that.
3. **Local HTTP probe** at `127.0.0.1:<port><path>`. A built-in catalog maps
   image name → known health path, auto-applied and admin-overridable.
4. **Public probe** through the hostname.
5. **Heartbeat push** — `POST /api/heartbeat/<token>`, a dead-man's switch. The
   escape hatch tier: right for backup jobs, irrelevant for most apps.

### 10.2 Confidence tiers

| Status | Means | Earned by |
|---|---|---|
| **Verified** | Known to work | Docker healthcheck `healthy`, fresh heartbeat, or a body match |
| **Responding** | Probably fine | HTTP answered 2xx/3xx/401/403 |
| **Degraded** | Answering but wrong | Recent restarts, slow, or publicly unreachable |
| **Down** | Broken | Not running, connection refused, or 5xx |
| **Blocked** | Probe rejected by Access | Redirect to `*.cloudflareaccess.com`; needs a service token |
| **Unknown** | No signal | Nothing to probe |

A login redirect counts as **Responding** — it proves the app booted and its
router is alive. Reaching **Verified** requires a healthcheck, a heartbeat, or a
body match; there is no way around that. Every tile names the signal that decided
its status.

### 10.3 Cloudflare failure codes

| Result | Diagnosis |
|---|---|
| `530` / error 1033 | Tunnel not connected — `cloudflared` is down |
| `502` / `504` | Tunnel healthy; `cloudflared` cannot reach the port |
| `403` → `*.cloudflareaccess.com` | Working; Access is doing its job |
| `2xx` | Healthy end to end |

1033 is a **global** failure. Homestead polls
`GET /accounts/{id}/cfd_tunnel/{id}` (which returns `status` and a live
`connections[]` array) and, when the tunnel is down, shows one banner instead of
N red dots, suppressing public-reachability status. Local health keeps reporting,
because it does not depend on the tunnel.

This suppression applies **only to hostnames on our own tunnel**. A manual app
pointing at a different tunnel returning 530 means that app is down. Probes
record whether their hostname matches one of our exposures.

### 10.4 Probing through Access

Probes may carry Access service token credentials, sent as `CF-Access-Client-Id`
and `CF-Access-Client-Secret`. Cloudflare's Service Auth policy type exists for
exactly this. An `access_service_tokens` table holds named credentials
(secret encrypted at rest), with one default and a per-app override.

The payoff is not only avoiding a false negative: authenticating past Access
returns the app's real response body, so body matching becomes possible and a
public-only app can reach **Verified**.

**Probes must use `redirect: "manual"`.** `fetch()` follows redirects by default,
so an unauthenticated probe of an Access-protected app follows
`302 → <team>.cloudflareaccess.com` and receives `200 OK` for the login page —
reporting healthy for an app it never reached. The presence of that redirect is
itself the signal that a token is missing, expired, or unauthorised.

Probes also carry `insecure_tls` for self-signed LAN origins.

### 10.5 Mechanics

Container state comes from the Docker **event stream**, not polling. HTTP probes
run on a staggered schedule with jitter, exponential backoff on failure, and
**2-of-3 consecutive-failure damping** so an ordinary restart does not flash red.
Current status lives in memory; a ring buffer of recent results is persisted for
a sparkline and uptime percentage.

---

## 11. Onboarding

`/` checks `onboarding_completed`: false → `/onboarding`, true → dashboard. Each
step commits to SQLite as it completes, so a refresh resumes.

1. **Environment check** — Docker reachable, Compose v2 present, projects root
   writable, host-path translation verified (§12.3), data dir not on a network
   filesystem. Green/red with specific remediation. Blocks only on Docker.
2. **Create the admin account.**
3. **Project location** — confirm the root, scan, show findings, offer adoption.
4. **Cloudflare** — token → account → create or adopt a tunnel → detect/deploy
   `cloudflared`. **Skippable**, re-enterable from settings.
5. **Done.**

**Step 2 is the first-run vulnerability.** An unauthenticated "create first
admin" endpoint that is only hidden in the UI hands the box — and the Docker
socket — to whoever reaches it first.

The guard is an **atomic single-winner claim**: an `INSERT … ON CONFLICT DO
NOTHING` of a unique sentinel key, whose `RETURNING` row count tells exactly one
concurrent caller that it won. That caller creates the admin; everyone else gets
`409`. If admin creation then fails, the claim is released so a legitimate retry
can proceed.

A claim is used rather than "count users inside the inserting transaction"
because Better-Auth performs the user insert through its own adapter and cannot
be enrolled in an application-level transaction. The claim gives the same
guarantee without wrapping a third-party call.

The claim is also independent of the `onboarding_completed` flag, so a corrupted
or hand-edited settings row cannot reopen the endpoint.

---

## 12. Packaging

Docker and native installs are co-equal. There is **no per-platform code** — the
differences reduce to two paths, a port, and socket permissions.

### 12.1 Container

Multi-stage Node LTS Alpine, with `docker-cli` and `docker-cli-compose` in the
runtime layer so the image carries its own Compose v2 rather than inheriting the
host's. Multi-arch build (`linux/amd64`, `linux/arm64`) — many NAS boxes are
`aarch64`.

```yaml
services:
  homestead:
    image: homestead:latest
    network_mode: host          # required: probes must reach 127.0.0.1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /volume2/docker:/volume2/docker     # identity-mapped here, so no
      - /volume2/docker/.homestead:/data   # translation is needed. To mount
                                            # elsewhere, set …_PROJECTS to the
                                            # container path and …_PROJECTS_HOST
                                            # to /volume2/docker.
    environment:
      HOMESTEAD_DATA: /data
      HOMESTEAD_PROJECTS: /volume2/docker
      HOMESTEAD_PROJECTS_HOST: /volume2/docker
```

`network_mode: host` is not optional: a bridged container's `127.0.0.1` is its
own loopback, so every local probe would fail.

### 12.2 Native

systemd unit with `EnvironmentFile=/etc/homestead.env`, running as a
`homestead` user in the `docker` group. No path translation, no parity check.
The installer **asserts Compose v2** and fails loudly if it finds only v1's
`docker-compose` binary.

### 12.3 Startup preflight

- Docker socket reachable; Compose v2 present.
- `$HOMESTEAD_DATA` writable and not on a network filesystem.
- `$HOMESTEAD_PROJECTS` readable.
- **Path translation check** (containerised only): write a nonce marker into
  `$HOMESTEAD_PROJECTS`, ask the daemon to bind-mount
  `$HOMESTEAD_PROJECTS_HOST` into a throwaway container using the Homestead
  image, and confirm the marker is visible. Fail with a specific message rather
  than proceeding.
- Listen port free.

### 12.4 Configuration

| Variable | Default | Notes |
|---|---|---|
| `HOMESTEAD_DATA` | `/var/lib/homestead` | Local filesystem required |
| `HOMESTEAD_PROJECTS` | `/opt/stacks` | Where Homestead reads files |
| `HOMESTEAD_PROJECTS_HOST` | = `HOMESTEAD_PROJECTS` | What the daemon is told |
| `HOMESTEAD_SECRET_KEY` | generated to `$HOMESTEAD_DATA/secret.key`, `0600` | Encrypts all stored secrets |
| `PORT` | configurable | Preflight checks it is free |

---

## 13. Database schema

Better-Auth owns `user`, `session`, `account`, `verification`, plus the admin
plugin's `role`, `banned`, `banReason`, `banExpires`, and `session.impersonatedBy`.

Homestead adds:

```
settings(key, value)                       -- onboarding_completed, instance_name, theme
user_prefs(user_id, sees_all_apps)
user_app_access(user_id, app_key)          -- app_key = "<slug>:<service>" | "manual:<id>"

cloudflare_config(id=1, account_id, api_token_enc, tunnel_id, tunnel_name,
                  tunnel_token_enc, runtime)          -- host | container | none
cloudflare_zones_cache(zone_id, name, fetched_at)

exposures(id, project_slug?, host_port, zone_id, hostname UNIQUE, scheme,
          no_tls_verify, label?, enabled, created_at)

manual_apps(id, name, url, icon, description, sort)

access_service_tokens(id, name, client_id, client_secret_enc, is_default)

probes(id, app_key, kind, target_url?, host_port?, path, method,
       expect_status, expect_body_contains?, access_token_id?, insecure_tls,
       interval_seconds, timeout_ms, enabled)

heartbeats(id, app_key, token UNIQUE, grace_seconds, last_seen_at)
probe_results(id, probe_id, at, tier, code?, latency_ms?, detail)   -- ring buffer

operations(id, project_slug, kind, status, exit_code?, actor_user_id,
           started_at, finished_at?, output)

image_updates(image_ref PRIMARY KEY, local_digest, remote_digest,
              update_available, checked_at)

audit_log(id, actor_user_id, action, target, detail, at)
```

---

## 14. API surface

Fastify, all under `/api`, session-authenticated. Role enforcement is a
per-route precondition, not a UI concern.

```
POST   /api/onboarding/*                  guarded by count(users)==0 where relevant
GET    /api/projects                      list (scan + cache)
POST   /api/projects                      create (blank | template | import)
GET    /api/projects/:slug                manifest, services, ports, status
GET    /api/projects/:slug/file/:name     compose | env            [admin]
PUT    /api/projects/:slug/file/:name     snapshot + atomic write  [admin]
POST   /api/projects/:slug/validate       docker compose config    [admin]
POST   /api/projects/:slug/:op            up|down|restart|pull → operation id
POST   /api/projects/:slug/rename         dry-run + migrate        [admin]
DELETE /api/projects/:slug                                          [admin]
GET    /api/operations/:id/stream         SSE
GET    /api/projects/:slug/logs           SSE, per service        [admin]
GET    /api/projects/:slug/stats          SSE, CPU/memory/uptime  [admin]
GET    /api/apps                          role-filtered tiles + status
GET    /api/apps/stream                   SSE status updates
CRUD   /api/manual-apps                                             [admin]
GET    /api/tunnel                        runtime + connection status
CRUD   /api/exposures                                               [admin]
GET    /api/cloudflare/zones                                        [admin]
CRUD   /api/probes, /api/access-tokens                              [admin]
POST   /api/heartbeat/:token              unauthenticated by design
CRUD   /api/users                                                   [admin]
```

---

## 15. Testing

**Pure unit tests**, where the logic lives:
`compose-model` (port and volume extraction from canonical config,
`x-homestead` parsing, comment-preserving label edits, host-path rewriting),
the **reconciler** (ingress construction, catch-all last, drift detection,
adopt-vs-overwrite), the **status resolver** (fixture signals → tier), slug
validation, and rename planning.

**Integration against real Docker**, behind an env flag so CI can skip:
create → `up` → status → `down`; adoption of a pre-existing stack; the project
name derivation cases from §17.1; and the path-translation override from §17.4.
These use throwaway `traefik/whoami` stacks on high ports.

**Cloudflare is mocked** at the HTTP layer with MSW, using fixtures matching the
documented API shapes. The suite needs no live account.

**Playwright** for two flows: onboarding end-to-end, and create project → expose
→ tile appears.

---

## 16. Scope

**In v1:** projects (create, edit, import, adopt, rename, delete); compose and
`.env` editing with snapshots; up/down/restart; streaming logs; health and
resource stats; image update check, pull, and recreate; tunnel exposures across
all zones in the account; dashboard with inferred tiles, discovered containers,
and manual apps; two-tier probes with Access service tokens and heartbeats;
onboarding; admin/viewer roles with per-viewer grants; container and native
packaging.

**Deferred, with reasons:**

| Item | Why not now |
|---|---|
| Container exec / shell | Highest-risk surface in the app; cut deliberately |
| Git-clone projects | Auth, branches, and `.env` conflicts are their own design |
| Multiple project roots | One root covers the target cases |
| **Notifications on status change** | Needs a delivery-channel decision (ntfy / email / webhook). Best as the next spec — a status system with no way to tell you it went red is incomplete |
| Backup and restore | Its own design |
| Compose history beyond snapshots | Snapshots cover the editor-mistake case |
| Filesystem watcher over the project scan | Drop-in upgrade if listing ever gets slow |

---

## 17. Verified behaviours

Every claim below was confirmed on Docker 29.7.2 during design. They are
recorded because each one, if assumed wrongly, produces a silent failure.

### 17.1 Compose project names are derived, not obvious

```
dir "My_Stack.v2", no name: key       → project name "my_stackv2"
same dir + COMPOSE_PROJECT_NAME=…     → project name "legacy-media"
```

Consequence: read `.name` from `docker compose config --format json`. Guessing
brings up a duplicate stack beside a running one.

### 17.2 Compose has no project-level labels; `x-` survives

Top-level `labels:` → `additional properties 'labels' not allowed`.
Top-level `x-homestead:` is echoed back by `docker compose config` unchanged.
`docker compose config` also normalises ports to
`{target, published, protocol}`.

### 17.3 Bind paths cross the namespace boundary untranslated

A container running compose against a projects directory mounted at a
*different* path caused the daemon to mount a **different host directory** of the
same name — printing `WRONG CONFIG` with no error. Where the path did not exist,
the daemon **created it on the host as root** and mounted it empty.

Unaffected: absolute binds (already host paths), named volumes (no host path),
build contexts / `env_file` / `secrets: file:` (read client-side, streamed as
content). Only **relative bind mounts** are affected — which is decisive only
because they are the dominant idiom in self-hosted compose files.

### 17.4 Override file, not `--project-directory`

| Approach | Bind mounts | `.env` | Build contexts |
|---|---|---|---|
| Identity mapping | ✓ | ✓ | ✓ |
| `--project-directory <host>` | ✓ | ✗ **silently blank** | ✗ hard error |
| Generated override file | ✓ | ✓ | ✓ |

`--project-directory` produced `MARKER=UNSET` — a silent empty-string failure,
the shape of bug that blanks a database password. An override file restating only
the bind sources in long form correctly replaced the mount by target while
leaving `.env` loading intact.
