# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Homestead — a self-hosted web UI for managing Docker Compose stacks on a NAS. It shells out to the host's `docker` binary, stores state in SQLite, and optionally publishes stacks on real hostnames through Cloudflare Tunnel + Access.

The checkout directory is `homestacks`; the product, package, and env-var prefix are all `homestead` (renamed early, directory never followed).

## Commands

```bash
pnpm install

# Dev runs as two processes — there is no single command that starts both.
pnpm dev          # Fastify API on :7420 (tsx watch)
pnpm dev:web      # Vite dev server on :5173

pnpm test                                   # both vitest projects
pnpm test src/server/config.test.ts         # one file
pnpm test --project server                  # one vitest project (server | web)
pnpm test -t "name of the test"             # one test by name
pnpm test:docker                            # adds the real-Docker integration tests

pnpm lint         # biome check .
pnpm typecheck    # tsc --noEmit
pnpm e2e          # playwright; starts both servers itself

pnpm build && pnpm start   # tsup (server) + vite build (web), then node dist/server/index.js

pnpm drizzle-kit generate  # after editing src/server/db/schema.ts
```

**Baseline:** `pnpm lint` reports **exactly 6 warnings** and `pnpm typecheck` is clean. The 6 are a deliberate, held baseline — do not "fix" them incidentally, and do not let the count grow.

Migrations in `drizzle/` are applied automatically by `runMigrations()` at server startup; there is no separate migrate command.

## Layout

Single package, three zones: `src/{server,web,shared}`, with `@shared/*` aliased in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts`. ESM throughout — **relative and `@shared` imports carry a `.js` extension** even though the sources are `.ts` (`import type { Operation } from "@shared/projects.js"`).

`src/shared` holds only the types that cross the HTTP boundary. When a server type starts being needed by the web, move it into `src/shared` rather than re-declaring it — there are commits doing exactly that (`refactor: move the container state type into the shared boundary`).

## Server architecture

**The composition root is split in two, and this split is load-bearing.**

- `src/server/app.ts` — `buildApp(deps: AppDeps)` assembles Fastify from injected dependencies. It reads no environment, opens no database, and creates no network client.
- `src/server/index.ts` — the only place that loads config, runs preflight checks, opens SQLite, runs migrations, builds real clients, and starts the monitoring runner.

Route tests call `buildApp` directly with fakes. This is why the monitor runner is started *after* `buildApp` in `index.ts`: so no test ever starts it.

**Every path to `docker` goes through the injected `DockerRunner`** (`{ run, stream }` in `src/server/docker/run.ts`). `AppDeps.docker` is **required, not optional, on purpose** — it was optional with a real default, and a test that simply forgot it brought a container up on a developer's machine. Same reasoning makes `tailscale` and `cloudflare` injected factories. Never add a code path that spawns `docker` directly.

**`src/server/ops/registry.ts`** owns concurrency for lifecycle operations:
- A per-slug `busy` set is the mutex. One registry instance is shared by `projectRoutes` and `operationRoutes` — it is only a lock if both contend for the same one.
- `acquire(slug)` exposes that lock for work that isn't an operation. Delete uses it to hold the lock across *both* `down` and `rm -rf`, otherwise a concurrent `up` recreates containers with no compose file left to stop them by.
- Live output is buffered in memory, capped at 1 MB **by bytes** with head-dropping so the failure tail survives. History rows land in SQLite only when an operation *ends*.
- `find()` and `listForProject()` read **memory first, database second** — the currently-running operation has no row yet, and that's exactly the one a second browser tab needs.

**Path translation:** `HOMESTEAD_PROJECTS` is the path inside the container, `HOMESTEAD_PROJECTS_HOST` the same directory on the host. Because `docker compose` executes against the host daemon, bind-mount sources must be rewritten to host paths. Both are threaded through `AppDeps`.

**`compose down` is behind an allow-list** in `src/server/docker/compose.ts` — unknown flags and volume removal are refused rather than passed through.

**Error handling:** `app.ts` masks 5xx to `{ error: "internal_error" }` and logs server-side; 4xx keeps Fastify's representation because it's client-caused and safe to describe.

**SPA serving:** when `webDir` is set (production only), static files are served and the notFoundHandler returns `index.html` — but only for GET/HEAD on non-`/api/` paths, so a mistyped POST doesn't get HTML with a 200.

## Auth

Better-Auth mounted as a Fastify plugin. Two roles, `admin` and `viewer`, with `viewer` as the default. The permission *statement* (the resource → actions map) lives in `src/shared/permissions.ts` because the web needs it too; the roles built from it are in `src/server/auth/permissions.ts`.

`better-auth` and `@better-auth/drizzle-adapter` are **pinned to exactly 1.7.2**, not caret ranges, because `src/server/db/auth-schema.ts` is hand-maintained (1.7.2 ships no supported schema generator). The pin and that file are a pair — on upgrade, change the two versions, the schema, and a migration together. See the header comment in that file.

## Web architecture

**`src/web/lib/queries.ts` is the single home for server state** — `queryKeys`, hooks, and the shared behaviour.

Refusal-aware retry and refetch live on the **QueryClient defaults** (`createQueryClient`), not on individual hooks. A rule that has to be re-typed at each call site gets missed; it was applied to one hook and the next two silently lost it. `isRefusal` is exported so 401/403 has one spelling. If you add a hook, it inherits the right behaviour by setting nothing.

**`src/web/design-system.test.ts` is a conformance gate, not an ordinary test.** It fails if any component uses a Tailwind palette utility (`bg-blue-500`) or a raw hex colour — colours must come from the semantic tokens in `src/web/theme.css`. It *also* verifies every colour utility resolves to a real Tailwind rule, because Tailwind silently drops unrecognised utilities: `text-text-muted` rendered as unstyled text and shipped through two reviews.

## Testing

**Vitest runs two projects** (`vitest.config.ts`): `server` (node, `src/server/**` + `src/shared/**`) and `web` (jsdom, `src/web/**` with `src/web/test-setup.ts`). Real-Docker integration tests are gated behind `HOMESTEAD_DOCKER_TESTS=1`.

**Playwright specs must import `test` from `./support/fixtures.js`, never from `@playwright/test`.** A Biome `noRestrictedImports` override in `biome.json` enforces this. That fixture installs an automatic **context-level** route guard blocking `POST /api/projects/:slug/(up|down|restart|pull)` from reaching the real daemon — the e2e suite shares the developer's Docker, and compose reconciles by project-name label, so a stray verb can adopt or tear down an unrelated stack. `e2e/lifecycle-guard.spec.ts` asserts from the page's own context that the guard actually fires, because a route pattern that matches nothing fails open silently.

The suite runs one `setup` project (first-run onboarding is one-shot against one SQLite file, so it cannot be duplicated) feeding two viewport projects: desktop 1440×900 and mobile **390×844** (deliberately narrower than a Pixel 7's 412px — several specs hardcode 390 for tap-target and overflow sweeps).

## Deployment

`network_mode: host` is **required**, not a preference. A bridged container's `127.0.0.1` is its own loopback, so every health probe would test the container instead of the service and every app would report down while the config looks correct. Both `compose.example.yaml` and `compose.dev.yaml` set it.

`$HOMESTEAD_DATA` must be persistent **and on local storage** — SQLite locking is unreliable on NFS/SMB and corrupts silently.

Two images: the root `Dockerfile` is the immutable production build (released to GHCR by `.github/workflows/release.yml` on a `v*` tag); `Dockerfile.dev` + `compose.dev.yaml` bind-mount the working tree for hot reload against a real NAS.

Startup preflight checks (Docker socket, data-dir filesystem, projects dir, port) never block boot — they surface as a warning banner in the UI. The banner is reporting a configuration problem, not a bug.

## Docs

`docs/superpowers/specs/` holds the design spec per feature and `docs/superpowers/plans/` the implementation plan. Specs are the source of truth for intent; check the relevant one before changing behaviour in an area.

Commit messages in this repo carry substantial rationale in their bodies (~15k words across the history). When a line of code looks strange, `git log -S` or `git blame` usually explains why before the source does.
