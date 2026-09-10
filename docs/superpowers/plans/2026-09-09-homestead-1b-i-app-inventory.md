# Homestead Phase 1B-i — App Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the Compose stacks already on the NAS and report their real status — discover `/volume2/docker`, join directories to running containers, read and write `compose.yaml` and `.env` safely, and serve app data through role-appropriate projections.

**Architecture:** Extends the `Host` seam from Phase 1A with one subprocess method, `runCompose`. Compose *reads* that need semantics (`config`) go through the CLI; container state comes from the Engine API via the existing `listContainers`. A resolved-config cache keyed by file hash keeps the CLI off the hot path. Two DTOs — viewer and admin — replace ad-hoc field selection.

**Tech Stack:** TypeScript (ESM, strict), Fastify, Drizzle + libSQL, dockerode, `docker compose` CLI, zod, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` (sections 3, 4, 7)
**Carry-forward:** `docs/superpowers/plans/2026-09-09-homestead-1a-carry-forward.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 24, pnpm 12.** Newest stable major of every dependency; no RCs or betas.
- **TypeScript:** ESM only, `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: "bundler"`, `target: "ES2022"`. No CommonJS, no `require`. Local imports use `.js` extensions.
- **TypeScript 7 removed `baseUrl`.** Never add it; `paths` targets stay relative with `./`.
- **Installed toolchain:** TypeScript 7.0.2, Vitest 5.0.0, Biome 2.5.12, Fastify 5.12.3, Better-Auth 1.7.3, Drizzle 0.45.2, dockerode 5.0.1, zod 4.5.4, Docker 29.8.0 with Compose v5.5.1.
- **Biome's `noNonNullAssertion` is enforced.** No `!`, no rule suppressions.
- **Deprecated APIs are invisible to every gate** — `tsc` reports them as suggestions it never prints, Biome does not read JSDoc `@deprecated`. Grep your diff for zod string-methods (`z.string().email()/.url()/…` → `z.email()`, `z.url()`) and React `FormEvent` (→ `SyntheticEvent`); if you introduce an API you are unsure about, say so in your report.
- **Never build a shell command as a string.** Subprocess invocations use an argument array.
- **Secrets never appear in API responses** unless an explicitly-named reveal endpoint returns them, and that endpoint writes an audit entry.
- **Viewers get a distinct DTO, never a filtered admin object.** See Task 1.
- No `Co-Authored-By` trailers or AI-attribution lines. Plain author commits, descriptive subjects, `feat:` / `fix:` / `chore:` prefixes.
- Commit after every task. All three gates (`pnpm test`, `pnpm typecheck`, `pnpm lint`) pass before each commit.
- **Stage explicit paths.** Never `git add -A`.

## Do not disturb — each closes a measured vulnerability

`writeTextFile`'s temp-file-plus-`rename` and mode preservation; `resolveForWrite`'s target check; the mandatory `aad` on `encrypt`/`decrypt`; `buildForwardedHeaders` and the `CLIENT_IP_HEADERS` strip; `setErrorHandler` preceding every `register()`; `lastActiveAdminIsSafe`. All have regression tests. See the carry-forward document for why each looks odd.

---

## File Structure

```
src/shared/
  dto.ts                    ViewerApp and AdminApp shapes, shared with the web client

src/server/
  bootstrap.ts              Seed the local `hosts` row at startup
  host/
    types.ts                + ComposeTarget, ComposeResult, runCompose on Host
    local-host.ts           + runCompose (subprocess, argument array)
  apps/
    compose-config.ts       Resolve `docker compose config --format json`, cache by file hash
    env-file.ts             Parse/serialize .env preserving order and comments; masking
    adoption.ts             Join compose directories to labelled containers
    status.ts               Roll container states up to one app status
    serialize.ts            App row + status -> ViewerApp | AdminApp
  routes/
    apps.ts                 Adoption, app CRUD, compose file, .env
```

---

### Task 1: Viewer and admin DTOs

**Files:**
- Create: `src/shared/dto.ts`, `src/server/apps/serialize.ts`
- Test: `src/server/apps/serialize.test.ts`

**Interfaces:**
- Consumes: `AppStatus`, `FaultClass` from `@shared/types`
- Produces: `type ViewerApp`, `type AdminApp`, `toViewerApp(row, status)`, `toAdminApp(row, status)`

The design spec requires "a different serializer, not a filtered one — the viewer DTO is a distinct type on which compose, `.env`, and log fields do not exist," because field-stripping "fails open the day someone adds a property." Phase 1A shipped no such type; the final review flagged that a viewer currently reads nothing only because no endpoint serves anything. This task lands the structure before the first app-reading endpoint exists.

- [ ] **Step 1: Write the failing test**

`src/server/apps/serialize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { toAdminApp, toViewerApp } from '@server/apps/serialize'

const row = {
  id: 'app-1',
  hostId: 'local',
  slug: 'jellyfin',
  displayName: 'Jellyfin',
  description: 'Movies and TV',
  iconRef: 'jellyfin',
  category: 'Media',
  sortOrder: 0,
  showOnLauncher: true,
  directory: 'jellyfin',
  composeFile: 'compose.yaml',
  projectName: 'jellyfin',
  launchInternalUrl: 'http://nas.local:8096',
  lastComposeHash: 'abc123',
  isSystem: false,
  graceUntil: null,
  adoptedAt: 1700000000,
  archivedAt: null,
}

const status = { status: 'up' as const, detail: '4/4 services up' }

describe('app serializers', () => {
  it('gives a viewer only what a housemate needs', () => {
    const dto = toViewerApp(row, status)
    expect(dto).toEqual({
      id: 'app-1',
      slug: 'jellyfin',
      displayName: 'Jellyfin',
      description: 'Movies and TV',
      iconRef: 'jellyfin',
      category: 'Media',
      launchUrl: 'http://nas.local:8096',
      status: 'up',
      statusDetail: '4/4 services up',
    })
  })

  it('omits every operational field from the viewer DTO', () => {
    const dto = toViewerApp(row, status) as Record<string, unknown>
    // All eleven admin-only fields, not a sample. This test's name promises
    // completeness, and it is the backstop if the exact-key-set test below is ever
    // relaxed to reduce its (deliberate) maintenance friction.
    for (const forbidden of [
      'directory', 'composeFile', 'projectName', 'lastComposeHash',
      'hostId', 'isSystem', 'graceUntil', 'adoptedAt',
      'showOnLauncher', 'sortOrder', 'archivedAt',
    ]) {
      expect(dto).not.toHaveProperty(forbidden)
    }
  })

  it('serialises the whole row for an admin', () => {
    // Full shape, not spot-checks: a missing admin field would otherwise pass.
    expect(toAdminApp(row, status)).toEqual({
      id: 'app-1',
      slug: 'jellyfin',
      displayName: 'Jellyfin',
      description: 'Movies and TV',
      iconRef: 'jellyfin',
      category: 'Media',
      launchUrl: 'http://nas.local:8096',
      status: 'up',
      statusDetail: '4/4 services up',
      hostId: 'local',
      directory: 'jellyfin',
      composeFile: 'compose.yaml',
      projectName: 'jellyfin',
      lastComposeHash: 'abc123',
      isSystem: false,
      showOnLauncher: true,
      sortOrder: 0,
      graceUntil: null,
      adoptedAt: 1700000000,
      archivedAt: null,
    })
  })

  // A new column must not silently reach viewers. This is the guard that makes the
  // "distinct type, not a filter" requirement mean something.
  it('does not widen the viewer DTO when the row gains a field', () => {
    const widened = { ...row, secretOperationalField: 'must not leak' }
    const dto = toViewerApp(widened, status) as Record<string, unknown>
    expect(dto).not.toHaveProperty('secretOperationalField')
    expect(Object.keys(dto).sort()).toEqual([
      'category', 'description', 'displayName', 'iconRef', 'id',
      'launchUrl', 'slug', 'status', 'statusDetail',
    ])
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/apps/serialize.test.ts`
Expected: FAIL — cannot resolve `@server/apps/serialize`.

- [ ] **Step 3: Write `src/shared/dto.ts`**

```ts
import type { AppStatus } from './types.js'

/**
 * What a viewer sees. Deliberately a distinct type rather than a subset of the admin
 * shape: a field added to the app row cannot reach this object unless someone edits
 * this declaration, which is a reviewable act.
 */
export type ViewerApp = {
  id: string
  slug: string
  displayName: string
  description: string | null
  iconRef: string | null
  category: string | null
  launchUrl: string | null
  status: AppStatus
  statusDetail: string | null
}

/** What an admin sees: operational identity plus everything a viewer sees. */
export type AdminApp = ViewerApp & {
  hostId: string
  directory: string
  composeFile: string
  projectName: string
  lastComposeHash: string | null
  isSystem: boolean
  showOnLauncher: boolean
  sortOrder: number
  graceUntil: number | null
  adoptedAt: number
  archivedAt: number | null
}
```

- [ ] **Step 4: Write `src/server/apps/serialize.ts`**

```ts
import type { AdminApp, ViewerApp } from '@shared/dto'
import type { AppStatus } from '@shared/types'

/** Just enough of an `apps` row to serialise. Structural, so tests need no database. */
export type AppRowLike = {
  id: string
  hostId: string
  slug: string
  displayName: string
  description: string | null
  iconRef: string | null
  category: string | null
  sortOrder: number
  showOnLauncher: boolean
  directory: string
  composeFile: string
  projectName: string
  launchInternalUrl: string | null
  lastComposeHash: string | null
  isSystem: boolean
  graceUntil: number | null
  adoptedAt: number
  archivedAt: number | null
}

export type AppStatusSummary = { status: AppStatus; detail: string | null }

/**
 * Every property is listed explicitly. Do not rewrite this as a spread-and-delete —
 * that inverts the failure mode, so a new column leaks until someone remembers to
 * exclude it.
 */
export function toViewerApp(row: AppRowLike, status: AppStatusSummary): ViewerApp {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    iconRef: row.iconRef,
    category: row.category,
    launchUrl: row.launchInternalUrl,
    status: status.status,
    statusDetail: status.detail,
  }
}

export function toAdminApp(row: AppRowLike, status: AppStatusSummary): AdminApp {
  return {
    ...toViewerApp(row, status),
    hostId: row.hostId,
    directory: row.directory,
    composeFile: row.composeFile,
    projectName: row.projectName,
    lastComposeHash: row.lastComposeHash,
    isSystem: row.isSystem,
    showOnLauncher: row.showOnLauncher,
    sortOrder: row.sortOrder,
    graceUntil: row.graceUntil,
    adoptedAt: row.adoptedAt,
    archivedAt: row.archivedAt,
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/apps/serialize.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/dto.ts src/server/apps/serialize.ts src/server/apps/serialize.test.ts
git commit -m "feat: add distinct viewer and admin app DTOs"
```

---

### Task 2: Seed the local host row

**Files:**
- Create: `src/server/bootstrap.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/bootstrap.test.ts`

**Interfaces:**
- Consumes: `Db`, `Config`
- Produces: `ensureLocalHost(db, config): Promise<string>` returning the host id

`index.ts` constructs `new LocalHost("local", …)` and `apps.hostId` has a foreign key to `hosts.id`, but nothing inserts that row — so Task 6's first adoption would fail on its FK. The id is the literal `"local"`, matching the `LocalHost` construction.

- [ ] **Step 1: Write the failing test**

`src/server/bootstrap.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ensureLocalHost, LOCAL_HOST_ID } from '@server/bootstrap'
import { createDb, runMigrations } from '@server/db/client'
import { hosts } from '@server/db/schema'

const config = { composeRoot: '/volume2/docker', dockerSocket: '/var/run/docker.sock' }

async function freshDb() {
  const { db } = await createDb(':memory:')
  await runMigrations(db)
  return db
}

describe('ensureLocalHost', () => {
  it('creates the row on first run', async () => {
    const db = await freshDb()
    const id = await ensureLocalHost(db, config)
    expect(id).toBe(LOCAL_HOST_ID)
    const [row] = await db.select().from(hosts).where(eq(hosts.id, LOCAL_HOST_ID))
    expect(row?.composeRoot).toBe('/volume2/docker')
  })

  it('is idempotent across restarts', async () => {
    const db = await freshDb()
    await ensureLocalHost(db, config)
    await ensureLocalHost(db, config)
    expect(await db.select().from(hosts)).toHaveLength(1)
  })

  it('updates the paths when configuration changes', async () => {
    const db = await freshDb()
    await ensureLocalHost(db, config)
    await ensureLocalHost(db, { ...config, composeRoot: '/mnt/pool/docker' })
    const [row] = await db.select().from(hosts)
    expect(row?.composeRoot).toBe('/mnt/pool/docker')
    expect(await db.select().from(hosts)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/bootstrap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/bootstrap.ts`**

```ts
import type { Db } from './db/client.js'
import { hosts } from './db/schema.js'

/** Matches the id `index.ts` passes to `new LocalHost(...)`. They must not drift. */
export const LOCAL_HOST_ID = 'local'

/**
 * Ensures the row `apps.hostId` points at exists.
 *
 * Upserts rather than insert-if-absent so that changing HOMESTEAD_COMPOSE_ROOT is
 * reflected instead of silently ignored — the row is configuration, not history.
 */
export async function ensureLocalHost(
  db: Db,
  config: { composeRoot: string; dockerSocket: string },
): Promise<string> {
  await db
    .insert(hosts)
    .values({
      id: LOCAL_HOST_ID,
      name: 'local',
      kind: 'local',
      composeRoot: config.composeRoot,
      dockerSocket: config.dockerSocket,
    })
    .onConflictDoUpdate({
      target: hosts.id,
      set: { composeRoot: config.composeRoot, dockerSocket: config.dockerSocket },
    })

  return LOCAL_HOST_ID
}
```

- [ ] **Step 4: Call it from `src/server/index.ts`**

After `await runMigrations(db)` and before the `LocalHost` construction, add:

```ts
import { ensureLocalHost, LOCAL_HOST_ID } from './bootstrap.js'

await ensureLocalHost(db, config)
```

and change the host construction to use the shared constant:

```ts
const host = new LocalHost(LOCAL_HOST_ID, config.composeRoot, config.dockerSocket)
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run src/server/bootstrap.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/bootstrap.ts src/server/bootstrap.test.ts src/server/index.ts
git commit -m "feat: seed the local host row at startup"
```

---

### Task 3: `runCompose` on the Host

**Files:**
- Modify: `src/server/host/types.ts`, `src/server/host/local-host.ts`, `src/server/test-helpers.ts`
- Test: `src/server/host/run-compose.test.ts`

**Interfaces:**
- Consumes: `PathGuard` (already used by `LocalHost`)
- Produces:

```ts
export type ComposeTarget = { directory: string; composeFile: string }
export type ComposeResult = { exitCode: number; stdout: string; stderr: string }
export type ComposeOptions = {
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
  timeoutMs?: number
}
// on Host:
runCompose(target: ComposeTarget, args: string[], opts?: ComposeOptions): Promise<ComposeResult>
```

`ComposeTarget` is a structural pair rather than an `apps` row so the host layer keeps no dependency on the database schema. The optional `onOutput` exists now, unused, so Phase 1B-ii can stream lifecycle output without changing this signature.

- [ ] **Step 1: Write the failing test**

`src/server/host/run-compose.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalHost } from '@server/host/local-host'

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker({ socketPath: '/var/run/docker.sock' }).ping()
    return true
  } catch {
    return false
  }
}
const hasDocker = await dockerAvailable()

let root: string
let host: LocalHost

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hs-compose-'))
  await mkdir(join(root, 'good'), { recursive: true })
  await writeFile(
    join(root, 'good', 'compose.yaml'),
    'services:\n  web:\n    image: nginx:alpine\n',
  )
  await mkdir(join(root, 'bad'), { recursive: true })
  await writeFile(
    join(root, 'bad', 'compose.yaml'),
    'services:\n  web:\n    image: nginx\n    depends_on: [ghost]\n',
  )
  host = new LocalHost('local', root, '/var/run/docker.sock')
  await host.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(!hasDocker)('runCompose', () => {
  it('exits 0 and returns stdout for a valid project', async () => {
    const result = await host.runCompose(
      { directory: 'good', composeFile: 'compose.yaml' },
      ['config', '--format', 'json'],
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).services.web.image).toBe('nginx:alpine')
  })

  it('exits non-zero with a usable message for an invalid project', async () => {
    const result = await host.runCompose(
      { directory: 'bad', composeFile: 'compose.yaml' },
      ['config'],
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('ghost')
  })

  it('streams output when a callback is supplied', async () => {
    const chunks: string[] = []
    await host.runCompose(
      { directory: 'good', composeFile: 'compose.yaml' },
      ['config'],
      { onOutput: (chunk) => chunks.push(chunk) },
    )
    expect(chunks.join('')).toContain('nginx:alpine')
  })

  it('survives an onOutput callback that throws, without killing the process', async () => {
    // Measured before this guard existed: the throw escaped as an uncaughtException
    // while the promise still resolved with exitCode 0 and the full output — so a
    // caller saw success while the process died. Phase 1B-ii passes an SSE writer
    // here, and a disconnected client is ordinary, not exceptional.
    const seen: string[] = []
    const onUncaught = (error: Error) => seen.push(String(error.message))
    // Removed in `finally`. Vitest runs many files in one worker, so a listener left
    // registered would intercept the FIRST genuine uncaughtException anywhere later in
    // the run and quietly prevent the crash that should have failed the suite — an
    // uncaughtException handler is the worst kind to leak, since its whole job is
    // swallowing the signal that something went badly wrong.
    process.on('uncaughtException', onUncaught)

    let result: Awaited<ReturnType<typeof host.runCompose>>
    try {
      result = await host.runCompose(
        { directory: 'good', composeFile: 'compose.yaml' },
        ['config', '--format', 'json'],
        { onOutput: () => { throw new Error('SSE client disconnected') } },
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      process.removeListener('uncaughtException', onUncaught)
    }

    expect(seen).toEqual([])
    // Capture must continue despite the failing consumer.
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).services.web.image).toBe('nginx:alpine')
  })

  it('refuses a directory outside the compose root', async () => {
    await expect(
      host.runCompose({ directory: '../escape', composeFile: 'compose.yaml' }, ['config']),
    ).rejects.toThrow()
  })

  it('passes arguments as an array, so shell metacharacters are inert', async () => {
    // If args were concatenated into a shell string this would execute `id`.
    const result = await host.runCompose(
      { directory: 'good', composeFile: 'compose.yaml' },
      ['config', '--format', 'json; id'],
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toMatch(/uid=\d+/)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/host/run-compose.test.ts`
Expected: FAIL — `host.runCompose is not a function`.

- [ ] **Step 3: Extend `src/server/host/types.ts`**

Add these types and the interface method:

```ts
export type ComposeTarget = { directory: string; composeFile: string }

export type ComposeResult = { exitCode: number; stdout: string; stderr: string }

export type ComposeOptions = {
  /** Called as output arrives. Phase 1B-ii uses this for lifecycle job streaming. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
  /** Defaults to 60s. Lifecycle operations in 1B-ii will raise it. */
  timeoutMs?: number
}
```

and inside `interface Host`:

```ts
  runCompose(
    target: ComposeTarget,
    args: string[],
    opts?: ComposeOptions,
  ): Promise<ComposeResult>
```

- [ ] **Step 4: Implement it in `src/server/host/local-host.ts`**

```ts
import { execFile } from 'node:child_process'

  async runCompose(
    target: ComposeTarget,
    args: string[],
    opts: ComposeOptions = {},
  ): Promise<ComposeResult> {
    // PathGuard resolves and confines the compose file, so a caller cannot point the
    // CLI at a path outside the compose root.
    const composePath = await this.guard.resolveExisting(
      join(target.directory, target.composeFile),
    )

    // execFile with an ARGUMENT ARRAY — never a shell string. `args` reaches us from
    // request handlers, and a concatenated command would be an injection point.
    const child = execFile(
      'docker',
      ['compose', '-f', composePath, ...args],
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
    )

    let stdout = ''
    let stderr = ''

    /**
     * A throw from `onOutput` must not escape.
     *
     * These run inside stream 'data' handlers, so a synchronous throw propagates out of
     * `emit()` and becomes an `uncaughtException` — measured: the promise still resolved
     * with `exitCode: 0` and the full output, while the process died. A caller would see
     * success. Phase 1B-ii passes an SSE writer here, and a disconnected client is an
     * ordinary event, not an exceptional one.
     */
    const emit = (text: string, stream: 'stdout' | 'stderr') => {
      try {
        opts.onOutput?.(text, stream)
      } catch {
        // The consumer's problem, not the subprocess's. Capture continues either way.
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
      emit(text, 'stdout')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      emit(text, 'stderr')
    })

    const exitCode = await new Promise<number>((resolve) => {
      // 'close' rather than 'exit': it fires after the streams have drained, so no
      // output is lost. `error` (spawn failure, timeout kill) also lands here.
      child.on('close', (code) => resolve(code ?? 1))
      child.on('error', () => resolve(1))
    })

    return { exitCode, stdout, stderr }
  }
```

Add `ComposeOptions`, `ComposeResult` and `ComposeTarget` to the type import from `./types.js`.

- [ ] **Step 5: Add `runCompose` to `FakeHost` in `src/server/test-helpers.ts`**

The fake must stay contract-compliant — Phase 1A's review rated a permissive fake Critical, because tests written against it certify behaviour the real implementation rejects.

```ts
  /** Scripted results, keyed by the joined args. Unmatched calls throw rather than
   *  returning a plausible empty success, which would let a test pass vacuously. */
  composeResults = new Map<string, ComposeResult>()
  composeCalls: Array<{ target: ComposeTarget; args: string[] }> = []

  async runCompose(
    target: ComposeTarget,
    args: string[],
    opts: ComposeOptions = {},
  ): Promise<ComposeResult> {
    this.composeCalls.push({ target, args })
    const result = this.composeResults.get(args.join(' '))
    if (!result) throw new Error(`FakeHost: no scripted compose result for: ${args.join(' ')}`)
    // Same swallow as LocalHost: a fake that propagates a callback throw would make
    // tests pass or fail differently from production.
    const emit = (text: string, stream: 'stdout' | 'stderr') => {
      try {
        opts.onOutput?.(text, stream)
      } catch {
        /* consumer's problem */
      }
    }
    if (result.stdout) emit(result.stdout, 'stdout')
    if (result.stderr) emit(result.stderr, 'stderr')
    return result
  }
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run src/server/host/run-compose.test.ts && pnpm test`
Expected: the focused file passes 5 tests with Docker present; the full suite stays green.

- [ ] **Step 7: Commit**

```bash
git add src/server/host/types.ts src/server/host/local-host.ts src/server/host/run-compose.test.ts src/server/test-helpers.ts
git commit -m "feat: add runCompose to the Host seam"
```

---

### Task 4: Resolved compose config, cached by file hash

**Files:**
- Create: `src/server/apps/compose-config.ts`
- Test: `src/server/apps/compose-config.test.ts`

**Interfaces:**
- Consumes: `Host.runCompose`, `Host.readTextFile`
- Produces:

```ts
export type ResolvedService = {
  name: string
  image: string | null
  restart: string | null
  publishedPorts: number[]
}
export type ResolvedCompose = { projectName: string; services: ResolvedService[] }
export type ComposeValidation =
  | { valid: true; resolved: ResolvedCompose }
  | { valid: false; message: string }

export class ComposeConfigCache {
  constructor(host: Host)
  resolve(target: ComposeTarget): Promise<ComposeValidation>
  invalidate(target: ComposeTarget): void
}
```

**Three behaviours measured against Compose v5.5.1, which simplify this considerably:**

1. `config --format json` **already resolves `COMPOSE_PROJECT_NAME` from the sibling `.env`** and returns it as `name`. A directory with `COMPOSE_PROJECT_NAME=custom-name` reported `custom-name`. Do not hand-parse `.env` for it.
2. **Services gated behind an inactive profile are already excluded** from the output. A service with `profiles: ["debug"]` did not appear at all. The expected service set is exactly `Object.keys(config.services)` — no filtering needed.
3. Validation failures **exit non-zero with a usable stderr message**: a semantic error gave `service "web" depends on undefined service "ghost": invalid compose project`, and a syntax error gave `go-yaml load error in parser (while parsing a flow sequence) at L3.C11-L4.C1: …`. The line/column in the second is what the editor needs for inline errors.

- [ ] **Step 1: Write the failing test**

`src/server/apps/compose-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ComposeConfigCache } from '@server/apps/compose-config'
import { FakeHost } from '@server/test-helpers'

const target = { directory: 'jellyfin', composeFile: 'compose.yaml' }

const configJson = JSON.stringify({
  name: 'jellyfin',
  services: {
    web: { image: 'jellyfin/jellyfin:latest', ports: [{ published: '8096', target: 8096 }] },
    init: { image: 'alpine', restart: 'no' },
  },
})

function hostWith(stdout: string, exitCode = 0, stderr = '') {
  const host = new FakeHost()
  host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  host.composeResults.set('config --format json', { exitCode, stdout, stderr })
  return host
}

describe('ComposeConfigCache', () => {
  it('resolves the project name and services', async () => {
    const cache = new ComposeConfigCache(hostWith(configJson))
    const result = await cache.resolve(target)
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.resolved.projectName).toBe('jellyfin')
    expect(result.resolved.services.map((s) => s.name).sort()).toEqual(['init', 'web'])
    expect(result.resolved.services.find((s) => s.name === 'web')?.publishedPorts).toEqual([8096])
    expect(result.resolved.services.find((s) => s.name === 'init')?.restart).toBe('no')
  })

  it('reports a validation failure with the CLI message', async () => {
    const cache = new ComposeConfigCache(
      hostWith('', 1, 'service "web" depends on undefined service "ghost": invalid compose project'),
    )
    const result = await cache.resolve(target)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.message).toContain('ghost')
  })

  it('does not re-run the CLI while the file hash is unchanged', async () => {
    const host = hostWith(configJson)
    const cache = new ComposeConfigCache(host)
    await cache.resolve(target)
    await cache.resolve(target)
    await cache.resolve(target)
    expect(host.composeCalls).toHaveLength(1)
  })

  it('re-runs the CLI after the file changes on disk', async () => {
    const host = hostWith(configJson)
    const cache = new ComposeConfigCache(host)
    await cache.resolve(target)
    host.files.set('jellyfin/compose.yaml', 'services:\n  web:\n    image: nginx\n')
    await cache.resolve(target)
    expect(host.composeCalls).toHaveLength(2)
  })

  it('re-runs the CLI after explicit invalidation', async () => {
    const host = hostWith(configJson)
    const cache = new ComposeConfigCache(host)
    await cache.resolve(target)
    cache.invalidate(target)
    await cache.resolve(target)
    expect(host.composeCalls).toHaveLength(2)
  })

  it.each([
    ['malformed JSON', '{"incomplete'],
    ['empty output', ''],
    ['JSON that is not an object', '"just a string"'],
    ['services reported as a string', '{"name":"a","services":"nope"}'],
    ['a null service entry', '{"name":"a","services":{"web":null}}'],
  ])('returns a failure rather than throwing for %s', async (_label, stdout) => {
    // Every one of these was measured against an earlier version: the first three threw
    // SyntaxError, the null service threw TypeError, and `"services":"nope"` returned
    // valid:true carrying four bogus services because Object.entries enumerates a
    // string's characters. A non-object service must FAIL rather than be filtered —
    // dropping it would shrink the expected set the status rollup checks against.
    const cache = new ComposeConfigCache(hostWith(stdout))
    const result = await cache.resolve(target)
    expect(result.valid).toBe(false)
  })

  it('drops port shapes Number() cannot read, keeping the rest', async () => {
    // "8080-8090" and "127.0.0.1:9000" are legal compose and both yield NaN. Ports are
    // advisory (launch-URL suggestions), so they are dropped rather than failing.
    const ports = JSON.stringify({
      name: 'a',
      services: {
        web: { image: 'x', ports: [
          { published: '8080-8090' }, { published: '127.0.0.1:9000' }, { published: '7000' },
        ] },
      },
    })
    const result = await new ComposeConfigCache(hostWith(ports)).resolve(target)
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.resolved.services[0]?.publishedPorts).toEqual([7000])
  })

  it('does not confuse two targets whose concatenated paths are identical', async () => {
    const host = new FakeHost()
    host.files.set('foo/bar/compose.yaml', 'A')
    host.composeResults.set('config --format json', {
      exitCode: 0, stdout: '{"name":"A","services":{}}', stderr: '',
    })
    const cache = new ComposeConfigCache(host)
    await cache.resolve({ directory: 'foo', composeFile: 'bar/compose.yaml' })
    await cache.resolve({ directory: 'foo/bar', composeFile: 'compose.yaml' })
    // One call would mean the second target read the first's cached entry.
    expect(host.composeCalls).toHaveLength(2)
  })

  it('re-runs the CLI when only the sibling .env changed', async () => {
    const host = hostWith(configJson)
    host.files.set('jellyfin/.env', 'COMPOSE_PROJECT_NAME=one\n')
    const cache = new ComposeConfigCache(host)
    await cache.resolve(target)
    host.files.set('jellyfin/.env', 'COMPOSE_PROJECT_NAME=two\n')
    await cache.resolve(target)
    // compose.yaml is untouched, but the CLI resolves the project name from .env.
    expect(host.composeCalls).toHaveLength(2)
  })

  it('does not cache a failure, so fixing the file recovers without a restart', async () => {
    const host = hostWith('', 1, 'invalid compose project')
    const cache = new ComposeConfigCache(host)
    expect((await cache.resolve(target)).valid).toBe(false)
    host.composeResults.set('config --format json', { exitCode: 0, stdout: configJson, stderr: '' })
    expect((await cache.resolve(target)).valid).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/apps/compose-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/apps/compose-config.ts`**

```ts
import type { ComposeTarget, Host } from '../host/types.js'

export type ResolvedService = {
  name: string
  image: string | null
  restart: string | null
  publishedPorts: number[]
}

export type ResolvedCompose = { projectName: string; services: ResolvedService[] }

export type ComposeValidation =
  | { valid: true; resolved: ResolvedCompose }
  | { valid: false; message: string }

type ParseOutcome =
  | { ok: true; resolved: ResolvedCompose }
  | { ok: false; message: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Parses `docker compose config --format json` defensively.
 *
 * Everything here is a guard against a measured failure, not hypothetical caution.
 * Against the previous version: malformed JSON and empty stdout threw `SyntaxError`,
 * a `null` service threw `TypeError`, and — worst — `"services": "nope"` returned
 * `valid: true` carrying four bogus services, because `Object.entries` on a string
 * enumerates its characters. This function returns a result; it never throws.
 *
 * A service entry that is not an object FAILS the parse rather than being filtered
 * out. Dropping it would shrink the expected service set, and Task 7 rolls container
 * states up against that set — so a silently missing service would report a degraded
 * stack as healthy. Failing closed is the only safe direction here.
 */
function parseResolved(stdout: string): ParseOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return { ok: false, message: 'docker compose config produced output that is not JSON' }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, message: 'docker compose config produced JSON that is not an object' }
  }

  const rawServices = raw.services ?? {}
  if (!isPlainObject(rawServices)) {
    return { ok: false, message: 'docker compose config reported `services` as a non-object' }
  }

  const services: ResolvedService[] = []
  for (const [name, service] of Object.entries(rawServices)) {
    if (!isPlainObject(service)) {
      return { ok: false, message: `docker compose config reported service "${name}" as a non-object` }
    }
    // Ports are advisory — they feed launch-URL suggestions, not correctness — so a
    // shape Number() cannot read is dropped rather than failing the whole resolve.
    // Measured: "8080-8090" and "127.0.0.1:9000" both yield NaN and are discarded.
    const rawPorts = Array.isArray(service.ports) ? service.ports : []
    const publishedPorts = rawPorts
      .map((entry) => (isPlainObject(entry) ? Number(entry.published) : Number.NaN))
      .filter((port) => Number.isFinite(port) && port > 0)

    services.push({
      name,
      image: stringOrNull(service.image),
      restart: stringOrNull(service.restart),
      publishedPorts,
    })
  }

  return { ok: true, resolved: { projectName: stringOrNull(raw.name) ?? '', services } }
}

/**
 * Resolves `docker compose config` and caches the result against the compose file's
 * hash.
 *
 * The CLI is the only correct implementation of compose semantics — it resolves
 * `COMPOSE_PROJECT_NAME` from the sibling `.env`, applies override files and `extends`,
 * interpolates `${VAR}`, and omits services behind inactive profiles. All four were
 * measured. Hand-parsing the YAML would get every one of them wrong.
 *
 * Caching matters because this runs a subprocess: the status rollup consults it on
 * every read, and spawning a process per request would make the app list quadratic in
 * cost on a NAS.
 */
export class ComposeConfigCache {
  private readonly entries = new Map<string, { hash: string; resolved: ResolvedCompose }>()

  constructor(private readonly host: Host) {}

  /**
   * Unambiguous key. Template concatenation collides across the path boundary —
   * measured: `{directory:'foo', composeFile:'bar/compose.yaml'}` and
   * `{directory:'foo/bar', composeFile:'compose.yaml'}` produced the same key, and the
   * second target received the first's cached config with `valid: true`.
   */
  private key(target: ComposeTarget): string {
    return JSON.stringify([target.directory, target.composeFile])
  }

  invalidate(target: ComposeTarget): void {
    this.entries.delete(this.key(target))
  }

  /**
   * Hash of every file the CLI's output depends on.
   *
   * The compose file is not the only input: compose resolves `COMPOSE_PROJECT_NAME`
   * and `${VAR}` interpolation from the sibling `.env`, both measured. Hashing only
   * `compose.yaml` would serve a stale project name after an SSH edit to `.env` — and
   * an out-of-band edit is precisely the case content hashing exists to catch. A
   * missing `.env` is normal and contributes a constant.
   */
  private async inputHash(target: ComposeTarget): Promise<string> {
    const compose = await this.host.readTextFile(
      `${target.directory}/${target.composeFile}`,
    )
    const env = await this.host
      .readTextFile(`${target.directory}/.env`)
      .then((file) => file.hash)
      .catch(() => 'absent')
    return `${compose.hash}:${env}`
  }

  async resolve(target: ComposeTarget): Promise<ComposeValidation> {
    const key = this.key(target)
    const hash = await this.inputHash(target)

    const cached = this.entries.get(key)
    if (cached && cached.hash === hash) return { valid: true, resolved: cached.resolved }

    const result = await this.host.runCompose(target, ['config', '--format', 'json'])

    if (result.exitCode !== 0) {
      // Deliberately not cached. A failure is a state the user is actively fixing, and
      // caching it would make the editor report a stale error after a correct save.
      this.entries.delete(key)
      return { valid: false, message: (result.stderr || result.stdout).trim() }
    }

    const parsed = parseResolved(result.stdout)
    if (!parsed.ok) {
      // Same reasoning as an exit-code failure: not cached, and surfaced as a result
      // rather than thrown, because callers destructure a discriminated union.
      this.entries.delete(key)
      return { valid: false, message: parsed.message }
    }

    this.entries.set(key, { hash, resolved: parsed.resolved })
    return { valid: true, resolved: parsed.resolved }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/apps/compose-config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/apps/compose-config.ts src/server/apps/compose-config.test.ts
git commit -m "feat: resolve and cache docker compose config by file hash"
```

---

### Task 5: `.env` parsing, serialising, and masking

**Files:**
- Create: `src/server/apps/env-file.ts`
- Test: `src/server/apps/env-file.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:

```ts
export type EnvEntry =
  | { kind: 'pair'; key: string; value: string; raw: string }
  | { kind: 'other'; raw: string }        // comments and blank lines
export function parseEnv(content: string): EnvEntry[]
export function serialiseEnv(entries: EnvEntry[]): string
export function maskEnv(entries: EnvEntry[]): Array<{ key: string; masked: string }>
export function upsertEnv(entries: EnvEntry[], key: string, value: string): EnvEntry[]
```

Round-tripping must be lossless. These files are hand-maintained over SSH and full of comments explaining why a variable is set; an editor that silently drops them is worse than no editor. `.env` also holds database passwords and API keys, so values are masked in every response by default.

- [ ] **Step 1: Write the failing test**

`src/server/apps/env-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { maskEnv, parseEnv, serialiseEnv, upsertEnv } from '@server/apps/env-file'

const sample = [
  '# Database credentials',
  'DB_PASSWORD=hunter2',
  '',
  'PUID=1000   # the media user',
  'EMPTY=',
  'QUOTED="has spaces"',
  '#DISABLED=not-active',
].join('\n')

describe('parseEnv / serialiseEnv', () => {
  it('round-trips byte-for-byte', () => {
    expect(serialiseEnv(parseEnv(sample))).toBe(sample)
  })

  it('extracts pairs and preserves everything else verbatim', () => {
    const entries = parseEnv(sample)
    const pairs = entries.filter((e) => e.kind === 'pair')
    expect(pairs.map((p) => p.kind === 'pair' && p.key)).toEqual([
      'DB_PASSWORD', 'PUID', 'EMPTY', 'QUOTED',
    ])
    // A commented-out assignment is a comment, not a pair.
    expect(pairs.some((p) => p.kind === 'pair' && p.key === 'DISABLED')).toBe(false)
  })

  it('keeps an empty value distinct from an absent key', () => {
    const empty = parseEnv(sample).find((e) => e.kind === 'pair' && e.key === 'EMPTY')
    expect(empty?.kind === 'pair' && empty.value).toBe('')
  })

  it('round-trips a file with no trailing newline', () => {
    expect(serialiseEnv(parseEnv('A=1'))).toBe('A=1')
  })

  it('round-trips a file with a trailing newline', () => {
    expect(serialiseEnv(parseEnv('A=1\n'))).toBe('A=1\n')
  })
})

describe('maskEnv', () => {
  it('never returns a value', () => {
    const masked = maskEnv(parseEnv(sample))
    expect(JSON.stringify(masked)).not.toContain('hunter2')
    expect(JSON.stringify(masked)).not.toContain('has spaces')
  })

  it('reports each key with a fixed-width mask, leaking no length', () => {
    const masked = maskEnv(parseEnv('SHORT=a\nLONG=aaaaaaaaaaaaaaaaaaaaaaaa'))
    expect(masked).toEqual([
      { key: 'SHORT', masked: '••••••••' },
      { key: 'LONG', masked: '••••••••' },
    ])
  })

  it('distinguishes an empty value, which is not a secret', () => {
    expect(maskEnv(parseEnv('EMPTY='))).toEqual([{ key: 'EMPTY', masked: '' }])
  })
})

describe('upsertEnv', () => {
  it('updates in place, preserving position and surrounding lines', () => {
    const updated = upsertEnv(parseEnv(sample), 'PUID', '1001')
    const text = serialiseEnv(updated)
    expect(text).toContain('PUID=1001')
    expect(text).toContain('# Database credentials')
    expect(text.indexOf('PUID')).toBeLessThan(text.indexOf('EMPTY'))
  })

  it('appends a new key at the end', () => {
    const text = serialiseEnv(upsertEnv(parseEnv('A=1\n'), 'B', '2'))
    expect(text).toBe('A=1\nB=2\n')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/apps/env-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/apps/env-file.ts`**

```ts
export type EnvEntry =
  | { kind: 'pair'; key: string; value: string; raw: string }
  | { kind: 'other'; raw: string }

/** Fixed width, so the mask reveals nothing about the secret's length. */
const MASK = '••••••••'

const PAIR = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/**
 * Parses `.env` while retaining every original line in `raw`.
 *
 * Serialising reassembles from `raw`, so comments, blank lines, spacing and
 * commented-out assignments survive a round trip untouched. These files are
 * hand-maintained over SSH and their comments carry real information.
 */
export function parseEnv(content: string): EnvEntry[] {
  if (content === '') return []
  // Splitting on '\n' keeps a trailing newline representable as a final empty line,
  // which is what makes byte-for-byte round-tripping work.
  return content.split('\n').map((line) => {
    const match = PAIR.exec(line)
    if (!match) return { kind: 'other', raw: line }
    const [, key, rest] = match
    if (key === undefined) return { kind: 'other', raw: line }
    return { kind: 'pair', key, value: (rest ?? '').trim(), raw: line }
  })
}

export function serialiseEnv(entries: EnvEntry[]): string {
  return entries.map((e) => e.raw).join('\n')
}

export function maskEnv(entries: EnvEntry[]): Array<{ key: string; masked: string }> {
  return entries
    .filter((e): e is Extract<EnvEntry, { kind: 'pair' }> => e.kind === 'pair')
    .map((e) => ({ key: e.key, masked: e.value === '' ? '' : MASK }))
}

/** Replaces a key's value in place, or appends it before any trailing blank line. */
export function upsertEnv(entries: EnvEntry[], key: string, value: string): EnvEntry[] {
  const index = entries.findIndex((e) => e.kind === 'pair' && e.key === key)
  if (index >= 0) {
    const next = [...entries]
    next[index] = { kind: 'pair', key, value, raw: `${key}=${value}` }
    return next
  }

  const trailingBlank = entries.length > 0 && entries[entries.length - 1]?.raw === ''
  const newEntry: EnvEntry = { kind: 'pair', key, value, raw: `${key}=${value}` }
  return trailingBlank
    ? [...entries.slice(0, -1), newEntry, { kind: 'other', raw: '' }]
    : [...entries, newEntry]
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/apps/env-file.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/apps/env-file.ts src/server/apps/env-file.test.ts
git commit -m "feat: add lossless .env parsing with value masking"
```

---

### Task 6: Adoption scan

**Files:**
- Create: `src/server/apps/adoption.ts`
- Test: `src/server/apps/adoption.test.ts`

**Interfaces:**
- Consumes: `Host.listAppDirectories`, `Host.listContainers`, `Db`
- Produces:

```ts
export type DiscoveredApp = {
  directory: string
  composeFile: string
  projectName: string | null   // null when nothing is running and config was not resolved
  containerCount: number
  running: boolean
  adopted: boolean
}
export type OrphanStack = { projectName: string; containerCount: number }
export type ScanResult = { discovered: DiscoveredApp[]; orphans: OrphanStack[] }
export function scanForApps(deps): Promise<ScanResult>
```

The scan joins two independent sources — directories under the compose root containing a compose file, and containers carrying `com.docker.compose.project` labels. Three buckets fall out, and each is meaningful: adoptable and up, adoptable and down, and **orphan** (containers running with no directory, meaning the files moved or were deleted).

- [ ] **Step 1: Write the failing test**

`src/server/apps/adoption.test.ts`:

```ts
import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { scanForApps } from '@server/apps/adoption'
import { createDb, runMigrations } from '@server/db/client'
import { apps, hosts } from '@server/db/schema'
import { FakeHost } from '@server/test-helpers'
import type { ContainerSummary } from '@server/host/types'

const container = (project: string, service: string, state = 'running'): ContainerSummary => ({
  id: ulid(), names: [`${project}-${service}`], image: 'x', state,
  status: state === 'running' ? 'Up 2 hours' : 'Exited (0)',
  project, service, labels: { 'com.docker.compose.project': project },
})

async function seed() {
  const { db } = await createDb(':memory:')
  await runMigrations(db)
  await db.insert(hosts).values({
    id: 'local', name: 'local', composeRoot: '/volume2/docker', dockerSocket: '/var/run/docker.sock',
  })
  return db
}

function hostWith(dirs: Array<[string, string]>, containers: ContainerSummary[]) {
  const host = new FakeHost()
  for (const [dir, file] of dirs) host.files.set(`${dir}/${file}`, 'services: {}\n')
  host.containers = containers
  return host
}

describe('scanForApps', () => {
  it('classifies running, stopped, and orphaned stacks', async () => {
    const db = await seed()
    const host = hostWith(
      [['jellyfin', 'compose.yaml'], ['paperless', 'compose.yaml']],
      [container('jellyfin', 'web'), container('jellyfin', 'db'), container('ghost', 'web')],
    )
    const result = await scanForApps({ db, host, hostId: 'local' })

    const jellyfin = result.discovered.find((d) => d.directory === 'jellyfin')
    expect(jellyfin).toMatchObject({ containerCount: 2, running: true, adopted: false })

    const paperless = result.discovered.find((d) => d.directory === 'paperless')
    expect(paperless).toMatchObject({ containerCount: 0, running: false, adopted: false })

    expect(result.orphans).toEqual([{ projectName: 'ghost', containerCount: 1 }])
  })

  it('marks already-adopted directories so the UI can skip them', async () => {
    const db = await seed()
    await db.insert(apps).values({
      id: ulid(), hostId: 'local', slug: 'jellyfin', displayName: 'Jellyfin',
      directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
    })
    const host = hostWith([['jellyfin', 'compose.yaml']], [container('jellyfin', 'web')])
    const result = await scanForApps({ db, host, hostId: 'local' })
    expect(result.discovered.find((d) => d.directory === 'jellyfin')?.adopted).toBe(true)
  })

  it('does not report an adopted app as an orphan', async () => {
    const db = await seed()
    await db.insert(apps).values({
      id: ulid(), hostId: 'local', slug: 'jellyfin', displayName: 'Jellyfin',
      directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
    })
    const host = hostWith([['jellyfin', 'compose.yaml']], [container('jellyfin', 'web')])
    expect((await scanForApps({ db, host, hostId: 'local' })).orphans).toEqual([])
  })

  it('counts stopped containers but does not call the stack running', async () => {
    const db = await seed()
    const host = hostWith(
      [['immich', 'compose.yaml']],
      [container('immich', 'web', 'exited'), container('immich', 'db', 'exited')],
    )
    const result = await scanForApps({ db, host, hostId: 'local' })
    expect(result.discovered[0]).toMatchObject({ containerCount: 2, running: false })
  })

  it('returns empty results for an empty compose root', async () => {
    const db = await seed()
    const result = await scanForApps({ db, host: hostWith([], []), hostId: 'local' })
    expect(result).toEqual({ discovered: [], orphans: [] })
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/apps/adoption.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/apps/adoption.ts`**

```ts
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { apps } from '../db/schema.js'
import type { Host } from '../host/types.js'

export type DiscoveredApp = {
  directory: string
  composeFile: string
  projectName: string | null
  containerCount: number
  running: boolean
  adopted: boolean
}

export type OrphanStack = { projectName: string; containerCount: number }

export type ScanResult = { discovered: DiscoveredApp[]; orphans: OrphanStack[] }

/**
 * Joins directories on disk to containers labelled with a compose project.
 *
 * The project name is NOT guessed from the directory name. Compose normalises it
 * (`My Media` becomes `mymedia`) and a `COMPOSE_PROJECT_NAME` in `.env` overrides it
 * entirely, so guessing reports a healthy stack as stopped. Here the running
 * containers' own label supplies it when they exist; adoption resolves it properly via
 * `docker compose config` when they do not.
 */
export async function scanForApps(deps: {
  db: Db
  host: Host
  hostId: string
}): Promise<ScanResult> {
  const [directories, containers, adoptedRows] = await Promise.all([
    deps.host.listAppDirectories(),
    deps.host.listContainers(),
    deps.db.select().from(apps).where(eq(apps.hostId, deps.hostId)),
  ])

  const adoptedByDirectory = new Map(adoptedRows.map((row) => [row.directory, row]))
  const adoptedProjects = new Set(adoptedRows.map((row) => row.projectName))

  const byProject = new Map<string, typeof containers>()
  for (const c of containers) {
    if (!c.project) continue
    const list = byProject.get(c.project) ?? []
    list.push(c)
    byProject.set(c.project, list)
  }

  const claimedProjects = new Set<string>()

  const discovered: DiscoveredApp[] = directories.map((dir) => {
    const adoptedRow = adoptedByDirectory.get(dir.directory)
    // Prefer the recorded project name; otherwise fall back to the directory name,
    // which is what Compose would derive when nothing overrides it.
    const candidate = adoptedRow?.projectName ?? dir.directory
    const matched = byProject.get(candidate)
    if (matched) claimedProjects.add(candidate)

    return {
      directory: dir.directory,
      composeFile: dir.composeFile,
      projectName: matched ? candidate : (adoptedRow?.projectName ?? null),
      containerCount: matched?.length ?? 0,
      running: (matched ?? []).some((c) => c.state === 'running'),
      adopted: adoptedRow !== undefined,
    }
  })

  const orphans: OrphanStack[] = [...byProject.entries()]
    .filter(([project]) => !claimedProjects.has(project) && !adoptedProjects.has(project))
    .map(([projectName, list]) => ({ projectName, containerCount: list.length }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName))

  return { discovered, orphans }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/apps/adoption.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/apps/adoption.ts src/server/apps/adoption.test.ts
git commit -m "feat: add adoption scan joining directories to compose containers"
```

---

### Task 7: Container status rollup

**Files:**
- Create: `src/server/apps/status.ts`
- Test: `src/server/apps/status.test.ts`

**Interfaces:**
- Consumes: `ResolvedService` from Task 4, `ContainerSummary` from the host layer
- Produces: `rollUpStatus(expected: ResolvedService[], containers: ContainerSummary[]): AppStatusSummary`

The rules come from spec section 4. The one that matters most: **a one-shot container that exited zero with `restart: "no"` is `completed`, not down.** Init and migration containers are normal, and treating them as failures would make most real stacks permanently red. The accepted cost is that a service which crashes and then exits cleanly reads as fine.

- [ ] **Step 1: Write the failing test**

`src/server/apps/status.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { rollUpStatus } from '@server/apps/status'
import type { ResolvedService } from '@server/apps/compose-config'
import type { ContainerSummary } from '@server/host/types'

const service = (name: string, restart: string | null = null): ResolvedService => ({
  name, image: 'x', restart, publishedPorts: [],
})

const container = (
  service: string,
  state: string,
  status = '',
): ContainerSummary => ({
  id: service, names: [service], image: 'x', state, status,
  project: 'p', service, labels: {},
})

describe('rollUpStatus', () => {
  it('is up when every expected service is running', () => {
    expect(rollUpStatus(
      [service('web'), service('db')],
      [container('web', 'running', 'Up 2 hours'), container('db', 'running', 'Up 2 hours (healthy)')],
    )).toMatchObject({ status: 'up' })
  })

  it('is up when a healthy container reports healthy', () => {
    expect(rollUpStatus(
      [service('db')],
      [container('db', 'running', 'Up 5 minutes (healthy)')],
    ).status).toBe('up')
  })

  it('is down when a container reports unhealthy', () => {
    expect(rollUpStatus(
      [service('db')],
      [container('db', 'running', 'Up 5 minutes (unhealthy)')],
    ).status).toBe('down')
  })

  it('is starting while a health check is still starting', () => {
    expect(rollUpStatus(
      [service('db')],
      [container('db', 'running', 'Up 3 seconds (health: starting)')],
    ).status).toBe('starting')
  })

  it('is degraded when a container is restarting', () => {
    expect(rollUpStatus(
      [service('web')],
      [container('web', 'restarting', 'Restarting (1) 5 seconds ago')],
    ).status).toBe('degraded')
  })

  it('is down when an expected service has no container at all', () => {
    expect(rollUpStatus([service('web'), service('db')], [container('web', 'running')]).status)
      .toBe('down')
  })

  // The rule that keeps real stacks from reading as permanently broken.
  it('treats an exited-zero one-shot with restart:no as completed, not down', () => {
    const result = rollUpStatus(
      [service('web'), service('init', 'no')],
      [container('web', 'running', 'Up 2 hours'), container('init', 'exited', 'Exited (0) 2 hours ago')],
    )
    expect(result.status).toBe('up')
    expect(result.detail).toContain('1 completed')
  })

  it('is down when a one-shot exits non-zero', () => {
    expect(rollUpStatus(
      [service('web'), service('init', 'no')],
      [container('web', 'running'), container('init', 'exited', 'Exited (1) 2 hours ago')],
    ).status).toBe('down')
  })

  it('is down when a long-running service exits zero', () => {
    // No `restart: no`, so exiting is not this service's normal end state.
    expect(rollUpStatus(
      [service('web')],
      [container('web', 'exited', 'Exited (0) 2 hours ago')],
    ).status).toBe('down')
  })

  it('is unknown when the config resolved no services', () => {
    expect(rollUpStatus([], []).status).toBe('unknown')
  })

  it('summarises counts in the detail string', () => {
    const result = rollUpStatus(
      [service('a'), service('b'), service('c')],
      [container('a', 'running'), container('b', 'running')],
    )
    expect(result.detail).toBe('2/3 services up, 1 missing')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/apps/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/apps/status.ts`**

```ts
import type { AppStatusSummary } from './serialize.js'
import type { ResolvedService } from './compose-config.js'
import type { ContainerSummary } from '../host/types.js'

type ServiceState = 'up' | 'starting' | 'degraded' | 'down' | 'completed'

/**
 * Docker exposes health only in the human-readable status string — `Up 5 minutes
 * (healthy)`, `(unhealthy)`, `(health: starting)`. `listContainers` does not surface a
 * structured health field, so this parses it. Most images define no health check at
 * all, in which case a running container counts as up.
 */
function healthOf(status: string): 'healthy' | 'unhealthy' | 'starting' | 'none' {
  if (status.includes('(healthy)')) return 'healthy'
  if (status.includes('(unhealthy)')) return 'unhealthy'
  if (status.includes('health: starting')) return 'starting'
  return 'none'
}

function exitCodeOf(status: string): number | null {
  const match = /Exited \((\d+)\)/.exec(status)
  return match?.[1] === undefined ? null : Number(match[1])
}

function classify(service: ResolvedService, container: ContainerSummary | undefined): ServiceState {
  if (!container) return 'down'

  switch (container.state) {
    case 'running': {
      const health = healthOf(container.status)
      if (health === 'unhealthy') return 'down'
      if (health === 'starting') return 'starting'
      return 'up'
    }
    case 'restarting':
      return 'degraded'
    case 'created':
      return 'starting'
    case 'paused':
      return 'degraded'
    case 'exited': {
      // A one-shot init or migration container finishing cleanly is normal. Reporting
      // it as a failure would make most real stacks permanently red.
      const isOneShot = service.restart === null || service.restart === 'no'
      return isOneShot && exitCodeOf(container.status) === 0 ? 'completed' : 'down'
    }
    default:
      return 'down'
  }
}

export function rollUpStatus(
  expected: ResolvedService[],
  containers: ContainerSummary[],
): AppStatusSummary {
  if (expected.length === 0) return { status: 'unknown', detail: null }

  const byService = new Map(containers.map((c) => [c.service ?? '', c]))
  const states = expected.map((service) => classify(service, byService.get(service.name)))

  const count = (state: ServiceState) => states.filter((s) => s === state).length
  const up = count('up')
  const completed = count('completed')
  const missing = expected.filter((s) => !byService.has(s.name)).length

  const parts = [`${up}/${expected.length} services up`]
  if (completed > 0) parts.push(`${completed} completed`)
  if (missing > 0) parts.push(`${missing} missing`)
  const detail = parts.join(', ')

  if (states.includes('down')) return { status: 'down', detail }
  if (states.includes('degraded')) return { status: 'degraded', detail }
  if (states.includes('starting')) return { status: 'starting', detail }
  return { status: 'up', detail }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/apps/status.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/apps/status.ts src/server/apps/status.test.ts
git commit -m "feat: roll container states up to one app status"
```

---

### Task 8: Adoption and app CRUD API

**Files:**
- Create: `src/server/routes/apps.ts`
- Modify: `src/server/app.ts` (register the routes, add `composeConfig` to `AppDeps`)
- Test: `src/server/routes/apps.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces: `GET /api/apps/scan`, `POST /api/apps/adopt`, `GET /api/apps`, `GET /api/apps/:id`, `PATCH /api/apps/:id`, `DELETE /api/apps/:id`

Authorization: **scan, adopt, patch and delete require `app:config`; the list and detail reads require `app:read` and are scoped**. Viewers receive `ViewerApp`, admins receive `AdminApp`, chosen by `can(ctx, 'app:config')` rather than by an inline field check.

- [ ] **Step 1: Write the failing test**

`src/server/routes/apps.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp, signUpAdmin, createViewer } from '@server/test-helpers'

describe('app inventory API', () => {
  it('refuses the scan to a viewer', async () => {
    const app = await buildTestApp()
    const { cookie: adminCookie } = await signUpAdmin(app)
    const viewer = await createViewer(app, adminCookie)
    const res = await app.inject({ method: 'GET', url: '/api/apps/scan', headers: { cookie: viewer.cookie } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('adopts a discovered directory and resolves its project name', async () => {
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    app.deps.host.files.set('jellyfin/compose.yaml', 'services:\n  web:\n    image: nginx\n')
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 0,
      stdout: JSON.stringify({ name: 'custom-name', services: { web: { image: 'nginx' } } }),
      stderr: '',
    })

    const res = await app.inject({
      method: 'POST', url: '/api/apps/adopt', headers: { cookie },
      payload: { directories: ['jellyfin'] },
    })
    expect(res.statusCode).toBe(201)
    // The project name comes from compose, not from the directory name.
    expect(res.json().adopted[0].projectName).toBe('custom-name')
    await app.close()
  })

  it('refuses to adopt a directory with an invalid compose file', async () => {
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    app.deps.host.files.set('broken/compose.yaml', 'services: {}\n')
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 1, stdout: '', stderr: 'invalid compose project',
    })
    const res = await app.inject({
      method: 'POST', url: '/api/apps/adopt', headers: { cookie },
      payload: { directories: ['broken'] },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().failed[0].message).toContain('invalid compose project')
    await app.close()
  })

  it('is idempotent: adopting twice does not duplicate', async () => {
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 0, stdout: JSON.stringify({ name: 'jellyfin', services: {} }), stderr: '',
    })
    const body = { directories: ['jellyfin'] }
    await app.inject({ method: 'POST', url: '/api/apps/adopt', headers: { cookie }, payload: body })
    const second = await app.inject({ method: 'POST', url: '/api/apps/adopt', headers: { cookie }, payload: body })
    expect(second.statusCode).toBe(409)
    const list = await app.inject({ method: 'GET', url: '/api/apps', headers: { cookie } })
    expect(list.json()).toHaveLength(1)
    await app.close()
  })

  it('gives a viewer the viewer DTO and an admin the admin DTO', async () => {
    const app = await buildTestApp()
    const { cookie: adminCookie } = await signUpAdmin(app)
    app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 0, stdout: JSON.stringify({ name: 'jellyfin', services: {} }), stderr: '',
    })
    await app.inject({
      method: 'POST', url: '/api/apps/adopt', headers: { cookie: adminCookie },
      payload: { directories: ['jellyfin'] },
    })
    const viewer = await createViewer(app, adminCookie)

    const asAdmin = (await app.inject({ method: 'GET', url: '/api/apps', headers: { cookie: adminCookie } })).json()
    const asViewer = (await app.inject({ method: 'GET', url: '/api/apps', headers: { cookie: viewer.cookie } })).json()

    expect(asAdmin[0]).toHaveProperty('directory')
    expect(asViewer[0]).not.toHaveProperty('directory')
    expect(asViewer[0]).not.toHaveProperty('projectName')
    expect(asViewer[0]).toHaveProperty('displayName')
    await app.close()
  })

  it('hides apps outside a scoped viewer’s allowlist', async () => {
    const app = await buildTestApp()
    const { cookie: adminCookie } = await signUpAdmin(app)
    app.deps.host.files.set('a/compose.yaml', 'services: {}\n')
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 0, stdout: JSON.stringify({ name: 'a', services: {} }), stderr: '',
    })
    await app.inject({
      method: 'POST', url: '/api/apps/adopt', headers: { cookie: adminCookie },
      payload: { directories: ['a'] },
    })
    const viewer = await createViewer(app, adminCookie, { scopeAllApps: false, appIds: [] })
    const res = await app.inject({ method: 'GET', url: '/api/apps', headers: { cookie: viewer.cookie } })
    expect(res.json()).toEqual([])
    await app.close()
  })

  it('refuses to delete a system app', async () => {
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    app.deps.host.files.set('cloudflared/compose.yaml', 'services: {}\n')
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 0, stdout: JSON.stringify({ name: 'cloudflared', services: {} }), stderr: '',
    })
    const adopted = await app.inject({
      method: 'POST', url: '/api/apps/adopt', headers: { cookie },
      payload: { directories: ['cloudflared'] },
    })
    const id = adopted.json().adopted[0].id
    await app.deps.db.update(await import('@server/db/schema').then((m) => m.apps))
      .set({ isSystem: true })
    const res = await app.inject({ method: 'DELETE', url: `/api/apps/${id}`, headers: { cookie } })
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  it('returns 404 for an unknown app id', async () => {
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    const res = await app.inject({ method: 'GET', url: '/api/apps/nope', headers: { cookie } })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
```

- [ ] **Step 2: Add `signUpAdmin` and `createViewer` helpers to `src/server/test-helpers.ts`**

Every route test so far has rebuilt these inline. Extracting them here keeps this task's tests readable and gives 1B-ii and 1C the same starting point.

```ts
const TEST_PASSWORD = 'correct-horse-battery'

export async function signUpAdmin(app: FastifyInstance) {
  const res = await app.inject({
    method: 'POST', url: '/api/setup/admin',
    payload: { email: 'admin@example.com', password: TEST_PASSWORD, name: 'Admin' },
  })
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0] ?? ''
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
  return { cookie, id: me.json().id as string }
}

export async function createViewer(
  app: FastifyInstance,
  adminCookie: string,
  scope: { scopeAllApps: boolean; appIds?: string[] } = { scopeAllApps: true },
) {
  const email = `viewer-${Math.random().toString(36).slice(2)}@example.com`
  const created = await app.inject({
    method: 'POST', url: '/api/users', headers: { cookie: adminCookie },
    payload: {
      email, password: TEST_PASSWORD, name: 'Viewer', role: 'viewer',
      scopeAllApps: scope.scopeAllApps, appIds: scope.appIds ?? [],
    },
  })
  const signIn = await app.inject({
    method: 'POST', url: '/api/auth/sign-in/email',
    payload: { email, password: TEST_PASSWORD },
  })
  return {
    id: created.json().id as string,
    cookie: String(signIn.headers['set-cookie'] ?? '').split(';')[0] ?? '',
  }
}
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/routes/apps.test.ts`
Expected: FAIL — the routes are not registered.

- [ ] **Step 4: Write `src/server/routes/apps.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ulid } from 'ulid'
import { z } from 'zod'
import { scanForApps } from '../apps/adoption.js'
import { toAdminApp, toViewerApp } from '../apps/serialize.js'
import { rollUpStatus } from '../apps/status.js'
import { audit } from '../audit.js'
import { can, requireCapability, visibleAppsWhere } from '../auth/context.js'
import { apps } from '../db/schema.js'
import { LOCAL_HOST_ID } from '../bootstrap.js'

const adoptBody = z.object({ directories: z.array(z.string().min(1)).min(1) })

const patchBody = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  iconRef: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  launchInternalUrl: z.string().nullable().optional(),
  showOnLauncher: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

/** Compose normalises a project name: lowercase, non-alphanumerics stripped. */
function normaliseSlug(directory: string): string {
  return directory.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'app'
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  const { db, host, composeConfig } = app.deps

  /** Current status for one app. Both reads need it, so it lives here once. */
  async function statusFor(row: typeof apps.$inferSelect) {
    const target = { directory: row.directory, composeFile: row.composeFile }
    const resolved = await composeConfig.resolve(target)
    if (!resolved.valid) return { status: 'unknown' as const, detail: resolved.message }
    const containers = await host.listContainers({ project: row.projectName })
    return rollUpStatus(resolved.resolved.services, containers)
  }

  app.get('/api/apps/scan', async (request) => {
    requireCapability(request, 'app:config')
    return scanForApps({ db, host, hostId: LOCAL_HOST_ID })
  })

  app.post('/api/apps/adopt', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const body = adoptBody.parse(request.body)

    const adopted: unknown[] = []
    const failed: Array<{ directory: string; message: string }> = []
    let anyConflict = false

    for (const directory of body.directories) {
      const existing = await db
        .select()
        .from(apps)
        .where(and(eq(apps.hostId, LOCAL_HOST_ID), eq(apps.directory, directory)))
      if (existing.length > 0) {
        anyConflict = true
        failed.push({ directory, message: 'already adopted' })
        continue
      }

      const discovered = (await host.listAppDirectories()).find((d) => d.directory === directory)
      if (!discovered) {
        failed.push({ directory, message: 'no compose file found' })
        continue
      }

      const target = { directory, composeFile: discovered.composeFile }
      const resolved = await composeConfig.resolve(target)
      if (!resolved.valid) {
        failed.push({ directory, message: resolved.message })
        continue
      }

      const { hash } = await host.readTextFile(`${directory}/${discovered.composeFile}`)
      const id = ulid()
      await db.insert(apps).values({
        id,
        hostId: LOCAL_HOST_ID,
        slug: normaliseSlug(directory),
        displayName: directory,
        directory,
        composeFile: discovered.composeFile,
        // From `docker compose config`, which already honours COMPOSE_PROJECT_NAME in
        // the sibling .env. Deriving it from the directory name would be wrong.
        projectName: resolved.resolved.projectName,
        lastComposeHash: hash,
      })

      const [row] = await db.select().from(apps).where(eq(apps.id, id))
      if (row) adopted.push(toAdminApp(row, await statusFor(row)))
      await audit(db, ctx, { action: 'app.adopted', targetType: 'app', targetId: id, ip: request.ip })
    }

    if (adopted.length === 0) {
      return reply.code(anyConflict ? 409 : 422).send({ adopted, failed })
    }
    return reply.code(201).send({ adopted, failed })
  })

  app.get('/api/apps', async (request) => {
    const ctx = requireCapability(request, 'app:read')
    const rows = await db.select().from(apps).where(visibleAppsWhere(ctx))
    const detailed = can(ctx, 'app:config')
    return Promise.all(
      rows.map(async (row) =>
        detailed ? toAdminApp(row, await statusFor(row)) : toViewerApp(row, await statusFor(row)),
      ),
    )
  })

  app.get('/api/apps/:id', async (request, reply) => {
    const ctx = requireCapability(request, 'app:read')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const [row] = await db
      .select()
      .from(apps)
      .where(and(eq(apps.id, id), visibleAppsWhere(ctx)))
    if (!row) return reply.code(404).send({ error: 'not_found' })
    const status = await statusFor(row)
    return can(ctx, 'app:config') ? toAdminApp(row, status) : toViewerApp(row, status)
  })

  app.patch('/api/apps/:id', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = patchBody.parse(request.body)

    const updated = await db.update(apps).set(body).where(eq(apps.id, id)).returning({ id: apps.id })
    if (updated.length === 0) return reply.code(404).send({ error: 'not_found' })

    await audit(db, ctx, { action: 'app.updated', targetType: 'app', targetId: id, detail: body, ip: request.ip })
    const [row] = await db.select().from(apps).where(eq(apps.id, id))
    if (!row) return reply.code(404).send({ error: 'not_found' })
    return toAdminApp(row, await statusFor(row))
  })

  app.delete('/api/apps/:id', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)

    const [row] = await db.select().from(apps).where(eq(apps.id, id))
    if (!row) return reply.code(404).send({ error: 'not_found' })
    // `isSystem` marks the managed cloudflared stack, which Phase 2 owns.
    if (row.isSystem) return reply.code(409).send({ error: 'system_app' })

    // Forgetting an app never touches its files or containers.
    await db.delete(apps).where(eq(apps.id, id))
    await audit(db, ctx, { action: 'app.forgotten', targetType: 'app', targetId: id, ip: request.ip })
    return reply.code(204).send()
  })
}
```

- [ ] **Step 5: Wire it into `src/server/app.ts`**

Add `composeConfig: ComposeConfigCache` to `AppDeps`, register the routes after `userRoutes` and **before** `spaRoutes` (the SPA fallback must stay last), and construct the cache in `index.ts` and `test-helpers.ts`:

```ts
import { ComposeConfigCache } from './apps/compose-config.js'
// ...
composeConfig: new ComposeConfigCache(host),
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run src/server/routes/apps.test.ts && pnpm test`
Expected: the focused file passes 8 tests; the full suite stays green.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/apps.ts src/server/routes/apps.test.ts src/server/app.ts src/server/index.ts src/server/test-helpers.ts
git commit -m "feat: add adoption and app inventory API"
```

---

### Task 9: Compose file read and write API

**Files:**
- Modify: `src/server/routes/apps.ts`
- Test: `src/server/routes/apps-compose.test.ts`

**Interfaces:**
- Produces: `GET /api/apps/:id/compose`, `PUT /api/apps/:id/compose`, `POST /api/apps/:id/compose/validate`

Both mutating routes require `app:config`. The write carries the hash the client loaded; a mismatch is 409, which is what stops the editor clobbering an edit made over SSH. **A write that would produce an invalid compose file is rejected before it touches the disk** — an invalid file makes the app unmanageable, and the user's editor is the right place to find out.

- [ ] **Step 1: Write the failing test**

`src/server/routes/apps-compose.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp, signUpAdmin, createViewer } from '@server/test-helpers'

const VALID = JSON.stringify({ name: 'jellyfin', services: { web: { image: 'nginx' } } })

async function withAdoptedApp() {
  const app = await buildTestApp()
  const { cookie } = await signUpAdmin(app)
  app.deps.host.files.set('jellyfin/compose.yaml', 'services:\n  web:\n    image: nginx\n')
  app.deps.host.composeResults.set('config --format json', { exitCode: 0, stdout: VALID, stderr: '' })
  const res = await app.inject({
    method: 'POST', url: '/api/apps/adopt', headers: { cookie },
    payload: { directories: ['jellyfin'] },
  })
  return { app, cookie, id: res.json().adopted[0].id as string }
}

describe('compose file API', () => {
  it('returns the file with its hash', async () => {
    const { app, cookie, id } = await withAdoptedApp()
    const res = await app.inject({ method: 'GET', url: `/api/apps/${id}/compose`, headers: { cookie } })
    expect(res.json().content).toContain('image: nginx')
    expect(res.json().hash).toMatch(/^[0-9a-f]{64}$/)
    await app.close()
  })

  it('refuses to show the file to a viewer', async () => {
    const { app, cookie, id } = await withAdoptedApp()
    const viewer = await createViewer(app, cookie)
    const res = await app.inject({ method: 'GET', url: `/api/apps/${id}/compose`, headers: { cookie: viewer.cookie } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('writes when the hash matches and updates the recorded hash', async () => {
    const { app, cookie, id } = await withAdoptedApp()
    const before = (await app.inject({ method: 'GET', url: `/api/apps/${id}/compose`, headers: { cookie } })).json()
    const res = await app.inject({
      method: 'PUT', url: `/api/apps/${id}/compose`, headers: { cookie },
      payload: { content: 'services:\n  web:\n    image: nginx:alpine\n', expectedHash: before.hash },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().hash).not.toBe(before.hash)
    await app.close()
  })

  it('rejects a write whose hash is stale', async () => {
    const { app, cookie, id } = await withAdoptedApp()
    const res = await app.inject({
      method: 'PUT', url: `/api/apps/${id}/compose`, headers: { cookie },
      payload: { content: 'services: {}\n', expectedHash: 'f'.repeat(64) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('stale_hash')
    await app.close()
  })

  it('rejects a write that would produce an invalid compose file, without saving it', async () => {
    const { app, cookie, id } = await withAdoptedApp()
    const before = (await app.inject({ method: 'GET', url: `/api/apps/${id}/compose`, headers: { cookie } })).json()
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 1, stdout: '', stderr: 'service "web" depends on undefined service "ghost"',
    })
    const res = await app.inject({
      method: 'PUT', url: `/api/apps/${id}/compose`, headers: { cookie },
      payload: { content: 'services:\n  web:\n    depends_on: [ghost]\n', expectedHash: before.hash },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toContain('ghost')
    // The original file must be untouched.
    expect(app.deps.host.files.get('jellyfin/compose.yaml')).toContain('image: nginx')
    await app.close()
  })

  it('validates without saving', async () => {
    const { app, cookie, id } = await withAdoptedApp()
    const res = await app.inject({
      method: 'POST', url: `/api/apps/${id}/compose/validate`, headers: { cookie },
      payload: { content: 'services:\n  web:\n    image: nginx\n' },
    })
    expect(res.json().valid).toBe(true)
    await app.close()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/routes/apps-compose.test.ts`
Expected: FAIL — routes not found (404).

- [ ] **Step 3: Add the routes to `src/server/routes/apps.ts`**

```ts
import { HashMismatchError } from '../host/types.js'

const composeWriteBody = z.object({
  content: z.string(),
  expectedHash: z.string().nullable(),
})

  app.get('/api/apps/:id/compose', async (request, reply) => {
    requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const [row] = await db.select().from(apps).where(eq(apps.id, id))
    if (!row) return reply.code(404).send({ error: 'not_found' })
    return host.readTextFile(`${row.directory}/${row.composeFile}`)
  })

  app.put('/api/apps/:id/compose', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = composeWriteBody.parse(request.body)

    const [row] = await db.select().from(apps).where(eq(apps.id, id))
    if (!row) return reply.code(404).send({ error: 'not_found' })

    const relative = `${row.directory}/${row.composeFile}`
    const target = { directory: row.directory, composeFile: row.composeFile }

    // Validate BEFORE writing. An invalid compose file makes the app unmanageable, and
    // the editor is where the user should learn about it — not the next deploy.
    // Written to a sibling scratch file so the real one is never briefly invalid.
    const scratch = `${row.directory}/.homestead-validate.yaml`
    await host.writeTextFile(scratch, body.content, null)
    try {
      const check = await composeConfig.resolve({ ...target, composeFile: '.homestead-validate.yaml' })
      if (!check.valid) return reply.code(422).send({ error: 'invalid_compose', message: check.message })
    } finally {
      await host.deleteFile(scratch)
    }

    try {
      const { hash } = await host.writeTextFile(relative, body.content, body.expectedHash)
      composeConfig.invalidate(target)
      await db.update(apps).set({ lastComposeHash: hash }).where(eq(apps.id, id))
      await audit(db, ctx, { action: 'app.compose_written', targetType: 'app', targetId: id, ip: request.ip })
      return { hash }
    } catch (error) {
      if (error instanceof HashMismatchError) {
        return reply.code(409).send({ error: 'stale_hash', message: 'The file changed on disk since it was loaded.' })
      }
      throw error
    }
  })

  app.post('/api/apps/:id/compose/validate', async (request, reply) => {
    requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z.object({ content: z.string() }).parse(request.body)

    const [row] = await db.select().from(apps).where(eq(apps.id, id))
    if (!row) return reply.code(404).send({ error: 'not_found' })

    const scratch = `${row.directory}/.homestead-validate.yaml`
    await host.writeTextFile(scratch, body.content, null)
    try {
      const check = await composeConfig.resolve({
        directory: row.directory, composeFile: '.homestead-validate.yaml',
      })
      return check.valid ? { valid: true } : { valid: false, message: check.message }
    } finally {
      await host.deleteFile(scratch)
    }
  })
```

- [ ] **Step 4: Add `deleteFile` to the `Host` interface, `LocalHost`, and `FakeHost`**

Validation needs a scratch file, and leaving them behind would litter an SMB share the user browses.

In `types.ts`, add to `interface Host`:

```ts
  deleteFile(rel: string): Promise<void>
```

In `local-host.ts`:

```ts
  async deleteFile(rel: string): Promise<void> {
    // resolveForWrite, not resolveExisting: the same target-symlink check applies, and
    // deleting a path that has already gone is not an error.
    const abs = await this.guard.resolveForWrite(rel)
    await rm(abs, { force: true })
  }
```

with `rm` added to the `node:fs/promises` import. In `FakeHost`:

```ts
  async deleteFile(rel: string): Promise<void> {
    this.files.delete(rel)
  }
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run src/server/routes/apps-compose.test.ts && pnpm test`
Expected: the focused file passes 6 tests; the full suite stays green.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/apps.ts src/server/routes/apps-compose.test.ts src/server/host/types.ts src/server/host/local-host.ts src/server/test-helpers.ts
git commit -m "feat: add compose file read, validate, and hash-guarded write"
```

---

### Task 10: `.env` read and write API

**Files:**
- Modify: `src/server/routes/apps.ts`
- Test: `src/server/routes/apps-env.test.ts`

**Interfaces:**
- Produces: `GET /api/apps/:id/env` (masked), `POST /api/apps/:id/env/reveal` (audited), `PUT /api/apps/:id/env`

`GET` requires `app:config` and returns **keys with masked values only**. Revealing requires `app:secrets`, is a separate `POST` so it cannot happen by accident, and writes an audit entry naming the app. Viewers receive 403 from all three — not a masked response, since the file's very existence is operational detail.

- [ ] **Step 1: Write the failing test**

`src/server/routes/apps-env.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { buildTestApp, signUpAdmin, createViewer } from '@server/test-helpers'
import { auditLog } from '@server/db/schema'

const VALID = JSON.stringify({ name: 'jellyfin', services: { web: { image: 'nginx' } } })
const ENV = '# Database\nDB_PASSWORD=hunter2\nPUID=1000\n'

async function withEnv() {
  const app = await buildTestApp()
  const { cookie } = await signUpAdmin(app)
  app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  app.deps.host.files.set('jellyfin/.env', ENV)
  app.deps.host.composeResults.set('config --format json', { exitCode: 0, stdout: VALID, stderr: '' })
  const res = await app.inject({
    method: 'POST', url: '/api/apps/adopt', headers: { cookie },
    payload: { directories: ['jellyfin'] },
  })
  return { app, cookie, id: res.json().adopted[0].id as string }
}

describe('.env API', () => {
  it('returns keys with masked values and never the secret', async () => {
    const { app, cookie, id } = await withEnv()
    const res = await app.inject({ method: 'GET', url: `/api/apps/${id}/env`, headers: { cookie } })
    expect(res.body).not.toContain('hunter2')
    expect(res.json().entries).toEqual([
      { key: 'DB_PASSWORD', masked: '••••••••' },
      { key: 'PUID', masked: '••••••••' },
    ])
    await app.close()
  })

  it('refuses a viewer entirely, rather than returning a masked file', async () => {
    const { app, cookie, id } = await withEnv()
    const viewer = await createViewer(app, cookie)
    for (const url of [`/api/apps/${id}/env`]) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie: viewer.cookie } })).statusCode).toBe(403)
    }
    expect((await app.inject({
      method: 'POST', url: `/api/apps/${id}/env/reveal`, headers: { cookie: viewer.cookie },
    })).statusCode).toBe(403)
    await app.close()
  })

  it('reveals values only through the explicit endpoint, and audits it', async () => {
    const { app, cookie, id } = await withEnv()
    const res = await app.inject({ method: 'POST', url: `/api/apps/${id}/env/reveal`, headers: { cookie } })
    expect(res.json().content).toContain('hunter2')

    const entries = await app.deps.db.select().from(auditLog)
      .where(eq(auditLog.action, 'app.env_revealed'))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.targetId).toBe(id)
    await app.close()
  })

  it('preserves comments and ordering on write', async () => {
    const { app, cookie, id } = await withEnv()
    const revealed = (await app.inject({
      method: 'POST', url: `/api/apps/${id}/env/reveal`, headers: { cookie },
    })).json()

    const res = await app.inject({
      method: 'PUT', url: `/api/apps/${id}/env`, headers: { cookie },
      payload: { content: ENV.replace('PUID=1000', 'PUID=1001'), expectedHash: revealed.hash },
    })
    expect(res.statusCode).toBe(200)
    const saved = app.deps.host.files.get('jellyfin/.env') ?? ''
    expect(saved).toContain('# Database')
    expect(saved).toContain('PUID=1001')
    expect(saved.indexOf('DB_PASSWORD')).toBeLessThan(saved.indexOf('PUID'))
    await app.close()
  })

  it('reports an absent .env as empty rather than 404', async () => {
    const { app, cookie, id } = await withEnv()
    app.deps.host.files.delete('jellyfin/.env')
    const res = await app.inject({ method: 'GET', url: `/api/apps/${id}/env`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ entries: [], exists: false })
    await app.close()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/routes/apps-env.test.ts`
Expected: FAIL — routes not found.

- [ ] **Step 3: Add the routes to `src/server/routes/apps.ts`**

```ts
import { maskEnv, parseEnv } from '../apps/env-file.js'

/** Reads `.env`, treating absence as empty. Most stacks have one; some do not. */
async function readEnv(directory: string) {
  try {
    return { ...(await host.readTextFile(`${directory}/.env`)), exists: true }
  } catch {
    return { content: '', hash: null, exists: false }
  }
}

  app.get('/api/apps/:id/env', async (request, reply) => {
    requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const [row] = await db.select().from(apps).where(eq(apps.id, id))
    if (!row) return reply.code(404).send({ error: 'not_found' })

    const file = await readEnv(row.directory)
    // Masked, always. The reveal endpoint is the only way to see values.
    return { entries: maskEnv(parseEnv(file.content)), exists: file.exists }
  })

  app.post('/api/apps/:id/env/reveal', async (request, reply) => {
    const ctx = requireCapability(request, 'app:secrets')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const [row] = await db.select().from(apps).where(eq(apps.id, id))
    if (!row) return reply.code(404).send({ error: 'not_found' })

    const file = await readEnv(row.directory)
    // A separate endpoint rather than a query flag, so revealing is always deliberate
    // and always leaves a trace.
    await audit(db, ctx, { action: 'app.env_revealed', targetType: 'app', targetId: id, ip: request.ip })
    return { content: file.content, hash: file.hash, exists: file.exists }
  })

  app.put('/api/apps/:id/env', async (request, reply) => {
    const ctx = requireCapability(request, 'app:secrets')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = composeWriteBody.parse(request.body)

    const [row] = await db.select().from(apps).where(eq(apps.id, id))
    if (!row) return reply.code(404).send({ error: 'not_found' })

    try {
      const { hash } = await host.writeTextFile(`${row.directory}/.env`, body.content, body.expectedHash)
      // `.env` feeds ${VAR} interpolation and COMPOSE_PROJECT_NAME, so the resolved
      // config is now stale even though compose.yaml has not changed.
      composeConfig.invalidate({ directory: row.directory, composeFile: row.composeFile })
      await audit(db, ctx, { action: 'app.env_written', targetType: 'app', targetId: id, ip: request.ip })
      return { hash }
    } catch (error) {
      if (error instanceof HashMismatchError) {
        return reply.code(409).send({ error: 'stale_hash', message: 'The file changed on disk since it was loaded.' })
      }
      throw error
    }
  })
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run src/server/routes/apps-env.test.ts && pnpm test`
Expected: the focused file passes 5 tests; the full suite stays green.

- [ ] **Step 5: Manual verification against the real machine**

The whole phase exists to work on real stacks, and every test so far uses `FakeHost`.

```bash
mkdir -p /tmp/hs-real/jellyfin
printf 'services:\n  web:\n    image: nginx:alpine\n    ports: ["8099:80"]\n' > /tmp/hs-real/jellyfin/compose.yaml
printf 'COMPOSE_PROJECT_NAME=hs-real-jellyfin\n' > /tmp/hs-real/jellyfin/.env
docker compose -f /tmp/hs-real/jellyfin/compose.yaml up -d

HOMESTEAD_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
HOMESTEAD_BASE_URL=http://localhost:3000 \
HOMESTEAD_DB_PATH=./data/manual.db \
HOMESTEAD_COMPOSE_ROOT=/tmp/hs-real \
HOMESTEAD_SKIP_MOUNT_PREFLIGHT=true \
pnpm dev:server
```

Create an admin through the UI, then `GET /api/apps/scan` and confirm `jellyfin` appears with `containerCount: 1` and `running: true`. Adopt it, then `GET /api/apps` and confirm `projectName` is **`hs-real-jellyfin`** — from `.env`, not the directory name. Record what you actually saw.

Tear down: `docker compose -f /tmp/hs-real/jellyfin/compose.yaml down && rm -rf /tmp/hs-real data/manual.db`

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/apps.ts src/server/routes/apps-env.test.ts
git commit -m "feat: add masked .env read, audited reveal, and guarded write"
```

---

## Self-Review

**Spec coverage for 1B-i's slice:**

| Spec requirement | Task |
|---|---|
| Viewer DTO as a distinct type, not a filter | 1 |
| `hosts` row exists for `apps.hostId` | 2 |
| Compose mutations shell out to the CLI with an argument array | 3 |
| `docker compose config` resolves the expected service set, cached by file hash | 4 |
| `.env` round-trips losslessly; values masked by default | 5 |
| Adoption joins directories to compose-labelled containers; orphans surfaced | 6 |
| `projectName` stored, resolved from compose rather than guessed | 6, 8 |
| Status rollup with exited-zero one-shots treated as completed | 7 |
| SHA-256 hash guard against on-disk drift | 9 |
| Viewers never receive compose or `.env` | 1, 8, 9, 10 |
| Secret reveal is a separate, audited endpoint | 10 |

**Deferred to 1B-ii, deliberately:** lifecycle jobs (`up`/`down`/`restart`/`pull`) with SSE-streamed output and the per-app mutex, log streaming with TTY demultiplexing, the read-only container detail panel, and registry-digest image update detection. The `onOutput` hook in Task 3's `runCompose` signature exists so that lands additively.

**Deferred to 1C:** probes, the scheduler, `check_results` / `check_rollups` writes.

**Carry-forward items still open after this plan:** the `trustedProxies` question needs verification on the real NAS; the nine deferred minors from Phase 1A remain in the carry-forward document.

**Known adaptation point:** Task 8's tests reach into `app.deps.host` as a `FakeHost`. If `AppDeps.host` is typed as `Host`, the tests need a narrowing helper rather than a cast — add one to `test-helpers.ts` rather than using `as`, since `noNonNullAssertion` and `noExplicitAny` are both enforced.
