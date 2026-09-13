# Deploying Homestead

## 1. Prerequisites

- Docker with the Compose plugin (`docker compose`, not the standalone `docker-compose`)
  installed on the NAS.
- The compose root already in use for your other stacks — for example `/volume2/docker` on
  a Synology NAS. This is the directory each managed app's `compose.yaml` and bind-mounted
  data live under.

## 2. Build

```bash
docker build -t homestead:dev . 
```

The image is a four-stage build: a full `deps` install for the build stage, a `build` stage
that runs `pnpm build`, a `prod-deps` stage that installs runtime-only dependencies *inside*
Alpine (musl, not the build host's glibc), and the `runtime` stage that copies the built
output plus that Alpine `node_modules` onto a `node:24-alpine` base with the Docker CLI and
Compose plugin installed.

## 3. Networking

`compose.example.yaml` runs the container with `network_mode: host` rather than a bridged
network publishing a port with `ports:`. This is not just about publishing — it is about what
an internal probe would actually be testing: a bridged container's `127.0.0.1` is its own
network namespace's loopback, not the host's, so an HTTP check whose target is
`http://localhost:3000` would silently test the container instead of the service it exists to
watch.

The trade-off is real: host networking means no port remapping (Homestead's `PORT` env var
*is* the host port, full stop) and a network namespace shared with the host. It is a smaller
loss than it sounds, though — the container already mounts `/var/run/docker.sock`, and a
process that can talk to that socket is root-equivalent on the host already. Host networking
does not hand over anything the socket mount had not already handed over.

### Host networking also widens what a probe can reach

Host networking is not free from a probe's point of view: a probe's target is a URL the
server fetches, and on host networking that fetch can reach host-local services and, on a
cloud host, the 169.254.169.254 link-local metadata endpoint — an SSRF primitive with a wider
blast radius than a bridged network would allow.

**Why that is acceptable today:** setting a probe target requires `app:config`
(`src/server/routes/probes.ts`), and `app:config` is admin-only — `src/server/auth/context.test.ts`
asserts a viewer does not have it. An admin who could misuse a probe target already holds
`app:compose` and `app:lifecycle`, i.e. they can write arbitrary compose YAML and deploy it
through the same mounted Docker socket, which is root-equivalent by construction (above).
Host networking hands such an admin no capability they lack by a far more direct route. The
argument rests on *who the actor is*, not on the metadata endpoint being otherwise
unreachable.

**What would invalidate this — the tripwire:** the instant probe-target configuration is
reachable by anyone who is not already an admin — a scoped admin variant, a new capability, a
Phase 2 external-probe surface reachable by someone else — this reasoning collapses. At that
point probe targets need to be validated against loopback, link-local and private address
ranges before the fetch, which nothing in this codebase does today. Anyone adding such a role
or capability should treat that validation as part of the same change, not a follow-up.

## 4. The path-identity constraint, and why it is first

**Get this wrong before anything else and every stack Homestead manages comes up empty.**
Spec §10 states it exactly:

> The compose root must be bind-mounted at the same absolute path inside the container as on
> the host. Homestead runs `docker compose -f /volume2/docker/<app>/compose.yaml`, but the
> Docker daemon resolves that stack's own relative bind mounts against the **host**
> filesystem.

Two things follow from how Compose and the daemon actually behave:

- **Compose does not canonicalise paths** — it passes through whatever path string Homestead
  emits, verbatim. The invariant is not "the container path must be a real directory"; it is
  that **the path string Homestead emits must be meaningful on the host**.
- **The daemon resolves symlinked bind sources correctly**, reading through to the real
  target. So **a symlinked `/volume2/docker` on the host is fully supported** — mount the
  symlink path into the container at that same path, and everything works.

What is *not* supported is mounting the share at a different path inside the container, e.g.
`/volume2/docker` on the host mounted at `/data` in the container while telling Homestead the
root is still `/volume2/docker`.

The failure mode is silent, which is exactly why documentation alone is not enough: a bind
source that does not exist on the host is not an error — **Docker creates an empty directory
for it and proceeds**. A misconfigured mount therefore produces a running stack with empty
config and data volumes; an adopted app looks freshly installed, which is indistinguishable
from data loss until someone checks.

Homestead runs a **boot preflight** that catches exactly this: before serving traffic, it
writes a marker file under the compose root, launches a throwaway container binding that same
path, and reads the marker back through the daemon. If the marker is missing, the mount is
misconfigured and Homestead **refuses to start**, naming the mismatch in the error. The same
check runs again as onboarding step 2.

## 5. Configuration

All environment variables are parsed in one place, `src/server/config.ts:9-29`.

| Variable | Default | Required |
|---|---|---|
| `NODE_ENV` | `development` | No |
| `PORT` | `3000` | No |
| `HOMESTEAD_SECRET_KEY` | — | **Yes.** No default. |
| `HOMESTEAD_DB_PATH` | `./data/homestead.db` | No |
| `HOMESTEAD_COMPOSE_ROOT` | `/volume2/docker` | No |
| `HOMESTEAD_DOCKER_SOCKET` | `/var/run/docker.sock` | No |
| `HOMESTEAD_BASE_URL` | — | **Yes.** No default. |
| `HOMESTEAD_TRUSTED_ORIGINS` | `""` | No |
| `HOMESTEAD_TRUSTED_PROXIES` | `127.0.0.1,::1` | No |
| `HOMESTEAD_ACCESS_TEAM_DOMAIN` | `null` | No |
| `HOMESTEAD_ACCESS_AUD` | `null` | No |
| `HOMESTEAD_SKIP_MOUNT_PREFLIGHT` | `false` | No |
| `HOMESTEAD_ICON_CACHE_DIR` | `./data/icons` | No |

`HOMESTEAD_SECRET_KEY` and `HOMESTEAD_BASE_URL` are the only two variables with no default,
and `HOMESTEAD_SECRET_KEY` must decode (base64) to exactly 32 bytes — generate one with:

```bash
head -c32 /dev/urandom | base64
```

**Losing this key makes every secret already stored in the `secrets` table undecryptable.**
Keep it outside the compose file (a secrets manager, a `.env` you back up) rather than only in
`compose.yaml`.

`HOMESTEAD_ACCESS_TEAM_DOMAIN` / `HOMESTEAD_ACCESS_AUD` are only for placing Homestead behind
a Cloudflare Access application it did not itself provision — Phase 2 writes these to the
database when Homestead provisions its own exposure. With neither source supplying both
values, the Access sign-in path stays dormant and password login is unaffected.

**One shared Access policy protects every app exposed through Cloudflare — deliberately, not
as an oversight.** Phase 3A creates a single reusable `Homestead Access` policy admitting every
enabled Homestead user's email, and every app's Access application points at that same policy.
Exposing one app therefore grants sign-in access to every enabled user, including a viewer
whose Homestead permissions are scoped to a single, different app — Homestead's own per-app
scope (`scopeAllApps`/`userAppScope`) has no effect on who Cloudflare's Access lets through,
because Access has no notion of "which Homestead app" a request is for beyond the hostname.
The setup wizard's exposure step states this at the point an admin makes the decision; this is
the same property written down here for whoever is planning the deployment before any app is
ever exposed. Closing this gap, if it is ever worth closing for a given household, means one
reusable Access policy per exposed app (scoped to that app's own viewers) in place of the
single shared one — not built in this phase.

## 6. Volumes

| Mount | Purpose |
|---|---|
| `/var/run/docker.sock` | Read-write. Homestead runs `docker compose` commands and writes compose files for the apps it manages. |
| The compose root (e.g. `/volume2/docker`) | Mounted at the **identical path** on both sides — see §4. Where every managed app's compose file and bind-mounted data live. |
| `/app/data` (named volume) | Holds `homestead.db` and the icon cache. This is Homestead's own state, separate from anything it manages. |

## 7. First run

On first boot the container runs the mount preflight, then migrations, then a startup sweep
that repairs any job left `running`/`queued` by a previous crash (logging only if it found
something to repair). Once serving, opening the app in a browser lands on the **setup
wizard**: create the admin account, verify the Cloudflare Access team/host if using it, import
existing Compose apps already on disk under the compose root, and optionally invite viewers.

## 8. Upgrading

```bash
docker build -t homestead:dev .
docker compose up -d
```

Migrations run automatically at startup against whatever is in `/app/data/homestead.db` — no
separate migration step. Keep `stop_grace_period` comfortably above the real shutdown budget:
`jobs.shutdown()`'s 10s (`src/server/apps/job-runner.ts`) plus `stepJobs.shutdown()`'s 10s
(`src/server/apps/step-job-runner.ts`) plus `server.close()`'s 20s (`src/server/shutdown.ts`)
worst case, for a total of **40s**, not the 20s any one file states in isolation.
`compose.example.yaml` sets `stop_grace_period: 55s` for that reason — 15s of margin above
the 40s budget. Compose's own *default* grace period, if that line were removed, is **10s** —
well under the budget, not "comfortably above" it — so do not delete it. With the 55s set, an
upgrade's `docker compose up -d` (which stops the old container before starting the new one)
gets a clean shutdown rather than a `SIGKILL` mid-sequence.

## 9. Managing Homestead with Homestead

Once running, Homestead is a normal container and can be adopted and managed like any other
app it watches. Set its row's `system_kind` column to `'self'` (there is no UI for this — it is
a direct SQL update against `apps`, e.g. `UPDATE apps SET system_kind = 'self' WHERE id = '<id>'`)
and every lifecycle action (`up`, `down`, `restart`, `pull`) is refused with 409 `system_app`,
the same guard that already protects it from deletion. Restarts and stops of Homestead itself
have to happen from the NAS instead of from Homestead's own UI: a `down` issued against yourself
cannot be undone by the UI that issued it, and a `restart` kills the process handling the very
request that asked for it.

`system_kind` also has a second value, `'cloudflared'`, for the managed Cloudflare Tunnel
container Phase 2 introduces: it is refused deletion the same as `'self'`, but — unlike
`'self'` — its lifecycle actions (including `down`) are **not** refused, since restarting or
stopping the tunnel does not take Homestead's own UI down with it. Use `'self'` only for
Homestead's own row.

## 10. Verifying the mount preflight

`src/server/host/preflight.ts`'s decisive check — that a marker file written inside the
container is visible back through the daemon's own view of the compose root — can only be
exercised by actually running Homestead containerised with a mismatched bind mount; a test
process that IS the Docker host cannot construct the mismatch it exists to catch (see the note
at `preflight.test.ts:44-49`). `scripts/verify-mount-preflight.sh` is the runnable manual gate
for that: given a built `homestead:dev` image, it runs the four mount scenarios in the table
below and asserts each one refuses or passes as expected, cleaning up every container and
temp directory it creates. Run it after touching `preflight.ts` or the volumes in
`compose.example.yaml`/`Dockerfile`, before a release:

```bash
docker build -t homestead:dev .
./scripts/verify-mount-preflight.sh
```

| Mount | `HOMESTEAD_COMPOSE_ROOT` | Expected |
|---|---|---|
| Identical path both sides | that path | preflight passes |
| Different container path | the host path | refused |
| Container path exists on host but is a different directory | the other directory | refused |
| No compose-root mount at all | any path | refused |

## 11. Troubleshooting

**The preflight refuses to start.** The container exits immediately with a `PreflightError`
naming the mismatch — for example "the marker file was not visible to the Docker daemon at
`<path>`". This means `HOMESTEAD_COMPOSE_ROOT` and the compose root bind mount's *container*
path do not match. Fix the bind mount in your `compose.yaml` (or the env var) so both sides
use the identical absolute path, per §4, and restart.

**`HOMESTEAD_SKIP_MOUNT_PREFLIGHT=true` exists for development and CI only.** It bypasses the
one check that catches a silently broken mount. Setting it on the NAS defeats the entire
protection §4 describes — a misconfigured mount would then produce apps that look freshly
installed instead of refusing to boot. Never set it in a real deployment.

**The web UI 404s on every page but the API works.** `dist/web` is missing from the image —
`src/server/routes/spa.ts:8-10` only logs a warning (`dist/web not found; run pnpm build:web
to serve the SPA`) and registers no static handler, so the failure is a silent 404 rather than
a crash. Check the container logs for that warning, and confirm the `build` stage actually
produced `dist/web` before the `runtime` stage copied it.

## 12. Development deployment

For iterating on Homestead itself against a real, tailnet-reachable box, without rebuilding an
image on every change. `compose.dev.yaml` builds `Dockerfile.dev` instead of the root
Dockerfile: no source is baked in and no build runs at image-build time. The working tree is
bind-mounted at `/app`, and the entrypoint runs the repo's own `pnpm dev` — `tsx watch`
restarts the server and Vite serves the UI with HMR — so a file that lands on the host takes
effect immediately.

### Starting it

On the dev box, with the repo present at some path (see "Pushing updates" below):

```bash
docker compose -f compose.dev.yaml up -d --build
```

`--build` only matters the first time, or after changing `Dockerfile.dev` itself — everything
under the working tree is picked up through the bind mount without it.

### Pushing updates

`scripts/push-to-test.sh` rsyncs the working tree to the dev VM over SSH:

```bash
./scripts/push-to-test.sh
```

Override `HOMESTEAD_TEST_HOST` / `HOMESTEAD_TEST_PATH` to target somewhere other than the
project's current test VM. `tsx watch` and Vite pick up the change as soon as rsync finishes —
no restart needed, unless `package.json`'s dependencies changed, in which case restart the
container so the entrypoint reruns `pnpm install` into the `node_modules` volume.

### Opening it

`http://homestead-test.hippo-ule.ts.net:5173` — Vite's port, not the API's. The browser talks
to Vite, which proxies `/api` to the server on port 3000 in the same network namespace (both
share the host's, per `network_mode: host`). This is also why `HOMESTEAD_BASE_URL` in
`compose.dev.yaml` is set to that same Vite URL rather than the API's: Better-Auth compares
the browser's `Origin` header against it and derives cookie security from its scheme, and the
browser's address bar only ever shows the Vite URL in this deployment.

### How it differs from production

| | Production (`compose.example.yaml`) | Development (`compose.dev.yaml`) |
|---|---|---|
| Image | Built once, immutable, four stages | `Dockerfile.dev`: no source baked in, no build step |
| Source | Copied into the image at build time | Bind-mounted from the working tree at `/app` |
| `node_modules` | Installed inside the image at build time (Alpine/musl) | Named volume, (re-)installed by the entrypoint on each container start |
| Change workflow | Rebuild and redeploy the image | `scripts/push-to-test.sh`; the watchers pick it up |
| Served on | The API's own port, built SPA assets | Vite's dev server (HMR), proxying `/api` to the server |
| `HOMESTEAD_BASE_URL` | The API's port | Vite's port |

`network_mode: host`, the Docker socket mount, and the compose-root identical-path mount and
its boot preflight are identical in both deployments — see §3 and §4. Setting
`HOMESTEAD_SKIP_MOUNT_PREFLIGHT=true` is no more appropriate here than in production; the dev
deployment's compose-root mount is real and can be misconfigured the same way.
