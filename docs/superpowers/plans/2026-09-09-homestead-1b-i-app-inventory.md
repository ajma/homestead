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
- **TypeScript:** ESM only, `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: "bundler"`, `target: "ES2022"`, `lib` includes `ES2023`. No CommonJS, no `require`. Local imports use `.js` extensions. `lib` and `target` differ deliberately: `target` governs which syntax is downlevelled, `lib` declares which runtime methods exist, and every runtime this ships on has the ES2023 array methods.
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

  it('does not treat an unreadable .env as an absent one', async () => {
    // Cache once with no .env at all, then make a read fail for a different reason.
    // A shared 'absent' marker would collide here and serve the stale valid result,
    // even though the CLI — which reads .env itself — would now fail.
    const host = hostWith(configJson)
    const cache = new ComposeConfigCache(host)
    await cache.resolve(target)
    host.readTextFileErrors.set('jellyfin/.env', new Error('EACCES: permission denied'))
    await cache.resolve(target)
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
   *
   * An unreadable `.env` must NOT hash the same as an absent one. A single `'absent'`
   * for every failure breaks the invariant the hash exists to hold — that distinct
   * input states produce distinct hashes — and the transition is reachable: resolve
   * once with no `.env` (cached as absent), then have one appear that Homestead cannot
   * read. The hashes match, the cache hits, and a stale `valid: true` is served for a
   * stack whose real resolve would now fail. The error's own text is the marker.
   *
   * The marker is coarser than it looks, because `PathGuard.resolveExisting` throws the
   * same `PathEscapeError` for a missing file and for one that resolves outside the
   * compose root. So a `.env` symlinked out of the root still reads as absent here,
   * while the compose CLI — which has no such guard — happily interpolates from it.
   * Narrowing that needs an explicit existence check on `Host`; it is not this task.
   */
  private async inputHash(target: ComposeTarget): Promise<string> {
    const compose = await this.host.readTextFile(
      `${target.directory}/${target.composeFile}`,
    )
    const env = await this.host
      .readTextFile(`${target.directory}/.env`)
      .then((file) => file.hash)
      .catch((error: unknown) => `unreadable:${error instanceof Error ? error.message : String(error)}`)
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
  | { kind: 'pair'; key: string; value: string; comment: string; raw: string }
  | { kind: 'other'; raw: string }        // comments and blank lines
export function parseEnv(content: string): EnvEntry[]
export function serialiseEnv(entries: EnvEntry[]): string
export function maskEnv(entries: EnvEntry[]): Array<{ key: string; masked: string }>
export function upsertEnv(entries: EnvEntry[], key: string, value: string): EnvEntry[]
```

Round-tripping must be lossless. These files are hand-maintained over SSH and full of comments explaining why a variable is set; an editor that silently drops them is worse than no editor. `.env` also holds database passwords and API keys, so values are masked in every response by default.

**Losslessness has to survive an edit, not just a read.** Reassembling from `raw` makes an untouched round trip free, but `upsertEnv` necessarily rebuilds the line it changes — and `PUID=1000   # the media user` is exactly the line a user edits. Rebuilding it as `PUID=1001` silently destroys the comment, which is the failure this task exists to prevent. So a pair carries its inline `comment` separately and `upsertEnv` reattaches it.

**`value` means what compose means by it.** Compose strips an inline `#` comment when whitespace precedes the `#`, and strips one layer of matching surrounding quotes. `PUID=1000   # the media user` therefore has the value `1000`, not `1000   # the media user`, and `QUOTED="has spaces"` has the value `has spaces`. Getting this wrong is invisible while `maskEnv` only asks whether a value is empty, and becomes a wrong answer the moment anything displays or compares one. A `#` with no preceding whitespace is part of the value (`PASS=hunter#2`), which is why the rule is not simply "split on `#`".

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

describe('values', () => {
  it('reads the value compose would read, not the whole right-hand side', () => {
    const byKey = (content: string, key: string) => {
      const entry = parseEnv(content).find((e) => e.kind === 'pair' && e.key === key)
      return entry?.kind === 'pair' ? entry.value : undefined
    }
    // An inline comment is not part of the value...
    expect(byKey(sample, 'PUID')).toBe('1000')
    // ...but a '#' with no whitespace before it is.
    expect(byKey('PASS=hunter#2', 'PASS')).toBe('hunter#2')
    // ...and one inside quotes is literal.
    expect(byKey('PASS="a # b"', 'PASS')).toBe('a # b')
    // One layer of matching quotes is removed.
    expect(byKey(sample, 'QUOTED')).toBe('has spaces')
    expect(byKey("S='single'", 'S')).toBe('single')
    // Mismatched quotes are not a pair of quotes.
    expect(byKey('M="oops\'', 'M')).toBe('"oops\'')
  })

  it('captures the inline comment with its leading whitespace', () => {
    const puid = parseEnv(sample).find((e) => e.kind === 'pair' && e.key === 'PUID')
    expect(puid?.kind === 'pair' && puid.comment).toBe('   # the media user')
  })

  it('expands escapes in double quotes and leaves single quotes literal', () => {
    const value = (content: string) => {
      const entry = parseEnv(content).find((e) => e.kind === 'pair')
      return entry?.kind === 'pair' ? entry.value : undefined
    }
    // These are passwords. Stripping the backslash from a single-quoted one is a
    // silent corruption that surfaces as an app failing to authenticate.
    expect(value("PASS='hunter\\2'")).toBe('hunter\\2')
    expect(value('DESC="line1\\nline2"')).toBe('line1\nline2')
    expect(value('P="C:\\dir"')).toBe('C:\\dir')  // unknown escape stays verbatim
  })

  it('finds the comment after an escaped quote', () => {
    const entry = parseEnv('A="has \\" quote" # note').find((e) => e.kind === 'pair')
    expect(entry?.kind === 'pair' && entry.value).toBe('has " quote')
    expect(entry?.kind === 'pair' && entry.comment).toBe(' # note')
  })

  it('reads a file saved with CRLF line endings', () => {
    // Measured against the first implementation: every line matched `other`, so a
    // CRLF `.env` appeared to contain no variables at all.
    const entries = parseEnv('A=1\r\nB=2\r\n')
    const pairs = entries.filter((e) => e.kind === 'pair')
    expect(pairs.map((p) => p.kind === 'pair' && [p.key, p.value])).toEqual([
      ['A', '1'],
      ['B', '2'],
    ])
    expect(serialiseEnv(entries)).toBe('A=1\r\nB=2\r\n')
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

  it('keeps the inline comment when the value it annotates changes', () => {
    // The whole point of the module: editing one variable must not silently delete
    // the note explaining why it is set. Without this, `PUID=1001` is all that is left.
    const text = serialiseEnv(upsertEnv(parseEnv(sample), 'PUID', '1001'))
    expect(text).toContain('PUID=1001   # the media user')
  })

  it('quotes a written value only when it would not survive unquoted', () => {
    expect(serialiseEnv(upsertEnv(parseEnv('A=1'), 'A', 'plain'))).toBe('A=plain')
    expect(serialiseEnv(upsertEnv(parseEnv('A=1'), 'A', 'has spaces'))).toBe('A="has spaces"')
    expect(serialiseEnv(upsertEnv(parseEnv('A=1'), 'A', 'a#b'))).toBe('A="a#b"')
    // A quote in the value is escaped, so re-parsing yields what was written.
    const written = serialiseEnv(upsertEnv(parseEnv('A=1'), 'A', 'say "hi"'))
    const back = parseEnv(written).find((e) => e.kind === 'pair')
    expect(back?.kind === 'pair' && back.value).toBe('say "hi"')
  })

  it('rewrites the last occurrence of a duplicated key, which is the one compose reads', () => {
    // Rewriting the first was measured to be a silent no-op: the UI reports success
    // and the container still starts with the old value.
    expect(serialiseEnv(upsertEnv(parseEnv('A=1\nA=2'), 'A', '9'))).toBe('A=1\nA=9')
  })

  it('keeps a CRLF line CRLF when it rewrites it', () => {
    expect(serialiseEnv(upsertEnv(parseEnv('A=1\r\nB=2\r\n'), 'A', '9'))).toBe('A=9\r\nB=2\r\n')
  })

  it('appends to a CRLF file with CRLF, leaving no mixed endings', () => {
    // Measured: a bare LF here turned a clean CRLF file mixed on the first key added.
    expect(serialiseEnv(upsertEnv(parseEnv('A=1\r\nB=2\r\n'), 'C', '3'))).toBe(
      'A=1\r\nB=2\r\nC=3\r\n',
    )
    expect(serialiseEnv(upsertEnv(parseEnv('A=1\nB=2\n'), 'C', '3'))).toBe('A=1\nB=2\nC=3\n')
  })

  it('leaves an unterminated quote alone rather than guessing', () => {
    // `A="test\"` never closes its quote — the `\"` is escaped. There is no correct
    // value to recover, so the best-effort result is documented rather than "fixed".
    // The well-formed `A="test\""` is the case that must give `test"`.
    const value = (content: string) => {
      const entry = parseEnv(content).find((e) => e.kind === 'pair')
      return entry?.kind === 'pair' ? entry.value : undefined
    }
    expect(value('A="test\\""')).toBe('test"')
    expect(value('A="test\\"')).toBe('test\\')
  })

  it('never lets a written value restructure the file', () => {
    // An API caller can supply anything. A literal newline written raw would split the
    // line and silently invent a variable.
    const text = serialiseEnv(upsertEnv(parseEnv('A=1'), 'A', 'one\ntwo'))
    expect(text.split('\n')).toHaveLength(1)
    const back = parseEnv(text).find((e) => e.kind === 'pair')
    expect(back?.kind === 'pair' && back.value).toBe('one\ntwo')
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
  | { kind: 'pair'; key: string; value: string; comment: string; raw: string }
  | { kind: 'other'; raw: string }

/** Fixed width, so the mask reveals nothing about the secret's length. */
const MASK = '••••••••'

// `\r?$` tolerates a file last edited on Windows. Without it the whole right-hand
// side keeps a trailing CR, the value is wrong, and — worse — every line reads as
// `other`, so a CRLF `.env` appears to contain no variables at all.
const PAIR = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*?)\r?$/

/**
 * Escape sequences compose expands inside double quotes. An unrecognised sequence is
 * left verbatim, so a Windows path like `"C:\dir"` keeps its backslash.
 */
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' }

function unescapeDouble(value: string): string {
  return value.replace(/\\(.)/g, (whole, ch: string) => ESCAPES[ch] ?? whole)
}

/**
 * Splits a `.env` right-hand side into its value and its trailing comment.
 *
 * Follows compose's rules rather than inventing simpler ones:
 *  - a `#` starts a comment only when whitespace precedes it, so `PASS=hunter#2`
 *    keeps the `#` in the value
 *  - a `#` inside quotes is literal
 *  - one layer of matching surrounding quotes is removed from the value
 *
 * The comment is returned with its leading whitespace intact so `upsertEnv` can
 * reattach it exactly as the user wrote it.
 */
function splitValue(rest: string): { value: string; comment: string } {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (quote) {
      // A backslash escapes the next character inside double quotes only. Without
      // this, `A="has \" quote" # note` closes the quote at the escaped `"`, reopens
      // at the closing one, and never finds the comment — the whole line lands in the
      // value. Single quotes are literal, so a backslash there escapes nothing.
      if (quote === '"' && ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    // Whitespace before the '#' is what makes it a comment rather than a literal.
    if (ch === '#' && (i === 0 || /\s/.test(rest[i - 1] ?? ''))) {
      // The comment starts at the whitespace, not at the '#'. Slicing from the '#'
      // would make `upsertEnv` rebuild the line as `PUID=1001# the media user`, which
      // compose does not read as a comment at all — the value would become the whole
      // rest of the line on the next parse.
      let start = i
      while (start > 0 && /\s/.test(rest[start - 1] ?? '')) start--
      return { value: unquote(rest.slice(0, start).trim()), comment: rest.slice(start) }
    }
  }
  return { value: unquote(rest.trim()), comment: '' }
}

/**
 * Removes one layer of matching surrounding quotes.
 *
 * Compose is asymmetric here and so is this: a double-quoted value has its escape
 * sequences expanded, a single-quoted value is literal. Unescaping both would corrupt
 * `PASS='hunter\2'` into `hunter2` — and these are passwords, so the corruption is
 * silent until an app fails to authenticate.
 */
function unquote(value: string): string {
  const first = value[0]
  if (value.length >= 2 && value.endsWith(first ?? '')) {
    if (first === '"') return unescapeDouble(value.slice(1, -1))
    if (first === "'") return value.slice(1, -1)
  }
  return value
}

/**
 * Re-quotes on the way out only when the value would not survive unquoted.
 *
 * The escaping here and `unescapeDouble` are a matched pair: whatever this writes must
 * read back identically. Newlines and tabs become sequences rather than literals
 * because a literal one would split the line and silently restructure the file.
 */
function quoteIfNeeded(value: string): string {
  if (!/[\s#'"\\]/.test(value)) return value
  const escaped = value
    .replace(/([\\"])/g, '\\$1')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

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
    const { value, comment } = splitValue(rest ?? '')
    return { kind: 'pair', key, value, comment, raw: line }
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

/**
 * Replaces a key's value in place, or appends it before any trailing blank line.
 *
 * The existing entry's inline comment is carried onto the rebuilt line. Dropping it
 * would make editing one variable destroy the note explaining why it is set — the
 * precise loss this module exists to prevent, and one the user would only notice
 * later, over SSH.
 *
 * When a key appears more than once, the LAST occurrence is the one rewritten, because
 * that is the one compose reads. Rewriting the first was measured to produce a silent
 * no-op: `A=1\nA=2` edited to `9` became `A=9\nA=2`, the UI showed success, and the
 * container still started with `2`.
 */
export function upsertEnv(entries: EnvEntry[], key: string, value: string): EnvEntry[] {
  const index = entries.findLastIndex((e) => e.kind === 'pair' && e.key === key)
  if (index >= 0) {
    const existing = entries[index]
    const comment = existing?.kind === 'pair' ? existing.comment : ''
    // Preserve the line's own ending so one edit does not convert a CRLF file's line
    // to LF and leave the file mixed.
    const eol = existing?.raw.endsWith('\r') ? '\r' : ''
    const next = [...entries]
    next[index] = {
      kind: 'pair',
      key,
      value,
      comment,
      raw: `${key}=${quoteIfNeeded(value)}${comment}${eol}`,
    }
    return next
  }

  const trailingBlank = entries.length > 0 && entries[entries.length - 1]?.raw === ''
  // An appended line inherits the file's prevailing ending. Giving it a bare LF was
  // measured to turn a clean CRLF file mixed on the first key added.
  const eol = entries.some((e) => e.raw.endsWith('\r')) ? '\r' : ''
  const newEntry: EnvEntry = {
    kind: 'pair',
    key,
    value,
    comment: '',
    raw: `${key}=${quoteIfNeeded(value)}${eol}`,
  }
  return trailingBlank
    ? [...entries.slice(0, -1), newEntry, { kind: 'other', raw: '' }]
    : [...entries, newEntry]
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/apps/env-file.test.ts`
Expected: PASS, 22 tests.

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
- Consumes: `Host.listAppDirectories`, `Host.listContainers`, `Db`, and `parseEnv` from Task 5 (`@server/apps/env-file`)
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

  it('normalises the directory name the way compose does', async () => {
    // `My Media` runs as project `mymedia`. Comparing the raw name matches nothing, and
    // the failure is doubled: the stack reads as stopped AND its containers show up as
    // an orphan, so one real directory produces two wrong rows.
    const db = await seed()
    const host = hostWith([['My Media', 'compose.yaml']], [container('mymedia', 'web')])
    const result = await scanForApps({ db, host, hostId: 'local' })
    expect(result.discovered[0]).toMatchObject({
      directory: 'My Media',
      projectName: 'mymedia',
      containerCount: 1,
      running: true,
    })
    expect(result.orphans).toEqual([])
  })

  it('honours COMPOSE_PROJECT_NAME from the sibling .env', async () => {
    const db = await seed()
    const host = hostWith([['stack', 'compose.yaml']], [container('custom-name', 'web')])
    host.files.set('stack/.env', '# set by the tutorial\nCOMPOSE_PROJECT_NAME=custom-name\n')
    const result = await scanForApps({ db, host, hostId: 'local' })
    expect(result.discovered[0]).toMatchObject({
      projectName: 'custom-name',
      containerCount: 1,
      running: true,
    })
    expect(result.orphans).toEqual([])
  })

  it('ignores a .env that sets COMPOSE_PROJECT_NAME to nothing', async () => {
    const db = await seed()
    const host = hostWith([['stack', 'compose.yaml']], [container('stack', 'web')])
    host.files.set('stack/.env', 'COMPOSE_PROJECT_NAME=\n')
    const result = await scanForApps({ db, host, hostId: 'local' })
    expect(result.discovered[0]).toMatchObject({ projectName: 'stack', containerCount: 1 })
  })

  it('leaves a directory whose name normalises to nothing unmatched', async () => {
    // Compose will not derive a project name from `Медиа` either, so anything running
    // was started under a name only the user knows. Reporting the containers as an
    // orphan is the honest answer; inventing a match would be a guess.
    const db = await seed()
    const host = hostWith([['Медиа', 'compose.yaml']], [container('media', 'web')])
    const result = await scanForApps({ db, host, hostId: 'local' })
    expect(result.discovered[0]).toMatchObject({ projectName: null, containerCount: 0 })
    expect(result.orphans).toEqual([{ projectName: 'media', containerCount: 1 }])
  })

  it('lets two directories that normalise alike report the same stack', async () => {
    // Faithful rather than tidy: compose treats `my_media` and `MY_MEDIA` as one
    // project, so `up` in either really does control the same containers.
    const db = await seed()
    const host = hostWith(
      [['my_media', 'compose.yaml'], ['MY_MEDIA', 'compose.yaml']],
      [container('my_media', 'web')],
    )
    const result = await scanForApps({ db, host, hostId: 'local' })
    // `localeCompare` puts lowercase first, so `my_media` leads.
    expect(result.discovered.map((d) => [d.directory, d.projectName, d.containerCount])).toEqual([
      ['my_media', 'my_media', 1],
      ['MY_MEDIA', 'my_media', 1],
    ])
    expect(result.orphans).toEqual([])
  })

  it('strips accents and leading dots the way compose does', async () => {
    const db = await seed()
    const host = hostWith(
      [['Filmé', 'compose.yaml'], ['.hidden', 'compose.yaml']],
      [container('film', 'web'), container('hidden', 'web')],
    )
    const result = await scanForApps({ db, host, hostId: 'local' })
    expect(result.discovered.map((d) => d.projectName).sort()).toEqual(['film', 'hidden'])
    expect(result.orphans).toEqual([])
  })

  it('prefers an adopted app\'s recorded name over what .env now says', async () => {
    // Adoption resolved the name through the CLI, so it is authoritative even if
    // someone edits .env afterwards without recreating the containers.
    const db = await seed()
    await db.insert(apps).values({
      id: ulid(), hostId: 'local', slug: 'stack', displayName: 'Stack',
      directory: 'stack', composeFile: 'compose.yaml', projectName: 'recorded',
    })
    const host = hostWith([['stack', 'compose.yaml']], [container('recorded', 'web')])
    host.files.set('stack/.env', 'COMPOSE_PROJECT_NAME=changed-since\n')
    const result = await scanForApps({ db, host, hostId: 'local' })
    expect(result.discovered[0]).toMatchObject({ projectName: 'recorded', containerCount: 1 })
    expect(result.orphans).toEqual([])
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
import { parseEnv } from './env-file.js'

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
 * Compose's own project-name normalisation: lowercased, and anything outside
 * `[a-z0-9_-]` dropped, with leading separators trimmed.
 *
 * `My Media` becomes `mymedia`. Comparing the raw directory name against a container
 * label therefore never matches for any directory with a capital or a space, and the
 * consequence is not a missing field — the stack reports `running: false` while its
 * containers appear separately as an orphan. One real directory produces two wrong
 * rows.
 */
function normaliseProjectName(directory: string): string {
  return directory.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '')
}
// Two names this cannot resolve, both left as they are on purpose:
//
// A name with nothing left after stripping — `Медиа`, `...` — normalises to `''`, which
// never matches, so the directory reads as stopped and its containers list as an orphan.
// That is the honest answer rather than a bug: compose refuses to derive a project name
// from such a directory at all, so whatever is running was started with an explicit name
// only the user knows. `byProject` never holds `''` because unlabelled containers are
// skipped, so the empty lookup is inert.
//
// Two directories can normalise to the same name — `my_media` and `MY_MEDIA` — and both
// then report the same containers. Measured, and faithful: compose treats them as one
// project, so `up` in either directory really does control the same stack. Flagging it
// would need a UI affordance that does not exist yet.

/**
 * The project name compose would use for a directory that Homestead has not adopted.
 *
 * `COMPOSE_PROJECT_NAME` in the sibling `.env` overrides the directory name outright,
 * and it is common in stacks copied from a tutorial. Missing it produces the same
 * two-wrong-rows failure as skipping normalisation. Reading one small file per
 * directory is the cheap way to be right; the alternative is a `docker compose config`
 * subprocess per directory, which on a NAS with thirty stacks is thirty processes for
 * a screen the user opens to look around.
 *
 * A missing or unreadable `.env` is the normal case and falls back to the directory.
 */
async function inferProjectName(host: Host, directory: string): Promise<string> {
  try {
    const { content } = await host.readTextFile(`${directory}/.env`)
    const entry = parseEnv(content).find(
      (e) => e.kind === 'pair' && e.key === 'COMPOSE_PROJECT_NAME',
    )
    if (entry?.kind === 'pair' && entry.value !== '') return entry.value
  } catch {
    // No `.env`, or one we cannot read. Neither is an error worth failing a scan over.
  }
  return normaliseProjectName(directory)
}

/**
 * Joins directories on disk to containers labelled with a compose project.
 *
 * The project name is never the raw directory name. Compose normalises it and a
 * `COMPOSE_PROJECT_NAME` in `.env` overrides it entirely, so a naive comparison
 * reports a healthy stack as stopped AND lists its containers as an orphan. An
 * already-adopted app uses its recorded name, which adoption resolved properly.
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

  const candidates = await Promise.all(
    directories.map(async (dir) => {
      const recorded = adoptedByDirectory.get(dir.directory)?.projectName
      // An adopted app's recorded name wins: adoption resolved it through the CLI, so
      // it is authoritative even when `.env` has since changed underneath us.
      return recorded ?? (await inferProjectName(deps.host, dir.directory))
    }),
  )

  const discovered: DiscoveredApp[] = directories.map((dir, i) => {
    const adoptedRow = adoptedByDirectory.get(dir.directory)
    const candidate = candidates[i] ?? dir.directory
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
Expected: PASS, 12 tests.

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
    expect(result.detail).toBe('2/2 services up, 1 completed')
  })

  it('counts a completed one-shot toward the numerator', () => {
    // Excluding it produced a green dot beside "0/1 services up", which reads as broken.
    expect(rollUpStatus([service('init', 'no')], [container('init', 'exited', 'Exited (0)')]))
      .toEqual({ status: 'up', detail: '1/1 services up, 1 completed' })
  })

  it('takes the worst state across a scaled service\'s replicas', () => {
    // Keying containers by service name kept only the last, so two healthy replicas
    // beside one unhealthy reported the app as up — a green dot over a broken service.
    const result = rollUpStatus(
      [service('web')],
      [
        container('web', 'running', 'Up 2 hours (healthy)'),
        container('web', 'running', 'Up 2 hours (unhealthy)'),
        container('web', 'running', 'Up 2 hours (healthy)'),
      ],
    )
    expect(result.status).toBe('down')
  })

  it('calls a scaled service up when every replica is up', () => {
    const result = rollUpStatus(
      [service('web')],
      [container('web', 'running', 'Up 2 hours'), container('web', 'running', 'Up 1 hour')],
    )
    expect(result).toEqual({ status: 'up', detail: '1/1 services up' })
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

  it('covers the remaining container states', () => {
    // Each is a distinct switch branch, and a silent regression in any of them shows
    // the user a green dot over a stack that is not serving.
    expect(rollUpStatus([service('w')], [container('w', 'created')]).status).toBe('starting')
    expect(rollUpStatus([service('w')], [container('w', 'paused')]).status).toBe('degraded')
    expect(rollUpStatus([service('w')], [container('w', 'dead')]).status).toBe('down')
  })

  it('ignores a container the compose file no longer declares', () => {
    // `docker compose up` without `--remove-orphans` leaves the container of a deleted
    // service running. The rollup answers "are the declared services healthy", so an
    // undeclared extra is not a fault here; the adoption scan is where strays surface.
    const result = rollUpStatus(
      [service('web')],
      [container('web', 'running', 'Up 2 hours'), container('removed', 'running', 'Up 9 days')],
    )
    expect(result).toEqual({ status: 'up', detail: '1/1 services up' })
  })

  it('summarises counts in the detail string', () => {
    const result = rollUpStatus(
      [service('a'), service('b'), service('c')],
      [container('a', 'running'), container('b', 'running')],
    )
    expect(result.detail).toBe('2/3 services up, 1 missing')
  })

  it('names the cause rather than only the shortfall', () => {
    // The dot says something is wrong; this line says what. Without the cause clauses,
    // three restarting containers and three absent ones both read "0/3 services up".
    const detail = (containers: ContainerSummary[]) =>
      rollUpStatus([service('a'), service('b'), service('c')], containers).detail

    expect(detail([
      container('a', 'restarting'), container('b', 'restarting'), container('c', 'restarting'),
    ])).toBe('0/3 services up, 3 degraded')

    expect(detail([])).toBe('0/3 services up, 3 missing')

    expect(detail([
      container('a', 'running', 'Up 2 hours'),
      container('b', 'running', 'Up 1 minute (unhealthy)'),
      container('c', 'running', 'Up 3 seconds (health: starting)'),
    ])).toBe('1/3 services up, 1 starting, 1 failing')
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
      //
      // Only an EXPLICIT `restart: "no"` counts. Treating an absent policy as one-shot
      // too would cover almost every service in a typical compose file — the field is
      // usually omitted — so a web server that exited cleanly would read as success and
      // the app would show green while nothing was serving.
      const isOneShot = service.restart === 'no'
      return isOneShot && exitCodeOf(container.status) === 0 ? 'completed' : 'down'
    }
    default:
      return 'down'
  }
}

/**
 * Worst-first rank, so a service's state is the worst of its replicas'.
 *
 * A `Record` rather than an array on purpose: adding a member to `ServiceState` without
 * ranking it here is then a compile error. An array typed `ServiceState[]` accepts a
 * missing entry silently, and the new state would fall through to the `down` default.
 */
const SEVERITY: Record<ServiceState, number> = {
  down: 0,
  degraded: 1,
  starting: 2,
  up: 3,
  completed: 4,
}

/**
 * Collapses one service's containers into a single state.
 *
 * A service can have more than one container — `deploy.replicas`, or a `scale` left
 * over from a manual `docker compose up --scale`. Keying a Map by service name kept
 * only the last one, so two healthy replicas beside one unhealthy reported the whole
 * app as up: a green dot over a partly broken service, which is the exact failure this
 * module exists to prevent.
 */
function worst(states: ServiceState[]): ServiceState {
  return states.reduce<ServiceState>(
    (acc, state) => (SEVERITY[state] < SEVERITY[acc] ? state : acc),
    'completed',
  )
}

export function rollUpStatus(
  expected: ResolvedService[],
  containers: ContainerSummary[],
): AppStatusSummary {
  if (expected.length === 0) return { status: 'unknown', detail: null }

  const byService = new Map<string, ContainerSummary[]>()
  for (const c of containers) {
    const key = c.service ?? ''
    byService.set(key, [...(byService.get(key) ?? []), c])
  }

  const states = expected.map((service) => {
    const found = byService.get(service.name) ?? []
    if (found.length === 0) return classify(service, undefined)
    return worst(found.map((c) => classify(service, c)))
  })

  const count = (state: ServiceState) => states.filter((s) => s === state).length
  const up = count('up')
  const completed = count('completed')
  const missing = expected.filter((s) => (byService.get(s.name) ?? []).length === 0).length
  // A service that is `down` but has a container is failing, not absent — an unhealthy
  // health check or a non-zero exit. Separating the two is the whole point of the line.
  const failing = count('down') - missing

  // `completed` counts toward the numerator. A one-shot that exited zero IS in its
  // intended state, and excluding it produced a green dot beside the words
  // "0/1 services up" — which reads as broken.
  //
  // The remaining clauses name the cause, which is what this line is for: the dot says
  // something is wrong, the line says what. Without them a stack of three restarting
  // containers and a stack with three missing ones both read "0/3 services up".
  const parts = [`${up + completed}/${expected.length} services up`]
  if (completed > 0) parts.push(`${completed} completed`)
  if (count('starting') > 0) parts.push(`${count('starting')} starting`)
  if (count('degraded') > 0) parts.push(`${count('degraded')} degraded`)
  if (failing > 0) parts.push(`${failing} failing`)
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
Expected: PASS, 17 tests.

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
- `FakeHost` gains a `listContainersCalls` counter, incremented in `listContainers`, so a test can assert the list route makes exactly one Docker call rather than one per app.

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

  it('gives colliding directory names distinct slugs', async () => {
    // `My Media` and `my-media` both normalise to `mymedia`, and `apps_host_slug` is
    // unique — so the second insert raised a constraint violation that surfaced as a
    // 500 mid-adopt, losing the successful adoptions alongside it.
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    app.deps.host.files.set('My Media/compose.yaml', 'services: {}\n')
    app.deps.host.files.set('my-media/compose.yaml', 'services: {}\n')
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 0, stdout: JSON.stringify({ name: 'p', services: {} }), stderr: '',
    })
    const res = await app.inject({
      method: 'POST', url: '/api/apps/adopt', headers: { cookie },
      payload: { directories: ['My Media', 'my-media'] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().failed).toEqual([])
    const slugs = res.json().adopted.map((a: { slug: string }) => a.slug)
    expect(new Set(slugs).size).toBe(2)
    expect(slugs).toContain('mymedia')
    await app.close()
  })

  it('rejects a PATCH with no fields instead of crashing', async () => {
    // Every field is optional, so `{}` parses cleanly, and Drizzle throws on an empty
    // `set()` — a 500 for what is really a no-op request.
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    app.deps.host.files.set('a/compose.yaml', 'services: {}\n')
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 0, stdout: JSON.stringify({ name: 'a', services: {} }), stderr: '',
    })
    const adopted = await app.inject({
      method: 'POST', url: '/api/apps/adopt', headers: { cookie },
      payload: { directories: ['a'] },
    })
    const id = adopted.json().adopted[0].id
    const res = await app.inject({
      method: 'PATCH', url: `/api/apps/${id}`, headers: { cookie }, payload: {},
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('lists every app with a single call to Docker', async () => {
    // One round trip for the whole page. Per-row lookups meant one call per app on the
    // screen that shows all of them — thirty on this NAS, every page load.
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    for (const dir of ['a', 'b', 'c']) {
      app.deps.host.files.set(`${dir}/compose.yaml`, 'services: {}\n')
    }
    app.deps.host.composeResults.set('config --format json', {
      exitCode: 0, stdout: JSON.stringify({ name: 'p', services: {} }), stderr: '',
    })
    await app.inject({
      method: 'POST', url: '/api/apps/adopt', headers: { cookie },
      payload: { directories: ['a', 'b', 'c'] },
    })
    app.deps.host.listContainersCalls = 0
    const res = await app.inject({ method: 'GET', url: '/api/apps', headers: { cookie } })
    expect(res.json()).toHaveLength(3)
    expect(app.deps.host.listContainersCalls).toBe(1)
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
import type { ContainerSummary } from '../host/types.js'

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

/** A URL-safe slug: lowercase, anything outside `[a-z0-9-]` dropped. */
function normaliseSlug(directory: string): string {
  return directory.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'app'
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  const { db, host, composeConfig } = app.deps

  /**
   * Current status for one app.
   *
   * `containers` is passed in by the list route, which fetches once for every app.
   * Letting each row call `listContainers` itself meant one Docker API round trip per
   * app on a screen that shows all of them — thirty on this NAS, every page load.
   */
  async function statusFor(
    row: typeof apps.$inferSelect,
    containers?: ContainerSummary[],
  ) {
    const target = { directory: row.directory, composeFile: row.composeFile }
    const resolved = await composeConfig.resolve(target)
    if (!resolved.valid) return { status: 'unknown' as const, detail: resolved.message }
    const found = containers ?? (await host.listContainers({ project: row.projectName ?? '' }))
    return rollUpStatus(resolved.resolved.services, found)
  }

  /**
   * A slug no other app on this host holds.
   *
   * `apps_host_slug` is unique, and `normaliseSlug` is lossy — `My Media` and
   * `my-media` both become `mymedia`, as does any directory of pure punctuation via
   * the `'app'` fallback. Without this, adopting the second one raises a constraint
   * violation that surfaces as a 500 in the middle of a multi-directory adopt, losing
   * the successes alongside it.
   */
  async function uniqueSlug(directory: string): Promise<string> {
    const base = normaliseSlug(directory)
    const rows = await db
      .select({ slug: apps.slug })
      .from(apps)
      .where(eq(apps.hostId, LOCAL_HOST_ID))
    const taken = new Set(rows.map((r) => r.slug))
    if (!taken.has(base)) return base
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`
      if (!taken.has(candidate)) return candidate
    }
    // A thousand collisions on one base is not a real filesystem; fall back to
    // something certainly unique rather than looping forever.
    return `${base}-${ulid().toLowerCase()}`
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
        slug: await uniqueSlug(directory),
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

    // One Docker call for the whole page, partitioned by project. The per-row
    // alternative was a round trip per app on the screen that lists them all.
    const byProject = new Map<string, ContainerSummary[]>()
    for (const container of await host.listContainers()) {
      if (!container.project) continue
      byProject.set(container.project, [
        ...(byProject.get(container.project) ?? []),
        container,
      ])
    }

    return Promise.all(
      rows.map(async (row) => {
        const status = await statusFor(row, byProject.get(row.projectName ?? '') ?? [])
        return detailed ? toAdminApp(row, status) : toViewerApp(row, status)
      }),
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

    // Every field is optional, so `{}` parses cleanly — and Drizzle throws on an empty
    // `set()`, which would surface as a 500 for what is really a no-op request.
    if (Object.keys(body).length === 0) return reply.code(400).send({ error: 'no_fields' })

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
Expected: the focused file passes 11 tests; the full suite stays green.

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
