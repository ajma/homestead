# Phase 1H recon: deployment gap analysis against spec §10

Spec source: `docs/superpowers/specs/2026-09-09-homestead-design.md:758-822`.

## 1. Build

- `package.json:12` — `"build": "pnpm build:web && pnpm build:server"`.
- `package.json:13` — `"build:web": "vite build"` → `vite.config.ts:14` sets `build: { outDir: "dist/web", emptyOutDir: true }`. Confirmed on disk: `dist/web/{index.html,manifest.webmanifest,icon.svg,assets/}`.
- `package.json:14` — `"build:server": "tsup src/server/index.ts --format esm --target node24 --out-dir dist/server"`. No `tsup.config.*` file exists anywhere in the repo — all tsup options are CLI flags. Output confirmed on disk: single file `dist/server/index.js` (4603 lines, 172KB).
- **tsup does not bundle dependencies.** Inspecting `dist/server/index.js` shows bare `import ... from "fastify"`, `"dockerode"`, `"@libsql/client"`, `"drizzle-orm"`, `"better-auth"`, `"zod"`, `"@fastify/cookie"`, `"@fastify/static"`, `"@fastify/rate-limit"` — none inlined. Only same-repo modules are bundled together into the one file. This means the runtime image needs `node_modules` with production dependencies installed alongside `dist/server/index.js`; shipping `dist/server/` alone is not sufficient.
- Static serving: `src/server/routes/spa.ts:6-21`. `root = resolve("dist/web")` (line 7, resolved against `process.cwd()`, not `__dirname` — matters for where the container's `WORKDIR` must be). Registers `@fastify/static` at that root with `wildcard: false` (line 13), then a `setNotFoundHandler` that serves `index.html` for any non-`/api/` path (history-mode SPA fallback, lines 16-21). If `dist/web` doesn't exist it just logs a warning and returns without registering routes (`spa.ts:8-10`) — no crash, but the SPA silently 404s.
- **No Dockerfile, `.dockerignore`, or compose file anywhere in the repo** (`find . -iname "Dockerfile*" -o -iname ".dockerignore" -o -iname "compose.y*ml"` returns nothing outside `node_modules`). This is greenfield for Phase 1H.
- `drizzle/` migration folder lives at repo root (`./drizzle/0000_tiny_zzzax.sql` + `./drizzle/meta`), *outside* `dist/`. `src/server/db/client.ts:19` calls `migrate(db, { migrationsFolder: "./drizzle" })` — resolved relative to `process.cwd()`, not relative to `dist/server/index.js`. The Docker image must therefore carry `./drizzle` next to wherever it runs `node`, not just `dist/`.

## 2. Configuration

- **Single central config module**: `src/server/config.ts`. All environment parsing happens in one `zod` schema (`config.ts:9-29`) consumed by `loadConfig(env)` (`config.ts:48`), called exactly once in `src/server/index.ts:21`. No other file reads `process.env.HOMESTEAD_*` — the only other `process.env` read in the whole server is unrelated: `src/server/routes/health.ts:6`, `process.env.npm_package_version ?? "0.0.0"` (health-check version string, not a Homestead setting).
- Every env var the code actually reads today (all in `config.ts:9-29`): `NODE_ENV`, `PORT`, `HOMESTEAD_SECRET_KEY`, `HOMESTEAD_DB_PATH`, `HOMESTEAD_COMPOSE_ROOT`, `HOMESTEAD_DOCKER_SOCKET`, `HOMESTEAD_BASE_URL`, `HOMESTEAD_TRUSTED_ORIGINS`, `HOMESTEAD_TRUSTED_PROXIES`, `HOMESTEAD_ACCESS_TEAM_DOMAIN`, `HOMESTEAD_ACCESS_AUD`, `HOMESTEAD_SKIP_MOUNT_PREFLIGHT`, `HOMESTEAD_ICON_CACHE_DIR`.
- Spec §10 table cross-check:
  - `HOMESTEAD_SECRET_KEY` — honoured, `config.ts:12`, decoded/validated to exactly 32 bytes at `config.ts:51-57`.
  - `HOMESTEAD_COMPOSE_ROOT` — honoured, `config.ts:14`, defaults to `/volume2/docker` exactly as spec says.
  - `HOMESTEAD_ACCESS_TEAM_DOMAIN` / `HOMESTEAD_ACCESS_AUD` — honoured, `config.ts:22-23`, both optional/nullable; `accessEnabled` is only true when both are present (`config.ts:84`), matching the spec's "when neither source supplies both values, sign-in stays dormant" language (though the *other* source — DB-stored Access settings from Phase 2 — is out of scope for this repo today; only the env-var override path exists in code now).
- Database file path: `HOMESTEAD_DB_PATH`, default `"./data/homestead.db"` (`config.ts:13`), consumed in `src/server/db/client.ts:8-13` — `createClient({ url: dbPath === ":memory:" ? ":memory:" : `file:${dbPath}` })`, with `mkdirSync(dirname(dbPath), { recursive: true })` (`client.ts:9`) to create the parent directory. This is a relative path resolved against `process.cwd()` — same cwd sensitivity as the SPA static root and the migrations folder above. Icon cache dir similarly: `HOMESTEAD_ICON_CACHE_DIR` defaults to `"./data/icons"` (`config.ts:28`), also cwd-relative.
- Not in spec's table but present and required: `HOMESTEAD_DOCKER_SOCKET` (default `/var/run/docker.sock`, `config.ts:15`), `HOMESTEAD_BASE_URL` (required, no default, `config.ts:16`), `HOMESTEAD_TRUSTED_ORIGINS`/`HOMESTEAD_TRUSTED_PROXIES` (CSRF/IP-trust config), `HOMESTEAD_SKIP_MOUNT_PREFLIGHT` (dev/CI escape hatch for the preflight in Q3, referenced directly in `PreflightError`'s message at `preflight.ts:16`).

## 3. The startup preflight — does it launch a container?

**Yes — it already does the full container round-trip the spec describes.** `src/server/host/preflight.ts:37-145`, `runMountPreflight`:

1. Writes a marker file under the compose root: `mkdir(markerDir, { recursive: true })` + `writeFile(markerPath, token, "utf8")` (`preflight.ts:55-56`, with a race-tolerant retry at `preflight.ts:67-76` for a documented concurrent-run ENOENT).
2. Ensures a throwaway image is present (`ensureImage`, `preflight.ts:24-35`, default `alpine:3` at `preflight.ts:22`), pulling it if missing.
3. **Launches a real container** binding the same compose-root path read-only and catting the marker back through the daemon:
   ```ts
   // preflight.ts:87-94
   const container = await docker.createContainer({
     Image: image,
     Cmd: ["cat", `/mnt/preflight/.homestead-preflight/${markerName}`],
     HostConfig: {
       Binds: [`${opts.composeRoot}:/mnt/preflight:ro`],
       AutoRemove: false,
     },
   });
   ```
4. Starts it, waits for exit, drains stdout/stderr (with a 2s timeout race against a possibly-lagging stream, `preflight.ts:96-116`), demultiplexes Docker's stream framing (`preflight.ts:118-119, 147-176`), and checks the token is present in the output (`preflight.ts:121-128`). Only `ok: true` if the daemon actually returned the marker content.
5. Cleans up: `container.remove({ force: true })` in a `finally` (`preflight.ts:130-132`), and removes only this run's marker file plus a best-effort non-recursive `rmdir` of the shared marker directory (`preflight.ts:135-144`), explicitly tolerating concurrent runs.

So this is not a filesystem-only check — it is exactly the write-marker → launch-container-bound-to-same-path → read-marker-through-daemon flow the spec calls for. This is **not** the biggest gap; if anything it's the most spec-faithful piece of code in the repo. (The one thing to verify in the plan, not fix: the default image `alpine:3` requires a registry pull on a machine with no cached image, adding first-boot latency/network dependency — worth deciding whether to vendor/pin a digest.)

- **`index.ts` reaction on failure**: `src/server/index.ts:21-29`.
  ```ts
  const config = loadConfig(process.env);
  if (!config.skipMountPreflight) {
    const result = await runMountPreflight({ composeRoot: config.composeRoot, dockerSocket: config.dockerSocket });
    if (!result.ok) throw new PreflightError(result.reason);
  }
  ```
  `PreflightError` (`preflight.ts:8-20`) throws synchronously before the DB, migrations, or Fastify are ever touched — an uncaught throw at module top level, which crashes the process (non-zero exit), i.e. "refuses to start" as the spec requires. The error message embeds the mount-mismatch explanation and points at `HOMESTEAD_SKIP_MOUNT_PREFLIGHT` for dev/CI.
- **Onboarding step 2 call site**: `src/server/routes/setup.ts`, route `GET /api/setup/host-check` (`setup.ts:103-136`). It runs both a Docker version check and the same `runMountPreflight` via `app.deps.preflight()` (injected, same function passed by `index.ts:101-102`), deduplicating concurrent clicks with an in-flight promise cache (`setup.ts:57-65`, comment at `setup.ts:52-56` notes each run "starts a real container: image-ensure, create, attach, start, wait, remove"). The wizard (`src/web/routes/setup/StepVerifyHost.tsx`, `HostCheckPanel.tsx`) surfaces `HostCheck.preflight.ok`/`reason` and — per `StepVerifyHost.tsx:18` — deliberately allows continuing past a failing preflight, recording an override reason via `POST /api/setup/state` (`setup.ts:12-26`, `161-168`) rather than blocking the wizard.

## 4. Path confinement

`src/server/host/paths.ts`, class `PathGuard`. It resolves **two** roots when they differ:

```ts
// paths.ts:20-25
async init(): Promise<void> {
  const configured = resolve(this.configuredRoot);
  const real = await realpath(configured);
  this.roots = configured === real ? [configured] : [configured, real];
}
```

Both `resolveExisting` (`paths.ts:46-58`) and `resolveForWrite` (`paths.ts:65-93`) check membership with `this.roots.some((r) => isInside(real, r))` (e.g. `paths.ts:56`, `78`, `86`), i.e. membership under **either** the configured root or its realpath — exactly what spec §10's "accepts membership under either the configured root or its container-resolved real path" requires. This already matches the spec; no gap found here.

## 5. Shutdown

**No SIGTERM or SIGINT handler exists anywhere in the server** (`grep -rn "SIGTERM\|SIGINT" src/server` only matches unrelated code: `local-host.ts:510/532/552` which sends `SIGTERM` to a `docker compose` child process on job cancellation, and doc comments referencing the *future* handler). `src/server/index.ts:108-119` is an explicit placeholder:

```ts
// Required shutdown order for the SIGTERM handler the Dockerfile task will add (out of
// scope here — see the phase carry-forward): stop `scheduler` and `retention` first so
// no new work starts, then `events.closeAll()` so every open `/api/events` stream ends —
// `app.close()` measurably does not resolve while one is still open — and only then
// `app.close()` itself. ...
process.on("unhandledRejection", ...);
process.on("uncaughtException", ...);
```
Only `unhandledRejection`/`uncaughtException` handlers exist (`index.ts:120-126`), which log and keep serving — they do not touch shutdown.

What's built and ready to be wired, vs. what's dangling today without a handler:
- **Scheduler** (`src/server/monitoring/scheduler.ts:69-83`): `start()`/`stop()` exist, `stop()` just `clearInterval`s a **ref'd** timer (deliberately not `unref`'d, comment at `scheduler.ts:74-79`) — so this timer alone keeps the event loop (and thus the process) alive; nothing calls `stop()` today.
- **RetentionTimer** (`src/server/monitoring/retention.ts:107-123`): same shape, also ref'd, also never stopped.
- **EventBus** (`src/server/routes/events.ts:141-143`): `closeAll()` exists and ends every open `/api/events` SSE stream via each subscription's `onClose`, explicitly documented as "the hook a graceful shutdown will call" — never called today. Each open stream also holds a heartbeat timer and a `MAX_STREAM_MS` (15 min) lifetime-cap timer (`events.ts:11-19`).
- **In-flight `docker compose` child processes**: `src/server/host/local-host.ts:508` spawns `docker compose -f <path> ...` via `spawn` (not `execFile`, comment at `local-host.ts:483`). `JobRunner` (`src/server/apps/job-runner.ts`) has no `shutdown`/`cancelAll` method — a `grep` for `shutdown|cancelAll|close(` in `job-runner.ts` returns nothing. A running deploy job's child process is not tracked for cleanup on process exit.
- **libSQL client**: `src/server/db/client.ts:8-13`, `createDb` returns `{ client, db }`, but `index.ts:31` only destructures `const { db } = await createDb(config.dbPath);` — the `client` handle (the thing with `.close()`) is discarded immediately and never referenced again, so there is no way to close it even if a handler were added without first changing this line.

## 6. Stuck jobs

No sweep exists. `grep -rn "sweep\|crash\|stale" src/server/bootstrap.ts src/server/index.ts` matches nothing relevant (the one hit, `index.ts:45`, is an unrelated comment about the image-update registry sweep). Nothing between `runMigrations` (`index.ts:32`) and `ensureLocalHost`/app boot touches the `jobs` table's `status` column.

Schema, `src/server/db/schema.ts:214-231`:
```ts
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    exitCode: integer("exit_code"),
    output: text("output"),
    userId: text("user_id").references(() => users.id),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("jobs_app_created_idx").on(t.appId, t.createdAt)],
);
```
- Status values in use: `"queued"`, `"running"`, `"succeeded"`, `"failed"` (no `"cancelled"`/`"crashed"` state exists).
- `"running"` is written at job start, `src/server/apps/job-runner.ts:97-104` (`db.insert(jobs).values({ ..., status: "running", startedAt: ..., userId })`) — note there is no `"queued"` phase in practice; a job is inserted already `"running"` (the schema default of `"queued"` is effectively dead for this write path, since `JobRunner.start` immediately spawns the compose process synchronously before the insert, per the comment at `job-runner.ts:72-79`).
- Terminal states are written only in `JobRunner.finish` (`job-runner.ts:117-134`):
  ```ts
  await this.deps.db.update(jobs).set({
    status: result.exitCode === 0 ? "succeeded" : "failed",
    exitCode: result.exitCode,
    finishedAt: Math.floor(Date.now() / 1000),
    output,
  }).where(eq(jobs.id, job.id));
  ```
  This only runs if the in-process `JobRunner.running` Map still holds the job (it's an in-memory `Map<appId, RunningJob>`, `job-runner.ts:43+`) — a crash/restart loses that map entirely, so a row stuck at `status: "running"` with no `finishedAt` is never revisited by anything in this codebase.
- `ActionBar` resumption: `src/web/components/ActionBar.tsx:24-25` (doc comment) confirms it treats the most-recent job row's `status: "running"` as "a job is running for this app" and resumes polling/streaming against it — so a crash-orphaned `"running"` row will make the UI believe a job is perpetually in-flight for that app (confirmed by `ActionBar.test.tsx:374-375`, which seeds exactly this scenario for the *legitimate* case of a job already running at mount).
- **Nothing else** references `jobs.status` for repair; a startup sweep (e.g., `UPDATE jobs SET status = 'failed', finishedAt = now() WHERE status = 'running'`) needs to be written from scratch and hooked in after `runMigrations`/before `app.listen`.

## 7. Self-management / `isSystem`

The concept **already exists** in the schema and is enforced today, but only as a deletion guard, not full lifecycle protection.
- Schema: `src/server/db/schema.ts:96` — `isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false)` on the `apps` table.
- Serialization: `src/server/apps/serialize.ts:20` (type) and `:82` (`isSystem: row.isSystem`) — exposed to the API/UI.
- Enforcement found: exactly one guard, `src/server/routes/apps.ts:599-600`:
  ```ts
  // `isSystem` marks the managed cloudflared stack, which Phase 2 owns.
  if (row.isSystem) return reply.code(409).send({ error: "system_app" });
  ```
  inside `DELETE /api/apps/:id` (`apps.ts:592+`) — blocks forgetting a system app. `grep -rn "isSystem" src/server src/web` finds no other enforcement site (no guard yet on start/stop/edit/compose-mutation routes) and no UI beyond a badge: `src/web/routes/AdminApps.tsx:165`, `{app.isSystem && (...)}`.
- Nothing in the code creates or references a `cloudflared` row today (`bootstrap.ts` — the only app it seeds is `ensureLocalHost`/`LOCAL_HOST_ID`, unrelated to `isSystem`); the comment at `apps.ts:599` is aspirational/forward-referencing Phase 2. For Homestead to adopt itself with "the same `isSystem` protection as `cloudflared`," the plan needs to (a) decide how a self-managed Homestead app row gets `isSystem: true` set (adoption flow doesn't exist yet), and (b) decide whether the single existing guard (delete-blocking) is sufficient or whether stop/restart also need guarding for a service that would take down the very process enforcing the guard.

## 8. Runtime deps or things that won't survive a slim Alpine image

- **tsup does not bundle `node_modules`.** Confirmed by inspecting `dist/server/index.js`: imports of `fastify`, `dockerode`, `@libsql/client`, `drizzle-orm`, `better-auth`, `@fastify/*`, `zod` all remain as bare ESM imports, not inlined. The Docker build must run `pnpm install --prod` (or equivalent) into the runtime stage and ship `node_modules` alongside `dist/server/index.js`; shipping only `dist/` will crash on `Cannot find package 'fastify'`.
- **libSQL native binding — glibc vs musl mismatch risk.** `node_modules/.pnpm/@libsql+linux-x64-gnu@0.5.29` is the only platform package present on this (glibc/Debian-family) dev machine — no `@libsql/linux-x64-musl` variant is installed here. Alpine uses musl libc. `@libsql/client`'s optional-dependency resolution is platform/libc-aware, so running `pnpm install` **inside** the actual Alpine build stage should pull the musl variant automatically — but this needs explicit verification during the Dockerfile task (build inside the target Alpine stage, not copy `node_modules` built on the host/CI glibc runner) or the container will fail at `createClient()` in `src/server/db/client.ts:10` with a missing native binding.
- **Drizzle migrations run at startup**, `src/server/db/client.ts:18-20`, `runMigrations(db)` → `migrate(db, { migrationsFolder: "./drizzle" })`, called from `index.ts:32` before anything else touches the DB. `migrationsFolder: "./drizzle"` is resolved relative to `process.cwd()` and the folder (`./drizzle/0000_tiny_zzzax.sql` + `./drizzle/meta/`) lives at the **repo root**, separate from `dist/`. The image must copy `./drizzle` into the runtime stage and run the process with that as `process.cwd()` — same constraint applies to `HOMESTEAD_DB_PATH` (default `./data/homestead.db`, `config.ts:13`) and `HOMESTEAD_ICON_CACHE_DIR` (default `./data/icons`, `config.ts:28`) and the SPA static root (`resolve("dist/web")`, `spa.ts:7`) — **all four paths are cwd-relative**, so the Dockerfile's `WORKDIR` and the exact set of copied directories (`dist/server`, `dist/web`, `drizzle`, `node_modules`, plus a writable `data/` volume) all have to agree, or defaults will silently point at the wrong place inside the container.
- **`dockerode`** (used for the Docker socket in `preflight.ts` and presumably `local-host.ts`) is a pure-JS Docker API client speaking to the socket over HTTP — no native binding concerns there, but the runtime image still needs the **Docker CLI + Compose plugin installed** per spec (`design.md:760-761`) since `local-host.ts:508` shells out to `docker compose` directly via `spawn`, which is a separate requirement from the `dockerode`-based Unix-socket calls.
