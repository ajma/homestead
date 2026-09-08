# Backlog

Considered and deliberately not scheduled. Each entry records enough of the
reasoning that picking it up later does not mean rediscovering it.

Apps come from **two sources only**: services in managed projects, and manual
rows. Product design §9.1 is the authority and has been amended to match.

---

## Adopting containers into a project

**Status:** to consider later. Preferred over "discovered containers" (below) if
either is ever built.

A container started by Compose carries the absolute path of the file that
created it. Probed on a real container outside `$HOMESTEAD_PROJECTS`:

```
com.docker.compose.project              = bookorbit-dev
com.docker.compose.project.config_files = /home/andm/workspace/bookorbit/docker-compose.dev.yml
com.docker.compose.project.working_dir  = /home/andm/workspace/bookorbit
com.docker.compose.service              = postgres
```

So adoption needs no guessing: the daemon says which file to manage. Homestead
already has an "adopt" concept — §5.3, taking over a stack that exists in
`$HOMESTEAD_PROJECTS` without modifying it, distinguished from a created stack
by the absence of an `x-homestead` block. This extends it by lifting the
directory restriction.

**What it changes.** Today a project *is* a directory under
`$HOMESTEAD_PROJECTS` — `scanProjects()` is a `readdir` over that one path. This
would make a project a compose file path, wherever it lives. Everything
downstream already works on paths through the Compose CLI, so the change is
smaller than it first appears.

**Scope it to compose-started containers.** A `docker run` container has no
compose file, so adopting it means generating one from `docker inspect` and
recreating the container from that reconstruction. `inspect` is lossy in ways
that bite — bind-mount versus volume nuances, network aliases, capabilities —
and the failure mode is destroying a container someone cared about while
claiming to adopt it. Manual rows serve those better.

**The constraint that decides feasibility.** The Compose CLI runs *inside*
Homestead's container and reads the file from its own filesystem. A path like
`/home/andm/workspace/bookorbit/...` is not mounted there, so Homestead cannot
read it — it can see the container but not manage it. Realistically this is
"adopt any compose project under a mounted path", and the UI has to explain why
a container plainly visible on the dashboard is not adoptable. That explanation
is the hard part of the design, not the mechanism.

**Open question to settle first:** what happens when Homestead adopts a stack
and someone then runs `docker compose down` from the original directory. Two
things now believe they own it.

---

## Discovered containers as an app source

**Status:** to consider later; superseded in spirit by adoption above.

Was §9.1 source 2. Any running container carrying `homestead.*` labels,
including outside `$HOMESTEAD_PROJECTS`, deduped against managed services by
container id with the managed record winning — because that one also has
lifecycle controls.

Deferred as the smallest of the three sources in payoff: managed projects
populate the grid for the normal case, and manual rows cover anything Homestead
does not run. Discovery mainly buys automatic tiles for containers someone else
started, a narrow slice on a single-admin NAS.

**Cost if built:** it would be the first tile with no lifecycle controls and no
compose file behind it, and `src/server/apps/tier.ts` currently assumes the
docker monitor identifies its target by `projectSlug` + `service`. A discovered
container has neither — only a container id. That interface change is the bulk
of the work, not the discovery itself.

Note the dedup rule already concedes the point: the managed record wins
*because* it has lifecycle controls. Adoption puts everything in the winning
category instead.

---

## Deferred features

Named in the shipped specs, not built, no analysis owed yet:

- **Per-viewer app visibility** — product design §6.1. The schema is already
  there: `user_prefs.sees_all_apps` and `user_app_access`. Worth building when
  there is something to hide from someone.
- **Icon uploads** — slug lookup plus an explicit URL covers nearly every real
  app.
- **Notifications.**
- **Response-time graph** and latency.
- **ICMP checks.**
- **Native install** — designed in product design §12.2, deliberately not built.
  A NAS audience runs containers, and a second delivery path is a second thing
  to keep working.

---

## Specified but not built

Found by diffing product design §14's API table against the 41 routes actually
registered. §14 has been amended to mark these; they are listed here with a
judgement on whether they matter.

**No way to create a second user.** The sharpest one. `admin` and `viewer` roles
are fully implemented, enforced per route, and tested — and no viewer can be
created through the product. Onboarding makes the first admin; `/api/auth/sign-up`
is deliberately 403'd ("admin-managed accounts only"); `CRUD /api/users` was
specified and never built; there is no Users page and no nav entry. Better-Auth's
admin plugin does expose `/api/auth/admin/create-user`, so the capability exists
at the API layer, reachable only by hand-crafting an authenticated request.

Everything downstream assumes a user population that cannot be populated:
per-viewer grants, the dashboard's role filtering, and the Cloudflare allow
policy that syncs "Homestead's users" to Access. A Users page is the smallest
change that makes the viewer role reachable.

**Also specified, not built, and lower stakes:**

| Endpoint | Notes |
|---|---|
| `POST /api/projects/:slug/rename` | v1 scope §16 lists rename. Nothing implements it — the `rename` in the codebase is `fs.rename` for atomic writes. |
| `GET /api/projects/:slug/stats` | v1 scope says "health and resource stats". No CPU or memory reading exists anywhere; `docker/engine.ts` in §3.1 was to own it. Health is covered by the monitoring subsystem. |
| `GET /api/apps/stream` | SSE dashboard updates. The dashboard polls instead, which is probably fine. |
| `GET /api/tunnel` | Runtime and connection status. Largely covered by `GET /api/cloudflare/status`; may be redundant rather than missing. |
| `GET /api/cloudflare/zones` | Zone listing. Setup currently resolves what it needs without it. |
| `CRUD /api/access-tokens` | Access service tokens are minted during Cloudflare setup and stored encrypted; there is no management surface for them. |

**Image update check and recreate.** v1 scope lists "image update check, pull,
and recreate". `pull` exists as an `OperationKind`, so pulling works. The
*check* — registry digest polling, `updates/checker.ts` in §3.1 — does not
exist, so nothing tells you an update is available.

---

## Known open item

- **The release workflow has never run.** There is no git remote, so
  `.github/workflows/release.yml` is untested; the first version tag will be its
  first execution. Recorded in the packaging spec's handoff.
