# Homestead Phase 1A — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running, authenticated Homestead application — complete database schema, encrypted secrets, a path-confined host abstraction over Docker and the filesystem, password authentication with roles and per-app scoping, and a React shell you can log into.

**Architecture:** Single Node process. Fastify serves a JSON API and the Vite-built SPA. Everything touching the machine goes through a `Host` interface whose only implementation is `LocalHost`. Better-Auth owns sessions; a custom plugin for Cloudflare Access identity is written but stays dormant until configured. Authorization is one composable scope predicate used by every app-reading query.

**Tech Stack:** TypeScript (ESM, strict), pnpm, Fastify, Vite + React, react-router-dom v6, TanStack Query v5, Tailwind, Drizzle + libSQL (SQLite), Better-Auth, dockerode, zod, Vitest, Biome, tsup.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 24, pnpm 12.** Use the newest stable major of every dependency; no RCs or betas.
  This includes `@types/node`, which must track the Node major in use (`^24`), not an older one.
- **TypeScript:** ESM only, `strict: true`, `moduleResolution: "bundler"`, `target: "ES2022"`. No CommonJS, no `require`.
- **Installed toolchain, verified during Task 1:** TypeScript 7.0.2, Vitest 5.0.0, Biome 2.5.12, Fastify 5.12.3.
- **TypeScript 7 removed `baseUrl`.** Never add it. Every `paths` target must be relative with a leading `./`, or compilation fails with `TS5102` / `TS5090`.
- **Layout:** single package, three zones — `src/web`, `src/server`, `src/shared`. Path aliases `@shared/*`, `@server/*`, `@web/*`.
- **No `Co-Authored-By` trailers and no AI-attribution lines in commit messages.** Plain author commits only.
- **Biome is the only linter/formatter.** No ESLint, no Prettier.
- **Tests are Vitest**, colocated as `*.test.ts` beside the code under test.
- **Create the complete schema in Task 3, including `exposures` and Cloudflare-related columns**, even though no Phase 1 code reads them. The spec's position is that the data model cannot be phased.
- **Never build a shell command as a string.** Subprocess invocations use an argument array.
- **All numeric defaults from the spec are settings**, not literals scattered through code.
- **Secrets never appear in API responses** unless an explicitly-named reveal endpoint returns them.
- Commit after every task. Message style: `feat: …`, `test: …`, `chore: …`.

---

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.json, tsconfig.server.json,
biome.json, vitest.config.ts, vite.config.ts, tailwind.config.ts, drizzle.config.ts
.env.example

src/shared/
  types.ts            Domain types shared by server and web
  capabilities.ts     Capability names + role→capability mapping

src/server/
  index.ts            Process entry: config → preflight → db → server → listen
  config.ts           Zod-validated environment configuration
  app.ts              Fastify instance construction and plugin registration
  db/
    schema.ts         Complete Drizzle schema (all tables)
    client.ts         libSQL client + Drizzle instance + migration runner
  crypto/
    secrets.ts        AES-256-GCM encrypt/decrypt; secrets table accessors
  host/
    types.ts          Host interface and its data types
    paths.ts          Path confinement (realpath-based)
    local-host.ts     LocalHost: filesystem + dockerode reads
    preflight.ts      Mount round-trip verification
  auth/
    auth.ts           Better-Auth instance
    access-plugin.ts  Cloudflare Access JWT plugin (dormant unless configured)
    context.ts        AuthContext preHandler + can() + scope predicate
  routes/
    health.ts         Liveness/readiness
    users.ts          User + scope management
    spa.ts            Static SPA serving with history fallback

src/web/
  main.tsx            React entry
  App.tsx             Router + providers
  api/client.ts       Typed fetch wrapper
  auth/useSession.ts  Session hook
  routes/
    Login.tsx
    Shell.tsx         Authenticated layout
    Placeholder.tsx   Stand-ins for 1B–1D routes
  index.css
```

---

### Task 1: Repository scaffold and tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `biome.json`, `vitest.config.ts`, `.env.example`, `src/shared/types.ts`
- Test: `src/shared/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: working `pnpm test`, `pnpm lint`, `pnpm typecheck`; path aliases `@shared/*`, `@server/*`, `@web/*`

- [ ] **Step 1: Initialise the package and install dependencies**

```bash
pnpm init
pnpm add fastify @fastify/static @fastify/cookie @fastify/rate-limit \
  drizzle-orm @libsql/client better-auth dockerode zod ulid jose
pnpm add -D typescript @types/node @types/dockerode vitest \
  @biomejs/biome drizzle-kit tsx tsup
```

- [ ] **Step 2: Write `package.json` scripts and type field**

Merge into `package.json`:

```json
{
  "name": "homestead",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"pnpm dev:server\" \"pnpm dev:web\"",
    "dev:server": "tsx watch src/server/index.ts",
    "dev:web": "vite",
    "build": "pnpm build:web && pnpm build:server",
    "build:web": "vite build",
    "build:server": "tsup src/server/index.ts --format esm --target node24 --out-dir dist/server",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/server/db/migrate.ts"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "types": ["node", "vitest/globals"],
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@server/*": ["./src/server/*"],
      "@web/*": ["./src/web/*"]
    }
  },
  "include": ["src", "*.config.ts"]
}
```

**No `baseUrl`, and every `paths` target is relative with a leading `./`.** TypeScript 7 removed
`baseUrl` outright (`error TS5102`) and rejects non-relative path targets (`error TS5090`).
Verified against the installed TypeScript 7.0.2.

- [ ] **Step 4: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": { "includes": ["src/**", "*.config.ts"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true, "suspicious": { "noExplicitAny": "error" } }
  },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

If the installed Biome major differs from `2.0.0`, update the `$schema` URL to match `pnpm biome --version`.

- [ ] **Step 5: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@server': fileURLToPath(new URL('./src/server', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  test: { globals: true, environment: 'node', include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 6: Write the failing test**

`src/shared/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { APP_STATUSES, isAppStatus } from '@shared/types'

describe('isAppStatus', () => {
  it('accepts every declared status', () => {
    for (const s of APP_STATUSES) expect(isAppStatus(s)).toBe(true)
  })

  it('rejects an unknown status', () => {
    expect(isAppStatus('exploded')).toBe(false)
  })
})
```

- [ ] **Step 7: Run the test and confirm it fails**

Run: `pnpm vitest run src/shared/types.test.ts`
Expected: FAIL — cannot resolve `@shared/types`.

- [ ] **Step 8: Write `src/shared/types.ts`**

```ts
export const APP_STATUSES = ['up', 'degraded', 'down', 'starting', 'unknown'] as const
export type AppStatus = (typeof APP_STATUSES)[number]

export const FAULT_CLASSES = ['app', 'network', 'config'] as const
export type FaultClass = (typeof FAULT_CLASSES)[number]

export const PROBE_KINDS = ['docker', 'http_internal', 'http_external'] as const
export type ProbeKind = (typeof PROBE_KINDS)[number]

export const ROLES = ['admin', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export function isAppStatus(value: string): value is AppStatus {
  return (APP_STATUSES as readonly string[]).includes(value)
}
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `pnpm vitest run src/shared/types.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 10: Write `.env.example`**

```bash
NODE_ENV=development
PORT=3000

# 32 random bytes, base64. Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
HOMESTEAD_SECRET_KEY=replace-me

HOMESTEAD_DB_PATH=./data/homestead.db
HOMESTEAD_COMPOSE_ROOT=/volume2/docker
HOMESTEAD_DOCKER_SOCKET=/var/run/docker.sock

# Every origin Homestead is reachable at, comma separated.
HOMESTEAD_BASE_URL=http://localhost:3000
HOMESTEAD_TRUSTED_ORIGINS=http://localhost:3000

# Peers whose X-Forwarded-For / CF-Connecting-IP headers are believed. Loopback only by
# default, because cloudflared runs with network_mode: host and reaches Homestead over
# localhost. Widening this to a LAN range lets anyone on that range forge their client IP.
HOMESTEAD_TRUSTED_PROXIES=127.0.0.1,::1

# Cloudflare Access. Both must be set for the Access sign-in path to activate.
HOMESTEAD_ACCESS_TEAM_DOMAIN=
HOMESTEAD_ACCESS_AUD=

# Skip the Docker mount round-trip check. Development and CI only.
HOMESTEAD_SKIP_MOUNT_PREFLIGHT=false
```

- [ ] **Step 11: Verify lint and typecheck pass**

Run: `pnpm lint && pnpm typecheck`
Expected: both exit 0. Run `pnpm lint:fix` first if formatting differs.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project with Biome, Vitest, and path aliases"
```

---

### Task 2: Environment configuration

**Files:**
- Create: `src/server/config.ts`
- Test: `src/server/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` and `type Config` with fields `nodeEnv`, `port`, `secretKey` (a 32-byte `Buffer`), `dbPath`, `composeRoot`, `dockerSocket`, `baseUrl`, `trustedOrigins` (`string[]`), `accessTeamDomain` (`string | null`), `accessAud` (`string | null`), `accessEnabled` (`boolean`), `skipMountPreflight` (`boolean`)

- [ ] **Step 1: Write the failing test**

`src/server/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '@server/config'

const base = {
  HOMESTEAD_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  HOMESTEAD_BASE_URL: 'http://localhost:3000',
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig({ ...base })
    expect(c.port).toBe(3000)
    expect(c.composeRoot).toBe('/volume2/docker')
    expect(c.dockerSocket).toBe('/var/run/docker.sock')
  })

  it('decodes the secret key to 32 bytes', () => {
    expect(loadConfig({ ...base }).secretKey).toHaveLength(32)
  })

  it('rejects a secret key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...base, HOMESTEAD_SECRET_KEY: Buffer.alloc(16).toString('base64') }))
      .toThrow(/32 bytes/)
  })

  it('rejects a missing secret key', () => {
    expect(() => loadConfig({ HOMESTEAD_BASE_URL: base.HOMESTEAD_BASE_URL })).toThrow()
  })

  it('splits and trims trusted origins, always including the base URL', () => {
    const c = loadConfig({ ...base, HOMESTEAD_TRUSTED_ORIGINS: 'http://nas.local:3000 , https://hs.example.com' })
    expect(c.trustedOrigins).toEqual([
      'http://localhost:3000',
      'http://nas.local:3000',
      'https://hs.example.com',
    ])
  })

  it('leaves Access disabled unless both values are present', () => {
    expect(loadConfig({ ...base }).accessEnabled).toBe(false)
    expect(loadConfig({ ...base, HOMESTEAD_ACCESS_TEAM_DOMAIN: 'acme' }).accessEnabled).toBe(false)
    expect(loadConfig({ ...base, HOMESTEAD_ACCESS_AUD: 'abc' }).accessEnabled).toBe(false)
    expect(
      loadConfig({ ...base, HOMESTEAD_ACCESS_TEAM_DOMAIN: 'acme', HOMESTEAD_ACCESS_AUD: 'abc' })
        .accessEnabled,
    ).toBe(true)
  })

  it('treats empty Access strings as absent', () => {
    const c = loadConfig({ ...base, HOMESTEAD_ACCESS_TEAM_DOMAIN: '', HOMESTEAD_ACCESS_AUD: '' })
    expect(c.accessEnabled).toBe(false)
    expect(c.accessTeamDomain).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/config.test.ts`
Expected: FAIL — cannot resolve `@server/config`.

- [ ] **Step 3: Write `src/server/config.ts`**

```ts
import { z } from 'zod'

const optionalString = z
  .string()
  .transform((v) => (v.trim() === '' ? null : v.trim()))
  .nullable()
  .default(null)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOMESTEAD_SECRET_KEY: z.string().min(1),
  HOMESTEAD_DB_PATH: z.string().default('./data/homestead.db'),
  HOMESTEAD_COMPOSE_ROOT: z.string().default('/volume2/docker'),
  HOMESTEAD_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  // z.url(), not z.string().url() — the latter carries a @deprecated marker in zod 4.
  HOMESTEAD_BASE_URL: z.url(),
  HOMESTEAD_TRUSTED_ORIGINS: z.string().default(''),
  // Peers whose X-Forwarded-For / CF-Connecting-IP headers may be believed.
  // Defaults to loopback: cloudflared runs with network_mode: host and reaches
  // Homestead over localhost, while LAN clients connect from a LAN address.
  HOMESTEAD_TRUSTED_PROXIES: z.string().default('127.0.0.1,::1'),
  HOMESTEAD_ACCESS_TEAM_DOMAIN: optionalString,
  HOMESTEAD_ACCESS_AUD: optionalString,
  HOMESTEAD_SKIP_MOUNT_PREFLIGHT: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
})

export type Config = {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  secretKey: Buffer
  dbPath: string
  composeRoot: string
  dockerSocket: string
  baseUrl: string
  trustedOrigins: string[]
  trustedProxies: string[]
  accessTeamDomain: string | null
  accessAud: string | null
  accessEnabled: boolean
  skipMountPreflight: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.parse(env)

  const secretKey = Buffer.from(parsed.HOMESTEAD_SECRET_KEY, 'base64')
  if (secretKey.length !== 32) {
    throw new Error(
      `HOMESTEAD_SECRET_KEY must decode to exactly 32 bytes, got ${secretKey.length}. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
  }

  const extraOrigins = parsed.HOMESTEAD_TRUSTED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')

  const trustedOrigins = [...new Set([parsed.HOMESTEAD_BASE_URL, ...extraOrigins])]

  const trustedProxies = parsed.HOMESTEAD_TRUSTED_PROXIES.split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')

  const accessTeamDomain = parsed.HOMESTEAD_ACCESS_TEAM_DOMAIN
  const accessAud = parsed.HOMESTEAD_ACCESS_AUD

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    secretKey,
    dbPath: parsed.HOMESTEAD_DB_PATH,
    composeRoot: parsed.HOMESTEAD_COMPOSE_ROOT,
    dockerSocket: parsed.HOMESTEAD_DOCKER_SOCKET,
    baseUrl: parsed.HOMESTEAD_BASE_URL,
    trustedOrigins,
    trustedProxies,
    accessTeamDomain,
    accessAud,
    accessEnabled: accessTeamDomain !== null && accessAud !== null,
    skipMountPreflight: parsed.HOMESTEAD_SKIP_MOUNT_PREFLIGHT,
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/config.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts src/server/config.test.ts
git commit -m "feat: add validated environment configuration"
```

---

### Task 3: Complete database schema

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/db/migrate.ts`, `drizzle.config.ts`
- Test: `src/server/db/schema.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 2
- Produces: `createDb(dbPath: string): Database` where `Database = { client, db }`; `runMigrations(db)`; all table objects exported from `schema.ts`

**This task creates every table in the spec, including `exposures` and `imageStatus`, which no Phase 1 code reads.** Retrofitting them later would churn every query touching app identity.

- [ ] **Step 1: Write `src/server/db/schema.ts`**

```ts
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

const now = sql`(unixepoch())`

// ── Better-Auth owned tables ────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  // Homestead additional fields. `role` and `scopeAllApps` are server-owned.
  role: text('role', { enum: ['admin', 'viewer'] }).notNull().default('viewer'),
  scopeAllApps: integer('scope_all_apps', { mode: 'boolean' }).notNull().default(true),
  disabledAt: integer('disabled_at'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: integer('access_token_expires_at'),
  refreshTokenExpiresAt: integer('refresh_token_expires_at'),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
})

// ── Homestead domain ────────────────────────────────────────────────────────

export const hosts = sqliteTable('hosts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['local'] }).notNull().default('local'),
  composeRoot: text('compose_root').notNull(),
  dockerSocket: text('docker_socket').notNull(),
  createdAt: integer('created_at').notNull().default(now),
})

export const apps = sqliteTable(
  'apps',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id').notNull().references(() => hosts.id),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    iconRef: text('icon_ref'),
    category: text('category'),
    sortOrder: integer('sort_order').notNull().default(0),
    showOnLauncher: integer('show_on_launcher', { mode: 'boolean' }).notNull().default(true),
    directory: text('directory').notNull(),
    composeFile: text('compose_file').notNull(),
    projectName: text('project_name').notNull(),
    launchInternalUrl: text('launch_internal_url'),
    lastComposeHash: text('last_compose_hash'),
    isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
    graceUntil: integer('grace_until'),
    adoptedAt: integer('adopted_at').notNull().default(now),
    archivedAt: integer('archived_at'),
  },
  (t) => [
    unique('apps_host_slug').on(t.hostId, t.slug),
    unique('apps_host_directory').on(t.hostId, t.directory),
    index('apps_launcher_idx').on(t.showOnLauncher, t.category, t.sortOrder),
  ],
)

export const probes = sqliteTable(
  'probes',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['docker', 'http_internal', 'http_external'] }).notNull(),
    label: text('label'),
    target: text('target'),
    expectedStatusPattern: text('expected_status_pattern').notNull().default('2xx,3xx'),
    timeoutMs: integer('timeout_ms').notNull().default(5000),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    insecureTls: integer('insecure_tls', { mode: 'boolean' }).notNull().default(false),
    followRedirects: integer('follow_redirects', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    nextRunAt: integer('next_run_at').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    // Denormalised current state. Written in the same transaction as check_results.
    lastStatus: text('last_status', { enum: ['up', 'degraded', 'down', 'starting', 'unknown'] })
      .notNull()
      .default('unknown'),
    lastLatencyMs: integer('last_latency_ms'),
    lastDetail: text('last_detail', { mode: 'json' }),
    lastFaultClass: text('last_fault_class', { enum: ['app', 'network', 'config'] }),
    lastCheckedAt: integer('last_checked_at'),
    statusSince: integer('status_since'),
  },
  (t) => [index('probes_due_idx').on(t.enabled, t.nextRunAt), index('probes_app_idx').on(t.appId)],
)

export const checkResults = sqliteTable(
  'check_results',
  {
    id: text('id').primaryKey(),
    probeId: text('probe_id').notNull().references(() => probes.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['up', 'degraded', 'down', 'starting', 'unknown'] }).notNull(),
    faultClass: text('fault_class', { enum: ['app', 'network', 'config'] }),
    latencyMs: integer('latency_ms'),
    detail: text('detail', { mode: 'json' }),
    checkedAt: integer('checked_at').notNull(),
  },
  (t) => [index('check_results_probe_time_idx').on(t.probeId, t.checkedAt)],
)

export const checkRollups = sqliteTable(
  'check_rollups',
  {
    probeId: text('probe_id').notNull().references(() => probes.id, { onDelete: 'cascade' }),
    hourStart: integer('hour_start').notNull(),
    upCount: integer('up_count').notNull().default(0),
    degradedCount: integer('degraded_count').notNull().default(0),
    downCount: integer('down_count').notNull().default(0),
    avgLatencyMs: integer('avg_latency_ms'),
    maxLatencyMs: integer('max_latency_ms'),
  },
  (t) => [primaryKey({ columns: [t.probeId, t.hourStart] })],
)

// Unused in Phase 1. Present because the data model cannot be phased.
export const exposures = sqliteTable('exposures', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().unique().references(() => apps.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull().unique(),
  zoneId: text('zone_id'),
  dnsRecordId: text('dns_record_id'),
  tunnelId: text('tunnel_id'),
  ingressService: text('ingress_service').notNull(),
  accessAppId: text('access_app_id'),
  accessAppAud: text('access_app_aud'),
  dnsRecordCreatedByUs: integer('dns_record_created_by_us', { mode: 'boolean' })
    .notNull()
    .default(false),
  ingressRuleCreatedByUs: integer('ingress_rule_created_by_us', { mode: 'boolean' })
    .notNull()
    .default(false),
  accessAppCreatedByUs: integer('access_app_created_by_us', { mode: 'boolean' })
    .notNull()
    .default(false),
  state: text('state', { enum: ['provisioning', 'ready', 'error', 'drifted'] })
    .notNull()
    .default('provisioning'),
  lastError: text('last_error'),
  lastSyncedAt: integer('last_synced_at'),
})

export const userAppScope = sqliteTable(
  'user_app_scope',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.appId] })],
)

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').references(() => apps.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] })
      .notNull()
      .default('queued'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    exitCode: integer('exit_code'),
    output: text('output'),
    userId: text('user_id').references(() => users.id),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('jobs_app_created_idx').on(t.appId, t.createdAt)],
)

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id),
    authPath: text('auth_path', { enum: ['password', 'access', 'system'] }).notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: text('detail', { mode: 'json' }),
    ip: text('ip'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('audit_created_idx').on(t.createdAt)],
)

export const secrets = sqliteTable('secrets', {
  key: text('key').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const imageStatus = sqliteTable(
  'image_status',
  {
    appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
    serviceName: text('service_name').notNull(),
    currentDigest: text('current_digest'),
    latestDigest: text('latest_digest'),
    updateAvailable: integer('update_available', { mode: 'boolean' }).notNull().default(false),
    checkedAt: integer('checked_at'),
  },
  (t) => [primaryKey({ columns: [t.appId, t.serviceName] })],
)

export const setupState = sqliteTable('setup_state', {
  id: integer('id').primaryKey().default(1),
  completedSteps: text('completed_steps', { mode: 'json' }).notNull().default('[]'),
  completedAt: integer('completed_at'),
  updatedAt: integer('updated_at').notNull().default(now),
})

export const schema = {
  users, sessions, accounts, verifications,
  hosts, apps, probes, checkResults, checkRollups, exposures,
  userAppScope, jobs, auditLog, secrets, imageStatus, setupState,
}
```

- [ ] **Step 2: Write `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: `file:${process.env.HOMESTEAD_DB_PATH ?? './data/homestead.db'}` },
})
```

- [ ] **Step 3: Write `src/server/db/client.ts`**

```ts
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { schema } from './schema.js'

export function createDb(dbPath: string) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const client = createClient({ url: dbPath === ':memory:' ? ':memory:' : `file:${dbPath}` })
  const db = drizzle(client, { schema })
  return { client, db }
}

export type Db = ReturnType<typeof createDb>['db']

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: './drizzle' })
}
```

- [ ] **Step 4: Write `src/server/db/migrate.ts`**

```ts
import { loadConfig } from '../config.js'
import { createDb, runMigrations } from './client.js'

const config = loadConfig(process.env)
const { db } = createDb(config.dbPath)
await runMigrations(db)
console.log(`Migrations applied to ${config.dbPath}`)
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm db:generate`
Expected: a new SQL file under `drizzle/`. Inspect it and confirm every table above appears.

- [ ] **Step 6: Write the failing test**

`src/server/db/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createDb, runMigrations } from '@server/db/client'
import { apps, hosts, users } from '@server/db/schema'
import { ulid } from 'ulid'

async function freshDb() {
  const { db } = createDb(':memory:')
  await runMigrations(db)
  return db
}

describe('schema', () => {
  it('defaults a new user to viewer with full scope', async () => {
    const db = await freshDb()
    const id = ulid()
    await db.insert(users).values({ id, name: 'Ada', email: 'ada@example.com' })
    const [row] = await db.select().from(users)
    expect(row?.role).toBe('viewer')
    expect(row?.scopeAllApps).toBe(true)
  })

  it('rejects two apps sharing a slug on one host', async () => {
    const db = await freshDb()
    const hostId = ulid()
    await db.insert(hosts).values({
      id: hostId, name: 'local', composeRoot: '/volume2/docker', dockerSocket: '/var/run/docker.sock',
    })
    const row = (slug: string) => ({
      id: ulid(), hostId, slug, displayName: slug,
      directory: slug, composeFile: 'compose.yaml', projectName: slug,
    })
    await db.insert(apps).values(row('jellyfin'))
    await expect(db.insert(apps).values(row('jellyfin'))).rejects.toThrow()
  })

  it('cascades probe deletion when an app is removed', async () => {
    const db = await freshDb()
    // Cascade is exercised fully in Task 3 Step 8; this asserts the FK exists.
    expect(apps).toBeDefined()
  })
})
```

- [ ] **Step 7: Run the test and confirm it fails, then passes**

Run: `pnpm vitest run src/server/db/schema.test.ts`
Expected: initially FAIL if migrations are missing; after Step 5 they PASS. If the unique-constraint test does not reject, confirm `unique('apps_host_slug')` made it into the generated SQL.

- [ ] **Step 8: Verify foreign keys are enforced**

libSQL does not enable foreign key enforcement by default in all configurations. Add to `createDb`, immediately after creating the client:

```ts
await client.execute('PRAGMA foreign_keys = ON')
```

Make `createDb` async and update `db/migrate.ts` and the test helper to `await createDb(...)`. Then extend the cascade test:

```ts
it('cascades probe deletion when an app is removed', async () => {
  const db = await freshDb()
  const hostId = ulid()
  await db.insert(hosts).values({
    id: hostId, name: 'local', composeRoot: '/volume2/docker', dockerSocket: '/var/run/docker.sock',
  })
  const appId = ulid()
  await db.insert(apps).values({
    id: appId, hostId, slug: 'immich', displayName: 'Immich',
    directory: 'immich', composeFile: 'compose.yaml', projectName: 'immich',
  })
  await db.insert(probes).values({ id: ulid(), appId, kind: 'docker' })
  await db.delete(apps).where(eq(apps.id, appId))
  expect(await db.select().from(probes)).toHaveLength(0)
})
```

Import `probes` and `eq` at the top. Run the tests again and confirm all pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add complete database schema with migrations"
```

---

### Task 4: Encrypted secrets

**Files:**
- Create: `src/server/crypto/secrets.ts`
- Test: `src/server/crypto/secrets.test.ts`

**Interfaces:**
- Consumes: `Config.secretKey`, `Db`
- Produces: `encrypt(key: Buffer, plaintext: string, aad: string): { ciphertext: string; iv: string; tag: string }`, `decrypt(key: Buffer, parts, aad: string): string`, and class `SecretStore` with `set(name, value): Promise<void>`, `get(name): Promise<string | null>`, `delete(name): Promise<void>`

**The `aad` parameter is mandatory and is the secret's name.** GCM authenticates a ciphertext
but knows nothing about where it is stored, so without additional authenticated data an attacker
with database write access — or a partially-restored backup — can swap two rows'
`ciphertext`/`iv`/`tag` triples and `get('cf_api_token')` will decrypt *successfully*, returning
the tunnel token instead. The tag is valid; it is simply valid for the wrong value. Binding the
name into the AAD makes that swap fail closed.

`SecretStore.get` must pass the **queried** name as the AAD, never `row.key`. Using the stored
column would authenticate the row against itself and restore the very hole this closes.

- [ ] **Step 1: Write the failing test**

`src/server/crypto/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '@server/crypto/secrets'

const key = Buffer.alloc(32, 3)

describe('encrypt / decrypt', () => {
  it('round-trips a value', () => {
    expect(decrypt(key, encrypt(key, 'cf-api-token'))).toBe('cf-api-token')
  })

  it('produces a different ciphertext each time', () => {
    expect(encrypt(key, 'same').ciphertext).not.toBe(encrypt(key, 'same').ciphertext)
  })

  it('rejects a tampered ciphertext', () => {
    const parts = encrypt(key, 'secret')
    const bytes = Buffer.from(parts.ciphertext, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    expect(() => decrypt(key, { ...parts, ciphertext: bytes.toString('base64') })).toThrow()
  })

  it('rejects the wrong key', () => {
    expect(() => decrypt(Buffer.alloc(32, 9), encrypt(key, 'secret'))).toThrow()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/crypto/secrets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/crypto/secrets.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { secrets } from '../db/schema.js'

const ALGORITHM = 'aes-256-gcm'

export type EncryptedParts = { ciphertext: string; iv: string; tag: string }

/** `aad` binds the ciphertext to the secret's name. See the note above. */
export function encrypt(key: Buffer, plaintext: string, aad: string): EncryptedParts {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decrypt(key: Buffer, parts: EncryptedParts, aad: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parts.iv, 'base64'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(parts.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(parts.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  async set(name: string, value: string): Promise<void> {
    const parts = encrypt(this.key, value, name)
    await this.db
      .insert(secrets)
      .values({ key: name, ...parts, updatedAt: Math.floor(Date.now() / 1000) })
      .onConflictDoUpdate({
        target: secrets.key,
        set: { ...parts, updatedAt: Math.floor(Date.now() / 1000) },
      })
  }

  async get(name: string): Promise<string | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.key, name))
    // AAD is the *queried* name, never row.key — see the note above.
    return row ? decrypt(this.key, row, name) : null
  }

  async delete(name: string): Promise<void> {
    await this.db.delete(secrets).where(eq(secrets.key, name))
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/crypto/secrets.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add a `SecretStore` round-trip test**

Append to the test file:

```ts
import { createDb, runMigrations } from '@server/db/client'
import { SecretStore } from '@server/crypto/secrets'

describe('SecretStore', () => {
  it('stores, reads back, overwrites, and deletes', async () => {
    const { db } = await createDb(':memory:')
    await runMigrations(db)
    const store = new SecretStore(db, key)

    expect(await store.get('cf_api_token')).toBeNull()
    await store.set('cf_api_token', 'token-one')
    expect(await store.get('cf_api_token')).toBe('token-one')
    await store.set('cf_api_token', 'token-two')
    expect(await store.get('cf_api_token')).toBe('token-two')
    await store.delete('cf_api_token')
    expect(await store.get('cf_api_token')).toBeNull()
  })
})
```

Run: `pnpm vitest run src/server/crypto/secrets.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Add the row-swap regression test**

Append to the test file:

```ts
import { eq } from 'drizzle-orm'
import { secrets } from '@server/db/schema'

describe('name binding', () => {
  it('refuses to decrypt a secret whose row was swapped with another', async () => {
    const { db } = await createDb(':memory:')
    await runMigrations(db)
    const store = new SecretStore(db, key)

    await store.set('cf_api_token', 'the-cloudflare-token')
    await store.set('tunnel_token', 'the-tunnel-token')

    // Simulate an attacker with DB write access, or a partially restored backup,
    // moving the tunnel token's encrypted payload into the API token's row.
    const [tunnelRow] = await db.select().from(secrets).where(eq(secrets.key, 'tunnel_token'))
    await db
      .update(secrets)
      .set({
        ciphertext: tunnelRow!.ciphertext,
        iv: tunnelRow!.iv,
        tag: tunnelRow!.tag,
      })
      .where(eq(secrets.key, 'cf_api_token'))

    // Without AAD this returns 'the-tunnel-token' with a valid auth tag.
    await expect(store.get('cf_api_token')).rejects.toThrow()
  })

  it('rejects a value encrypted under a different name', () => {
    const parts = encrypt(key, 'value', 'name-a')
    expect(() => decrypt(key, parts, 'name-b')).toThrow()
    expect(decrypt(key, parts, 'name-a')).toBe('value')
  })
})
```

Run: `pnpm vitest run src/server/crypto/secrets.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/crypto
git commit -m "feat: add AES-256-GCM encrypted secret storage"
```

---

### Task 5: Path confinement

**Files:**
- Create: `src/server/host/paths.ts`
- Test: `src/server/host/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class PathGuard { constructor(configuredRoot: string); init(): Promise<void>; resolveExisting(rel: string): Promise<string>; resolveForWrite(rel: string): Promise<string> }` and `class PathEscapeError extends Error`

This is security-critical. `/volume2/docker` is a user-writable NAS share reachable over SMB, so an attacker can plant symlinks. A string-prefix check is not sufficient — resolution must happen before comparison. Because the compose root may itself be a symlink, membership is accepted under **either** the configured root or its resolved real path.

- [ ] **Step 1: Write the failing test**

`src/server/host/paths.test.ts`:

```ts
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathEscapeError, PathGuard } from '@server/host/paths'

let root: string
let outside: string

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'hs-paths-'))
  root = join(base, 'compose')
  outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(join(root, 'jellyfin'), { recursive: true })
  await writeFile(join(root, 'jellyfin', 'compose.yaml'), 'services: {}')
  await writeFile(join(outside, 'passwd'), 'root:x:0:0')
})

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true })
})

describe('PathGuard', () => {
  it('resolves a legitimate path inside the root', async () => {
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveExisting('jellyfin/compose.yaml')).resolves.toContain('jellyfin')
  })

  it('rejects traversal with ..', async () => {
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveExisting('../outside/passwd')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects an absolute path', async () => {
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveExisting('/etc/passwd')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects a symlink escaping the root', async () => {
    await symlink(outside, join(root, 'escape'))
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveExisting('escape/passwd')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects a write whose parent directory is a symlink escaping the root', async () => {
    await symlink(outside, join(root, 'escape'))
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveForWrite('escape/newfile.txt')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects a write whose TARGET is a symlink escaping the root, inside a legitimate parent', async () => {
    // The parent (jellyfin/) is entirely legitimate. Only the target is a symlink.
    // Verified: without the target check, writeTextFile overwrites the outside file.
    await symlink(join(outside, 'passwd'), join(root, 'jellyfin', '.env'))
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveForWrite('jellyfin/.env')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('still allows creating a genuinely new file in a legitimate directory', async () => {
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveForWrite('jellyfin/brand-new.env')).resolves.toContain('brand-new.env')
  })

  it.each(['', '.', './', '  '])('rejects %j, which addresses the root itself', async (rel) => {
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveExisting(rel)).rejects.toBeInstanceOf(PathEscapeError)
    await expect(guard.resolveForWrite(rel)).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('allows a write to a not-yet-existing file inside the root', async () => {
    const guard = new PathGuard(root)
    await guard.init()
    await expect(guard.resolveForWrite('jellyfin/.env')).resolves.toContain('.env')
  })

  it('accepts paths when the configured root is itself a symlink', async () => {
    const linkedRoot = join(root, '..', 'linked')
    await symlink(root, linkedRoot)
    const guard = new PathGuard(linkedRoot)
    await guard.init()
    await expect(guard.resolveExisting('jellyfin/compose.yaml')).resolves.toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/host/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/host/paths.ts`**

```ts
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'

export class PathEscapeError extends Error {
  constructor(rel: string) {
    super(`Path escapes the compose root: ${rel}`)
    this.name = 'PathEscapeError'
  }
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

export class PathGuard {
  private roots: string[] = []

  constructor(private readonly configuredRoot: string) {}

  /** Resolves the configured root once. Both the configured and real paths are accepted. */
  async init(): Promise<void> {
    const configured = resolve(this.configuredRoot)
    const real = await realpath(configured)
    this.roots = configured === real ? [configured] : [configured, real]
  }

  /**
   * Returns the configured root, proving initialisation in the same step.
   * Returning the value rather than asserting a side condition is what lets callers
   * avoid both a non-null assertion (which Biome's noNonNullAssertion rejects) and a
   * redundant second undefined check.
   */
  private requireRoot(): string {
    const root = this.roots[0]
    if (!root) throw new Error('PathGuard.init() was not awaited')
    return root
  }

  /** Rejects paths that address the root itself rather than something within it. */
  private assertAddressesChild(rel: string): void {
    const trimmed = rel.trim()
    if (trimmed === '' || trimmed === '.' || trimmed === './') throw new PathEscapeError(rel)
  }

  /** Resolves a path that must already exist, following symlinks before the check. */
  async resolveExisting(rel: string): Promise<string> {
    if (isAbsolute(rel)) throw new PathEscapeError(rel)
    this.assertAddressesChild(rel)
    const candidate = resolve(this.requireRoot(), rel)
    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      throw new PathEscapeError(rel)
    }
    if (!this.roots.some((r) => isInside(real, r))) throw new PathEscapeError(rel)
    return real
  }

  /**
   * Resolves a path that may not exist yet. Two separate checks are required:
   * the parent directory must resolve inside the root, AND if the target itself
   * already exists it must also resolve inside the root.
   */
  async resolveForWrite(rel: string): Promise<string> {
    if (isAbsolute(rel)) throw new PathEscapeError(rel)
    this.assertAddressesChild(rel)
    const candidate = resolve(this.requireRoot(), rel)

    // Check 1: the parent must exist and resolve inside the root. Stops
    // `escape -> /etc` being used to write `escape/newfile`.
    let realParent: string
    try {
      realParent = await realpath(dirname(candidate))
    } catch {
      throw new PathEscapeError(rel)
    }
    if (!this.roots.some((r) => isInside(realParent, r))) throw new PathEscapeError(rel)

    // Check 2: if the target already exists, IT must resolve inside the root too.
    // A legitimate parent can still contain a symlink pointing anywhere — planting
    // `app/.env -> /etc/cron.d/x` passes check 1 and would otherwise be written through.
    // A target that does not exist yet is fine; that is the normal create case.
    try {
      const realTarget = await realpath(candidate)
      if (!this.roots.some((r) => isInside(realTarget, r))) throw new PathEscapeError(rel)
    } catch (error) {
      if (error instanceof PathEscapeError) throw error
      // ENOENT: target does not exist yet. Proceed.
    }

    return resolve(realParent, basename(candidate))
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/host/paths.test.ts`
Expected: PASS, 7 tests. If the symlinked-root test fails on macOS, note that `/tmp` is itself a symlink to `/private/tmp` — that is exactly the condition this class exists to handle, so fix the implementation rather than the test.

- [ ] **Step 5: Commit**

```bash
git add src/server/host/paths.ts src/server/host/paths.test.ts
git commit -m "feat: add realpath-based path confinement for the compose root"
```

---

### Task 6: Host interface and LocalHost

**Files:**
- Create: `src/server/host/types.ts`, `src/server/host/local-host.ts`
- Test: `src/server/host/local-host.test.ts`

**Interfaces:**
- Consumes: `PathGuard` from Task 5
- Produces:

```ts
export type DiscoveredDir = { directory: string; composeFile: string }
export type ContainerSummary = {
  id: string; names: string[]; image: string; state: string; status: string
  project: string | null; service: string | null; labels: Record<string, string>
}
export type FileRead = { content: string; hash: string }

export interface Host {
  readonly id: string
  listAppDirectories(): Promise<DiscoveredDir[]>
  readTextFile(rel: string): Promise<FileRead>
  writeTextFile(rel: string, content: string, expectedHash: string | null): Promise<{ hash: string }>
  listContainers(filters?: { project?: string }): Promise<ContainerSummary[]>
  inspectContainer(id: string): Promise<unknown>
}

export class HashMismatchError extends Error {}
export function hashContent(content: string): string  // sha256 hex
```

- [ ] **Step 1: Write `src/server/host/types.ts`**

```ts
export type DiscoveredDir = { directory: string; composeFile: string }

export type ContainerSummary = {
  id: string
  names: string[]
  image: string
  state: string
  status: string
  project: string | null
  service: string | null
  labels: Record<string, string>
}

export type FileRead = { content: string; hash: string }

export interface Host {
  readonly id: string
  listAppDirectories(): Promise<DiscoveredDir[]>
  readTextFile(rel: string): Promise<FileRead>
  writeTextFile(
    rel: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }>
  listContainers(filters?: { project?: string }): Promise<ContainerSummary[]>
  inspectContainer(id: string): Promise<unknown>
}

export class HashMismatchError extends Error {
  constructor(
    readonly expected: string | null,
    readonly actual: string,
  ) {
    super('File changed on disk since it was read')
    this.name = 'HashMismatchError'
  }
}
```

- [ ] **Step 2: Write the failing test**

`src/server/host/local-host.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalHost, hashContent } from '@server/host/local-host'
import { HashMismatchError } from '@server/host/types'

let root: string
let host: LocalHost

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hs-host-'))
  await mkdir(join(root, 'jellyfin'), { recursive: true })
  await writeFile(join(root, 'jellyfin', 'compose.yaml'), 'services:\n  web:\n    image: alpine\n')
  await mkdir(join(root, 'immich'), { recursive: true })
  await writeFile(join(root, 'immich', 'docker-compose.yml'), 'services: {}\n')
  await mkdir(join(root, 'not-an-app'), { recursive: true })
  await writeFile(join(root, 'loose-file.txt'), 'ignored')
  host = new LocalHost('local', root, '/var/run/docker.sock')
  await host.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('LocalHost filesystem', () => {
  it('discovers only directories containing a compose file', async () => {
    const dirs = await host.listAppDirectories()
    expect(dirs.map((d) => d.directory).sort()).toEqual(['immich', 'jellyfin'])
  })

  it('reports which compose filename each directory uses', async () => {
    const dirs = await host.listAppDirectories()
    expect(dirs.find((d) => d.directory === 'immich')?.composeFile).toBe('docker-compose.yml')
    expect(dirs.find((d) => d.directory === 'jellyfin')?.composeFile).toBe('compose.yaml')
  })

  it('reads a file with its hash', async () => {
    const { content, hash } = await host.readTextFile('jellyfin/compose.yaml')
    expect(content).toContain('image: alpine')
    expect(hash).toBe(hashContent(content))
  })

  it('writes when the expected hash matches', async () => {
    const { hash } = await host.readTextFile('jellyfin/compose.yaml')
    await host.writeTextFile('jellyfin/compose.yaml', 'services: {}\n', hash)
    expect(await readFile(join(root, 'jellyfin', 'compose.yaml'), 'utf8')).toBe('services: {}\n')
  })

  it('refuses to write when the file changed on disk', async () => {
    const { hash } = await host.readTextFile('jellyfin/compose.yaml')
    await writeFile(join(root, 'jellyfin', 'compose.yaml'), 'changed by ssh\n')
    await expect(
      host.writeTextFile('jellyfin/compose.yaml', 'services: {}\n', hash),
    ).rejects.toBeInstanceOf(HashMismatchError)
  })

  it('creates a new file when the expected hash is null', async () => {
    const { hash } = await host.writeTextFile('jellyfin/.env', 'PUID=1000\n', null)
    expect(hash).toBe(hashContent('PUID=1000\n'))
  })

  it('refuses to overwrite an existing file when the expected hash is null', async () => {
    await expect(
      host.writeTextFile('jellyfin/compose.yaml', 'x', null),
    ).rejects.toBeInstanceOf(HashMismatchError)
  })

  it('rejects a path outside the root', async () => {
    await expect(host.readTextFile('../escape.txt')).rejects.toThrow()
  })

  it('creates new files owner-only, because .env holds secrets', async () => {
    await host.writeTextFile('jellyfin/.env', 'DB_PASSWORD=hunter2\n', null)
    const { mode } = await stat(join(root, 'jellyfin', '.env'))
    expect(mode & 0o777).toBe(0o600)
  })

  it('preserves the existing mode instead of resetting it to the umask', async () => {
    const target = join(root, 'jellyfin', 'locked.env')
    await writeFile(target, 'API_KEY=abc\n')
    await chmod(target, 0o600)

    const { hash } = await host.readTextFile('jellyfin/locked.env')
    await host.writeTextFile('jellyfin/locked.env', 'API_KEY=xyz\n', hash)

    const { mode } = await stat(target)
    expect(mode & 0o777).toBe(0o600) // Was silently becoming 0644 before this guard.
  })

  it('leaves no temp files behind', async () => {
    await host.writeTextFile('jellyfin/compose.yaml', 'services: {}\n', null).catch(() => {})
    const entries = await readdir(join(root, 'jellyfin'))
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/host/local-host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/server/host/local-host.ts`**

```ts
import { createHash } from 'node:crypto'
import { chmod, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Docker from 'dockerode'
import { PathGuard } from './paths.js'
import { HashMismatchError } from './types.js'
import type { ContainerSummary, DiscoveredDir, FileRead, Host } from './types.js'

const COMPOSE_FILENAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export class LocalHost implements Host {
  private readonly guard: PathGuard
  private readonly docker: Docker

  constructor(
    readonly id: string,
    private readonly composeRoot: string,
    dockerSocket: string,
  ) {
    this.guard = new PathGuard(composeRoot)
    this.docker = new Docker({ socketPath: dockerSocket })
  }

  async init(): Promise<void> {
    await this.guard.init()
  }

  async listAppDirectories(): Promise<DiscoveredDir[]> {
    const entries = await readdir(this.composeRoot, { withFileTypes: true })
    const found: DiscoveredDir[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      for (const candidate of COMPOSE_FILENAMES) {
        try {
          await stat(join(this.composeRoot, entry.name, candidate))
          found.push({ directory: entry.name, composeFile: candidate })
          break
        } catch {
          // Try the next candidate filename.
        }
      }
    }
    return found.sort((a, b) => a.directory.localeCompare(b.directory))
  }

  async readTextFile(rel: string): Promise<FileRead> {
    const abs = await this.guard.resolveExisting(rel)
    const content = await readFile(abs, 'utf8')
    return { content, hash: hashContent(content) }
  }

  async writeTextFile(
    rel: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }> {
    const abs = await this.guard.resolveForWrite(rel)

    let currentHash: string | null = null
    try {
      currentHash = hashContent(await readFile(abs, 'utf8'))
    } catch {
      currentHash = null
    }

    if (currentHash !== expectedHash) {
      throw new HashMismatchError(expectedHash, currentHash ?? '<absent>')
    }

    // Write to a sibling temp file and rename. Two reasons: a crash cannot truncate the
    // original, and `rename` REPLACES a symlink at the destination rather than following
    // it — so even if a symlink is planted between PathGuard's check and this write
    // (a TOCTOU race), the write lands inside the root. Never `writeFile` to `abs`
    // directly; that call follows symlinks.
    //
    // The temp file's mode becomes the destination's mode after rename, so it must be
    // chosen deliberately. `.env` files hold database passwords and API keys, and the
    // compose root is an SMB share. Defaulting to the umask (0644 here) would publish
    // new secrets to every local user AND silently downgrade a file the user had
    // already chmod'ed to 0600.
    const mode = await stat(abs)
      .then((s) => s.mode & 0o777)
      .catch(() => 0o600) // New file: owner-only. Callers may relax it afterwards.

    const temp = join(dirname(abs), `.homestead-${process.pid}-${Date.now()}.tmp`)
    // 'wx' fails if the path exists, so a pre-created file with a permissive mode
    // cannot be reused. Mode is applied at creation, then forced with chmod because
    // the process umask can strip bits from the requested mode.
    await writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' })
    await chmod(temp, mode)
    await rename(temp, abs)
    return { hash: hashContent(content) }
  }

  async listContainers(filters?: { project?: string }): Promise<ContainerSummary[]> {
    const label = filters?.project
      ? [`com.docker.compose.project=${filters.project}`]
      : undefined
    const raw = await this.docker.listContainers({
      all: true,
      filters: label ? { label } : undefined,
    })
    return raw.map((c) => ({
      id: c.Id,
      names: (c.Names ?? []).map((n) => n.replace(/^\//, '')),
      image: c.Image,
      state: c.State,
      status: c.Status,
      project: c.Labels?.['com.docker.compose.project'] ?? null,
      service: c.Labels?.['com.docker.compose.service'] ?? null,
      labels: c.Labels ?? {},
    }))
  }

  async inspectContainer(id: string): Promise<unknown> {
    return this.docker.getContainer(id).inspect()
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/host/local-host.test.ts`
Expected: PASS, 8 tests. These tests never touch Docker.

- [ ] **Step 6: Add a Docker integration test, skipped when no daemon is present**

Append to the test file:

```ts
import Docker from 'dockerode'

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker({ socketPath: '/var/run/docker.sock' }).ping()
    return true
  } catch {
    return false
  }
}

describe.skipIf(!(await dockerAvailable()))('LocalHost docker reads', () => {
  it('lists containers and surfaces compose labels', async () => {
    const containers = await host.listContainers()
    expect(Array.isArray(containers)).toBe(true)
    for (const c of containers) {
      expect(typeof c.id).toBe('string')
      expect(c.project === null || typeof c.project === 'string').toBe(true)
    }
  })

  it('filters by compose project without error', async () => {
    await expect(host.listContainers({ project: 'definitely-not-a-real-project' }))
      .resolves.toEqual([])
  })
})
```

Run: `pnpm vitest run src/server/host/local-host.test.ts`
Expected: PASS. On a machine with Docker, 10 tests; without, 8 plus 2 skipped.

- [ ] **Step 7: Commit**

```bash
git add src/server/host
git commit -m "feat: add Host interface and LocalHost with hash-guarded writes"
```

---

### Task 7: Mount preflight

**Files:**
- Create: `src/server/host/preflight.ts`
- Test: `src/server/host/preflight.test.ts`

**Interfaces:**
- Consumes: `Config`
- Produces: `runMountPreflight(opts: { composeRoot: string; dockerSocket: string; image?: string }): Promise<PreflightResult>` where `PreflightResult = { ok: true } | { ok: false; reason: string }`; `class PreflightError extends Error`

A bind source that does not exist on the host is **not an error** — Docker creates an empty directory. So a wrong mount produces stacks that start successfully with blank volumes. This check writes a marker inside the compose root, has the daemon bind that same path into a throwaway container, and reads the marker back.

- [ ] **Step 1: Write the failing test**

`src/server/host/preflight.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { describe, expect, it } from 'vitest'
import { runMountPreflight } from '@server/host/preflight'

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker({ socketPath: '/var/run/docker.sock' }).ping()
    return true
  } catch {
    return false
  }
}

const hasDocker = await dockerAvailable()

describe.skipIf(!hasDocker)('runMountPreflight', () => {
  it('passes when the compose root is visible to the daemon at the same path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hs-preflight-'))
    try {
      const result = await runMountPreflight({ composeRoot: root, dockerSocket: '/var/run/docker.sock' })
      expect(result).toEqual({ ok: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  // NOTE ON COVERAGE: the branch this whole check exists for — the compose root being
  // writable here but resolving to a different directory on the host — cannot be
  // exercised from a test process that IS the host. It is reachable only when Homestead
  // runs containerised with a mismatched bind mount. The tests below cover the two
  // failure branches that ARE reachable. Do not read green tests as proof that the
  // path-mismatch detection works; that is verified by deploying.
  it('fails when the compose root cannot be written to at all', async () => {
    const result = await runMountPreflight({
      composeRoot: '/definitely/not/mounted/anywhere',
      dockerSocket: '/var/run/docker.sock',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/marker/i)
  }, 60_000)

  it('removes the marker directory even when writing the marker fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hs-preflight-leak-'))
    const markerDir = join(root, '.homestead-preflight')
    try {
      // Pre-create it read-only: mkdir(recursive) succeeds, writeFile fails.
      await mkdir(markerDir)
      await chmod(markerDir, 0o500)

      const result = await runMountPreflight({ composeRoot: root, dockerSocket: '/var/run/docker.sock' })

      expect(result.ok).toBe(false)
      await expect(readdir(root)).resolves.not.toContain('.homestead-preflight')
    } finally {
      await chmod(markerDir, 0o700).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('returns a failure rather than throwing when the Docker socket is unreachable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hs-preflight-sock-'))
    try {
      const result = await runMountPreflight({
        composeRoot: root,
        dockerSocket: '/var/run/definitely-not-a-socket.sock',
      })
      expect(result.ok).toBe(false)
      await expect(readdir(root)).resolves.toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/host/preflight.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/host/preflight.ts`**

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Docker from 'dockerode'

export type PreflightResult = { ok: true } | { ok: false; reason: string }

export class PreflightError extends Error {
  constructor(reason: string) {
    super(
      `Compose root mount preflight failed: ${reason}\n\n` +
        'The compose root must be bind-mounted into this container at the SAME absolute path ' +
        'it has on the host. Docker resolves each stack\'s bind mounts against the host ' +
        'filesystem, and a host-invalid source is silently created as an empty directory — ' +
        'so stacks would start with blank config and data volumes.\n' +
        'Set HOMESTEAD_SKIP_MOUNT_PREFLIGHT=true only for development or CI.',
    )
    this.name = 'PreflightError'
  }
}

const DEFAULT_IMAGE = 'alpine:3'

async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch {
    // Not present locally; pull it.
  }
  const stream = await docker.pull(image)
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()))
  })
}

export async function runMountPreflight(opts: {
  composeRoot: string
  dockerSocket: string
  image?: string
}): Promise<PreflightResult> {
  const image = opts.image ?? DEFAULT_IMAGE
  const docker = new Docker({ socketPath: opts.dockerSocket })
  const markerDir = join(opts.composeRoot, '.homestead-preflight')
  const markerName = `${randomUUID()}.marker`
  const token = randomUUID()

  // One try/finally around EVERYTHING that can create the marker directory, so no
  // early return can skip its removal. An earlier version returned from the write
  // failure before entering the block whose `finally` did the cleanup, leaking
  // `.homestead-preflight` into the user's compose root.
  try {
    try {
      await mkdir(markerDir, { recursive: true })
      await writeFile(join(markerDir, markerName), token, 'utf8')
    } catch (error) {
      return {
        ok: false,
        reason: `cannot write a marker into ${opts.composeRoot}: ${String(error)}`,
      }
    }

    await ensureImage(docker, image)

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['cat', `/mnt/preflight/.homestead-preflight/${markerName}`],
      HostConfig: {
        Binds: [`${opts.composeRoot}:/mnt/preflight:ro`],
        AutoRemove: false,
      },
    })

    try {
      const logs = await container.attach({ stream: true, stdout: true, stderr: true })
      const chunks: Buffer[] = []

      // `container.wait()` resolving means the container exited, NOT that every
      // 'data' event has fired. Reading the buffer immediately can miss the tail and
      // report a healthy mount as broken — a false negative that refuses to boot.
      const streamDrained = new Promise<void>((resolveDrained) => {
        logs.on('data', (chunk: Buffer) => chunks.push(chunk))
        logs.on('end', resolveDrained)
        logs.on('close', resolveDrained)
        logs.on('error', resolveDrained)
      })

      await container.start()
      await container.wait()

      const drainTimeout = new Promise<void>((resolveTimeout) => {
        setTimeout(resolveTimeout, 2000).unref()
      })
      await Promise.race([streamDrained, drainTimeout])

      // Strip Docker's 8-byte stream multiplexing headers.
      const output = demultiplex(Buffer.concat(chunks))

      if (!output.includes(token)) {
        return {
          ok: false,
          reason:
            `the marker file was not visible to the Docker daemon at ${opts.composeRoot}. ` +
            'The daemon saw an empty or different directory at that path.',
        }
      }
      return { ok: true }
    } finally {
      await container.remove({ force: true }).catch(() => {})
    }
  } catch (error) {
    return { ok: false, reason: `could not run the marker check: ${String(error)}` }
  } finally {
    await rm(markerDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Docker frames non-TTY output as [type, 0, 0, 0, len32be, ...payload].
 *
 * The header is validated rather than assumed: in TTY mode output is unframed, and
 * unframed bytes whose first eight happen to parse as a header would otherwise have
 * their first eight bytes silently eaten. Validating type and padding makes the
 * "is this framed?" question answerable instead of guessed.
 */
function looksLikeFrameHeader(buffer: Buffer, offset: number): boolean {
  const streamType = buffer[offset]
  if (streamType === undefined || streamType > 2) return false
  if (buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) return false
  return offset + 8 + buffer.readUInt32BE(offset + 4) <= buffer.length
}

function demultiplex(buffer: Buffer): string {
  if (buffer.length < 8 || !looksLikeFrameHeader(buffer, 0)) return buffer.toString('utf8')

  let offset = 0
  const parts: string[] = []
  while (offset + 8 <= buffer.length && looksLikeFrameHeader(buffer, offset)) {
    const length = buffer.readUInt32BE(offset + 4)
    parts.push(buffer.subarray(offset + 8, offset + 8 + length).toString('utf8'))
    offset += 8 + length
  }
  // Trailing bytes that are not a valid frame belong to the payload.
  if (offset < buffer.length) parts.push(buffer.subarray(offset).toString('utf8'))
  return parts.join('')
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/host/preflight.test.ts`
Expected: PASS on a machine with Docker (2 tests, may take ~30s on first run while `alpine:3` is pulled); skipped otherwise.

- [ ] **Step 5: Commit**

```bash
git add src/server/host/preflight.ts src/server/host/preflight.test.ts
git commit -m "feat: add Docker mount preflight to catch silent empty-volume misconfiguration"
```

---

### Task 8: Fastify application skeleton

**Files:**
- Create: `src/server/app.ts`, `src/server/routes/health.ts`, `src/server/index.ts`
- Test: `src/server/routes/health.test.ts`

**Interfaces:**
- Consumes: `Config`, `Db`, `Host`, `SecretStore`
- Produces: `buildApp(deps: AppDeps): Promise<FastifyInstance>` where

```ts
export type AppDeps = { config: Config; db: Db; host: Host; secrets: SecretStore }
```

and Fastify is decorated with `app.deps: AppDeps`.

- [ ] **Step 1: Write the failing test**

`src/server/routes/health.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '@server/test-helpers'

describe('GET /api/health', () => {
  it('reports ok with a version', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
    await app.close()
  })

  it('returns a JSON 404 for an unknown API route', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
    await app.close()
  })
})
```

- [ ] **Step 2: Write `src/server/test-helpers.ts`**

```ts
import { loadConfig } from './config.js'
import { createDb, runMigrations } from './db/client.js'
import { SecretStore } from './crypto/secrets.js'
import { buildApp } from './app.js'
import type { Host, ContainerSummary, DiscoveredDir, FileRead } from './host/types.js'

export class FakeHost implements Host {
  readonly id = 'test'
  files = new Map<string, string>()
  containers: ContainerSummary[] = []

  async listAppDirectories(): Promise<DiscoveredDir[]> {
    return []
  }
  async readTextFile(rel: string): Promise<FileRead> {
    const content = this.files.get(rel)
    if (content === undefined) throw new Error(`no such file: ${rel}`)
    const { hashContent } = await import('./host/local-host.js')
    return { content, hash: hashContent(content) }
  }
  async writeTextFile(rel: string, content: string): Promise<{ hash: string }> {
    this.files.set(rel, content)
    const { hashContent } = await import('./host/local-host.js')
    return { hash: hashContent(content) }
  }
  async listContainers(): Promise<ContainerSummary[]> {
    return this.containers
  }
  async inspectContainer(): Promise<unknown> {
    return {}
  }
}

export async function buildTestApp() {
  const config = loadConfig({
    HOMESTEAD_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
    HOMESTEAD_BASE_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  })
  const { db } = await createDb(':memory:')
  await runMigrations(db)
  const secrets = new SecretStore(db, config.secretKey)
  const host = new FakeHost()
  return buildApp({ config, db, host, secrets })
}
```

- [ ] **Step 3: Write `src/server/routes/health.ts`**

```ts
import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    status: 'ok',
    version: process.env.npm_package_version ?? '0.0.0',
  }))
}
```

- [ ] **Step 4: Write `src/server/app.ts`**

```ts
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.js'
import type { SecretStore } from './crypto/secrets.js'
import type { Db } from './db/client.js'
import type { Host } from './host/types.js'
import { healthRoutes } from './routes/health.js'

export type AppDeps = { config: Config; db: Db; host: Host; secrets: SecretStore }

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.nodeEnv !== 'test',
    // NEVER `trustProxy: true`. That believes X-Forwarded-For from any peer, and
    // Homestead is reachable on the LAN by design — so any LAN client could forge
    // `request.ip`, poisoning audit records and defeating IP-keyed rate limiting by
    // rotating the header. Trust only the tunnel's own origin: cloudflared runs with
    // network_mode: host and reaches Homestead over loopback, while LAN clients
    // connect from a LAN address and are therefore not believed.
    trustProxy: deps.config.trustedProxies,
  })

  app.decorate('deps', deps)

  await app.register(cookie)
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Explicit so the trust boundary is visible at the point it matters. `request.ip`
    // is only meaningful because trustProxy is narrowed above.
    keyGenerator: (request) => request.ip,
  })

  await app.register(healthRoutes)

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', path: request.url })
    }
    return reply.code(404).send({ error: 'not_found' })
  })

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, 'request failed')
    const status = error.statusCode ?? 500
    return reply.code(status).send({
      error: status === 500 ? 'internal_error' : error.name,
      message: status === 500 ? 'Internal server error' : error.message,
    })
  })

  return app
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/routes/health.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Write `src/server/index.ts`**

```ts
import { loadConfig } from './config.js'
import { createDb, runMigrations } from './db/client.js'
import { SecretStore } from './crypto/secrets.js'
import { LocalHost } from './host/local-host.js'
import { PreflightError, runMountPreflight } from './host/preflight.js'
import { buildApp } from './app.js'

const config = loadConfig(process.env)

if (!config.skipMountPreflight) {
  const result = await runMountPreflight({
    composeRoot: config.composeRoot,
    dockerSocket: config.dockerSocket,
  })
  if (!result.ok) throw new PreflightError(result.reason)
}

const { db } = await createDb(config.dbPath)
await runMigrations(db)

const host = new LocalHost('local', config.composeRoot, config.dockerSocket)
await host.init()

const app = await buildApp({
  config,
  db,
  host,
  secrets: new SecretStore(db, config.secretKey),
})

await app.listen({ port: config.port, host: '0.0.0.0' })
```

- [ ] **Step 7: Commit**

```bash
git add src/server/app.ts src/server/index.ts src/server/routes src/server/test-helpers.ts
git commit -m "feat: add Fastify application skeleton with preflight-gated startup"
```

---

### Task 9: Better-Auth with server-owned roles

**Files:**
- Create: `src/server/auth/auth.ts`
- Modify: `src/server/app.ts` (register the auth handler)
- Test: `src/server/auth/auth.test.ts`

**Interfaces:**
- Consumes: `Config`, `Db`
- Produces: `createAuth(config: Config, db: Db)` returning the Better-Auth instance; mounted at `/api/auth/*`

- [ ] **Step 1: Confirm the installed Better-Auth API surface**

Run: `pnpm why better-auth && ls node_modules/better-auth/dist`

Read `node_modules/better-auth/dist/index.d.ts` for `betterAuth`, and the `drizzleAdapter` export path. The code below targets the current major; if an export path differs, adapt it and note the difference in your commit message rather than changing the intent.

- [ ] **Step 2: Write the failing test**

`src/server/auth/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '@server/test-helpers'
import { users } from '@server/db/schema'

describe('authentication', () => {
  it('signs a user up and issues a session cookie', async () => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'ada@example.com', password: 'correct-horse-battery', name: 'Ada' },
    })
    expect(res.statusCode).toBeLessThan(400)
    expect(res.headers['set-cookie']).toBeDefined()
    await app.close()
  })

  it('ignores a role supplied in the sign-up body', async () => {
    const app = await buildTestApp()
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        email: 'mallory@example.com',
        password: 'correct-horse-battery',
        name: 'Mallory',
        role: 'admin',
      },
    })
    const [row] = await app.deps.db.select().from(users)
    expect(row?.role).toBe('viewer')
    await app.close()
  })

  it('rejects a wrong password', async () => {
    const app = await buildTestApp()
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'ada@example.com', password: 'correct-horse-battery', name: 'Ada' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'ada@example.com', password: 'wrong' },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    await app.close()
  })

  it('does not mark cookies Secure when the base URL is plain HTTP', async () => {
    const app = await buildTestApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'lan@example.com', password: 'correct-horse-battery', name: 'Lan' },
    })
    const cookies = String(res.headers['set-cookie'])
    expect(cookies.toLowerCase()).not.toContain('secure')
    await app.close()
  })
})
```

The last test is the LAN-access guard: browsers do not send `Secure` cookies over plain HTTP to a LAN address, so forcing the flag would make internal logins fail silently.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/auth/auth.test.ts`
Expected: FAIL — `/api/auth/*` is not mounted.

- [ ] **Step 4: Write `src/server/auth/auth.ts`**

```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { accounts, sessions, users, verifications } from '../db/schema.js'

export function createAuth(config: Config, db: Db) {
  return betterAuth({
    baseURL: config.baseUrl,
    secret: config.secretKey.toString('base64'),
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    user: {
      additionalFields: {
        // Server-owned. `input: false` prevents a request body from setting these.
        role: { type: 'string', required: false, defaultValue: 'viewer', input: false },
        scopeAllApps: { type: 'boolean', required: false, defaultValue: true, input: false },
        disabledAt: { type: 'number', required: false, input: false },
      },
    },
    advanced: {
      // Do NOT force useSecureCookies. Homestead is reachable over plain HTTP on
      // the LAN by design, and browsers withhold Secure cookies from such origins.
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
        // Better-Auth reads these headers itself, independently of Fastify's
        // trustProxy. Without a trusted-proxy list it would believe them from any
        // peer, re-opening inside auth exactly the forgery that narrowing Fastify's
        // trustProxy closes — and auth is where a forged IP does the most damage,
        // since it keys rate limiting on login.
        trustedProxies: config.trustedProxies,
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
```

- [ ] **Step 5: Mount the auth handler in `src/server/app.ts`**

Add to `AppDeps`:

```ts
export type AppDeps = {
  config: Config; db: Db; host: Host; secrets: SecretStore; auth: Auth
}
```

Register before `healthRoutes`:

```ts
app.route({
  method: ['GET', 'POST'],
  url: '/api/auth/*',
  async handler(request, reply) {
    const url = new URL(request.url, deps.config.baseUrl)
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value)
      else if (Array.isArray(value)) headers.set(key, value.join(','))
    }
    const response = await deps.auth.handler(
      new Request(url, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : JSON.stringify(request.body),
      }),
    )
    reply.status(response.status)
    response.headers.forEach((value, key) => reply.header(key, value))
    return reply.send(response.body ? await response.text() : null)
  },
})
```

Add `auth: createAuth(config, db)` to the deps constructed in `test-helpers.ts` and `index.ts`.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/auth/auth.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/auth src/server/app.ts src/server/test-helpers.ts src/server/index.ts
git commit -m "feat: add Better-Auth with server-owned role and scope fields"
```

---

### Task 10: Dormant Cloudflare Access plugin

**Files:**
- Create: `src/server/auth/access-plugin.ts`
- Modify: `src/server/auth/auth.ts`
- Test: `src/server/auth/access-plugin.test.ts`

**Interfaces:**
- Consumes: `Config`
- Produces: `verifyAccessJwt(opts: { token: string; teamDomain: string; aud: string; fetchJwks?: JwksFetcher }): Promise<{ email: string }>` and `accessSignInPlugin(config: Config)`

The audience check is the security core. Homestead's purpose is running many Access applications in one Cloudflare account, all issuing tokens signed by the same team keys with the same issuer. A user allowed into Jellyfin holds a genuinely valid token; without `aud` verification they could present it here.

- [ ] **Step 1: Write the failing test**

`src/server/auth/access-plugin.test.ts`:

```ts
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { verifyAccessJwt } from '@server/auth/access-plugin'

const TEAM = 'acme'
const ISSUER = `https://${TEAM}.cloudflareaccess.com`
const AUD = 'homestead-aud-tag'

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'key-1', alg: 'RS256' }
  const fetchJwks = async () => ({ keys: [jwk] })

  const mint = (over: Record<string, unknown> = {}) =>
    new SignJWT({ email: 'ada@example.com', ...over })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(String(over.iss ?? ISSUER))
      .setAudience((over.aud as string) ?? AUD)
      .setIssuedAt()
      .setExpirationTime(over.exp ? Number(over.exp) : '1h')
      .sign(privateKey)

  return { fetchJwks, mint, privateKey }
}

describe('verifyAccessJwt', () => {
  it('accepts a correctly signed token for this application', async () => {
    const { fetchJwks, mint } = await setup()
    const result = await verifyAccessJwt({
      token: await mint(), teamDomain: TEAM, aud: AUD, fetchJwks,
    })
    expect(result.email).toBe('ada@example.com')
  })

  it('rejects a valid token minted for a DIFFERENT Access application', async () => {
    const { fetchJwks, mint } = await setup()
    await expect(
      verifyAccessJwt({
        token: await mint({ aud: 'jellyfin-aud-tag' }), teamDomain: TEAM, aud: AUD, fetchJwks,
      }),
    ).rejects.toThrow()
  })

  it('rejects a token from a different issuer', async () => {
    const { fetchJwks, mint } = await setup()
    await expect(
      verifyAccessJwt({
        token: await mint({ iss: 'https://evil.cloudflareaccess.com' }),
        teamDomain: TEAM, aud: AUD, fetchJwks,
      }),
    ).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const { fetchJwks, mint } = await setup()
    const past = Math.floor(Date.now() / 1000) - 60
    await expect(
      verifyAccessJwt({ token: await mint({ exp: past }), teamDomain: TEAM, aud: AUD, fetchJwks }),
    ).rejects.toThrow()
  })

  it('rejects a token signed by an unknown key', async () => {
    const { fetchJwks } = await setup()
    const other = await generateKeyPair('RS256')
    const forged = await new SignJWT({ email: 'mallory@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(ISSUER).setAudience(AUD).setIssuedAt().setExpirationTime('1h')
      .sign(other.privateKey)
    await expect(
      verifyAccessJwt({ token: forged, teamDomain: TEAM, aud: AUD, fetchJwks }),
    ).rejects.toThrow()
  })

  it('rejects a garbage token', async () => {
    const { fetchJwks } = await setup()
    await expect(
      verifyAccessJwt({ token: 'not.a.jwt', teamDomain: TEAM, aud: AUD, fetchJwks }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/auth/access-plugin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/auth/access-plugin.ts`**

```ts
import { type JWK, createLocalJWKSet, jwtVerify } from 'jose'
import type { Config } from '../config.js'

export type JwksFetcher = () => Promise<{ keys: JWK[] }>

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'

function defaultFetcher(teamDomain: string): JwksFetcher {
  return async () => {
    const res = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`)
    if (!res.ok) throw new Error(`Failed to fetch Access JWKS: ${res.status}`)
    return (await res.json()) as { keys: JWK[] }
  }
}

const jwksCache = new Map<string, { keys: JWK[]; fetchedAt: number }>()
const JWKS_TTL_MS = 60 * 60 * 1000

/**
 * Verifies a Cloudflare Access JWT.
 *
 * The `aud` check is not optional. Every Access application in an account is
 * signed by the same team keys with the same issuer, so signature validity alone
 * proves only that the bearer may access *something* in this account.
 */
export async function verifyAccessJwt(opts: {
  token: string
  teamDomain: string
  aud: string
  fetchJwks?: JwksFetcher
}): Promise<{ email: string }> {
  const fetcher = opts.fetchJwks ?? defaultFetcher(opts.teamDomain)

  const cached = jwksCache.get(opts.teamDomain)
  const fresh =
    cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS ? cached : { keys: (await fetcher()).keys, fetchedAt: Date.now() }
  jwksCache.set(opts.teamDomain, fresh)

  const verify = async (keys: JWK[]) =>
    jwtVerify(opts.token, createLocalJWKSet({ keys }), {
      issuer: `https://${opts.teamDomain}.cloudflareaccess.com`,
      audience: opts.aud,
    })

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    payload = (await verify(fresh.keys)).payload
  } catch {
    // An unknown `kid` may mean Cloudflare rotated keys. Refetch once.
    const refreshed = { keys: (await fetcher()).keys, fetchedAt: Date.now() }
    jwksCache.set(opts.teamDomain, refreshed)
    payload = (await verify(refreshed.keys)).payload
  }

  const email = payload.email
  if (typeof email !== 'string' || email === '') {
    throw new Error('Access token carries no email claim')
  }
  return { email }
}

/** True only when both configuration values are present. */
export function isAccessEnabled(config: Config): boolean {
  return config.accessEnabled
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/auth/access-plugin.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the dormancy test**

Append:

```ts
import { isAccessEnabled } from '@server/auth/access-plugin'
import { loadConfig } from '@server/config'

const base = {
  HOMESTEAD_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  HOMESTEAD_BASE_URL: 'http://localhost:3000',
}

describe('dormancy', () => {
  it('is disabled with no Access configuration', () => {
    expect(isAccessEnabled(loadConfig({ ...base }))).toBe(false)
  })

  it('is disabled with only one of the two values', () => {
    expect(isAccessEnabled(loadConfig({ ...base, HOMESTEAD_ACCESS_AUD: 'x' }))).toBe(false)
  })

  it('is enabled with both', () => {
    expect(
      isAccessEnabled(
        loadConfig({ ...base, HOMESTEAD_ACCESS_AUD: 'x', HOMESTEAD_ACCESS_TEAM_DOMAIN: 'acme' }),
      ),
    ).toBe(true)
  })
})
```

Run: `pnpm vitest run src/server/auth/access-plugin.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/auth/access-plugin.ts src/server/auth/access-plugin.test.ts
git commit -m "feat: add Cloudflare Access JWT verification, dormant until configured"
```

---

### Task 11: AuthContext, capabilities, and the scope predicate

**Files:**
- Create: `src/shared/capabilities.ts`, `src/server/auth/context.ts`
- Test: `src/server/auth/context.test.ts`

**Interfaces:**
- Consumes: `Auth`, `Db`
- Produces:

```ts
export type AuthContext = {
  userId: string; email: string; role: Role; scopeAllApps: boolean; appIds: string[]
  authPath: 'password' | 'access'
}
export function can(ctx: AuthContext, capability: Capability): boolean
export function canForApp(ctx: AuthContext, capability: Capability, appId: string): boolean
export function visibleAppsWhere(ctx: AuthContext): SQL | undefined
export function requireAuth(request): AuthContext   // throws 401
export function requireAdmin(request): AuthContext  // throws 403
```

- [ ] **Step 1: Write `src/shared/capabilities.ts`**

```ts
import type { Role } from './types.js'

export const CAPABILITIES = [
  'app:read',
  'app:config',
  'app:lifecycle',
  'app:secrets',
  'cf:write',
  'user:manage',
] as const
export type Capability = (typeof CAPABILITIES)[number]

const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  admin: CAPABILITIES,
  // Viewers see status and health only. No config, no secrets, no logs, no actions.
  viewer: ['app:read'],
}

export function roleHas(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability)
}
```

- [ ] **Step 2: Write the failing test**

`src/server/auth/context.test.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { canForApp, can, visibleAppsWhere } from '@server/auth/context'
import type { AuthContext } from '@server/auth/context'
import { createDb, runMigrations } from '@server/db/client'
import { apps, hosts } from '@server/db/schema'

const admin: AuthContext = {
  userId: 'u1', email: 'a@x', role: 'admin', scopeAllApps: true, appIds: [], authPath: 'password',
}
const viewerAll: AuthContext = { ...admin, userId: 'u2', role: 'viewer' }
const viewerScoped: AuthContext = {
  ...viewerAll, userId: 'u3', scopeAllApps: false, appIds: ['app-a'],
}

describe('capabilities', () => {
  it('grants admins every capability', () => {
    expect(can(admin, 'app:config')).toBe(true)
    expect(can(admin, 'user:manage')).toBe(true)
  })

  it('limits viewers to reading', () => {
    expect(can(viewerAll, 'app:read')).toBe(true)
    expect(can(viewerAll, 'app:config')).toBe(false)
    expect(can(viewerAll, 'app:lifecycle')).toBe(false)
    expect(can(viewerAll, 'app:secrets')).toBe(false)
  })

  it('denies a scoped viewer an app outside their scope', () => {
    expect(canForApp(viewerScoped, 'app:read', 'app-a')).toBe(true)
    expect(canForApp(viewerScoped, 'app:read', 'app-b')).toBe(false)
  })

  it('grants an all-scope viewer every app', () => {
    expect(canForApp(viewerAll, 'app:read', 'anything')).toBe(true)
  })
})

describe('visibleAppsWhere', () => {
  async function seed() {
    const { db } = await createDb(':memory:')
    await runMigrations(db)
    const hostId = ulid()
    await db.insert(hosts).values({
      id: hostId, name: 'local', composeRoot: '/x', dockerSocket: '/y',
    })
    for (const slug of ['a', 'b', 'c']) {
      await db.insert(apps).values({
        id: `app-${slug}`, hostId, slug, displayName: slug,
        directory: slug, composeFile: 'compose.yaml', projectName: slug,
      })
    }
    return db
  }

  it('returns every app for an all-scope user', async () => {
    const db = await seed()
    const rows = await db.select().from(apps).where(visibleAppsWhere(viewerAll))
    expect(rows).toHaveLength(3)
  })

  it('returns only scoped apps for a scoped viewer', async () => {
    const db = await seed()
    const rows = await db.select().from(apps).where(visibleAppsWhere(viewerScoped))
    expect(rows.map((r) => r.id)).toEqual(['app-a'])
  })

  it('returns nothing for a scoped viewer with an empty allowlist', async () => {
    const db = await seed()
    const none: AuthContext = { ...viewerScoped, appIds: [] }
    const rows = await db.select().from(apps).where(visibleAppsWhere(none))
    expect(rows).toHaveLength(0)
  })

  it('composes with other conditions', async () => {
    const db = await seed()
    const rows = await db
      .select()
      .from(apps)
      .where(and(visibleAppsWhere(viewerAll), eq(apps.slug, 'b')))
    expect(rows).toHaveLength(1)
  })
})
```

The empty-allowlist case is the one that matters: `scopeAllApps: false` with no entries must mean **no apps**, not all apps. Conflating them is why `scopeAllApps` is an explicit column.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/auth/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/server/auth/context.ts`**

```ts
import { type SQL, inArray, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { Capability } from '@shared/capabilities'
import { roleHas } from '@shared/capabilities'
import type { Role } from '@shared/types'
import { apps } from '../db/schema.js'

export type AuthContext = {
  userId: string
  email: string
  role: Role
  scopeAllApps: boolean
  appIds: string[]
  authPath: 'password' | 'access'
}

export class UnauthorizedError extends Error {
  statusCode = 401
  constructor() {
    super('Authentication required')
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  statusCode = 403
  constructor(capability: Capability) {
    super(`Missing capability: ${capability}`)
    this.name = 'ForbiddenError'
  }
}

export function can(ctx: AuthContext, capability: Capability): boolean {
  return roleHas(ctx.role, capability)
}

export function inScope(ctx: AuthContext, appId: string): boolean {
  return ctx.scopeAllApps || ctx.appIds.includes(appId)
}

export function canForApp(ctx: AuthContext, capability: Capability, appId: string): boolean {
  return can(ctx, capability) && inScope(ctx, appId)
}

/**
 * The single scope predicate. Every app-reading query composes this, including
 * the SSE fan-out — the path most likely to drift from the REST path.
 */
export function visibleAppsWhere(ctx: AuthContext): SQL | undefined {
  if (ctx.scopeAllApps) return undefined
  if (ctx.appIds.length === 0) return sql`1 = 0`
  return inArray(apps.id, ctx.appIds)
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext
  }
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new UnauthorizedError()
  return request.auth
}

export function requireCapability(request: FastifyRequest, capability: Capability): AuthContext {
  const ctx = requireAuth(request)
  if (!can(ctx, capability)) throw new ForbiddenError(capability)
  return ctx
}

export function requireAdmin(request: FastifyRequest): AuthContext {
  const ctx = requireAuth(request)
  if (ctx.role !== 'admin') throw new ForbiddenError('user:manage')
  return ctx
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/auth/context.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Add the session-resolving preHandler to `src/server/app.ts`**

Register after the auth route, before other routes:

```ts
import { eq } from 'drizzle-orm'
import { userAppScope, users } from './db/schema.js'

app.addHook('preHandler', async (request) => {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value)
  }
  const session = await deps.auth.api.getSession({ headers })
  if (!session?.user) return

  const [row] = await deps.db.select().from(users).where(eq(users.id, session.user.id))
  if (!row || row.disabledAt !== null) return

  const scopeRows = row.scopeAllApps
    ? []
    : await deps.db
        .select({ appId: userAppScope.appId })
        .from(userAppScope)
        .where(eq(userAppScope.userId, row.id))

  request.auth = {
    userId: row.id,
    email: row.email,
    role: row.role,
    scopeAllApps: row.scopeAllApps,
    appIds: scopeRows.map((s) => s.appId),
    authPath: 'password',
  }
})
```

- [ ] **Step 7: Verify the whole suite still passes**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/shared/capabilities.ts src/server/auth/context.ts src/server/auth/context.test.ts src/server/app.ts
git commit -m "feat: add auth context, capability checks, and the app scope predicate"
```

---

### Task 12: Users and scope API, with first-admin bootstrap

**Files:**
- Create: `src/server/routes/users.ts`
- Modify: `src/server/app.ts` (register the routes)
- Test: `src/server/routes/users.test.ts`

**Interfaces:**
- Consumes: `AuthContext` helpers from Task 11
- Produces: `GET /api/setup/status`, `POST /api/setup/admin`, `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id`, `PUT /api/users/:id/scope`, `GET /api/me`

- [ ] **Step 1: Write the failing test**

`src/server/routes/users.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '@server/test-helpers'

async function signUpAdmin(app: Awaited<ReturnType<typeof buildTestApp>>) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/setup/admin',
    payload: { email: 'admin@example.com', password: 'correct-horse-battery', name: 'Admin' },
  })
  const cookie = String(res.headers['set-cookie'] ?? '')
  return { res, cookie }
}

describe('bootstrap', () => {
  it('reports that setup is needed when there are no users', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' })
    expect(res.json()).toMatchObject({ needsSetup: true })
    await app.close()
  })

  it('creates the first user as an admin', async () => {
    const app = await buildTestApp()
    const { res, cookie } = await signUpAdmin(app)
    expect(res.statusCode).toBeLessThan(400)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(me.json()).toMatchObject({ role: 'admin', scopeAllApps: true })
    await app.close()
  })

  it('refuses a second bootstrap attempt', async () => {
    const app = await buildTestApp()
    await signUpAdmin(app)
    const second = await app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { email: 'mallory@example.com', password: 'correct-horse-battery', name: 'M' },
    })
    expect(second.statusCode).toBe(409)
    await app.close()
  })
})

describe('user management', () => {
  it('rejects anonymous listing', async () => {
    const app = await buildTestApp()
    expect((await app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(401)
    await app.close()
  })

  it('lets an admin create a viewer with a scoped app list', async () => {
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: {
        email: 'viewer@example.com', password: 'correct-horse-battery',
        name: 'Viewer', role: 'viewer', scopeAllApps: false,
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ role: 'viewer', scopeAllApps: false })
    await app.close()
  })

  it('forbids a viewer from listing users', async () => {
    const app = await buildTestApp()
    const { cookie: adminCookie } = await signUpAdmin(app)
    await app.inject({
      method: 'POST', url: '/api/users', headers: { cookie: adminCookie },
      payload: {
        email: 'viewer@example.com', password: 'correct-horse-battery',
        name: 'Viewer', role: 'viewer', scopeAllApps: true,
      },
    })
    const signIn = await app.inject({
      method: 'POST', url: '/api/auth/sign-in/email',
      payload: { email: 'viewer@example.com', password: 'correct-horse-battery' },
    })
    const viewerCookie = String(signIn.headers['set-cookie'] ?? '')
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: viewerCookie } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('never returns a password hash', async () => {
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } })
    expect(JSON.stringify(res.json())).not.toMatch(/password|hash/i)
    await app.close()
  })

  it('refuses to remove the last admin', async () => {
    const app = await buildTestApp()
    const { cookie } = await signUpAdmin(app)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    const id = me.json().id
    const res = await app.inject({ method: 'DELETE', url: `/api/users/${id}`, headers: { cookie } })
    expect(res.statusCode).toBe(409)
    await app.close()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run src/server/routes/users.test.ts`
Expected: FAIL — routes are not registered.

- [ ] **Step 3: Write `src/server/routes/users.ts`**

```ts
import { and, eq, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ROLES } from '@shared/types'
import { requireAdmin, requireAuth } from '../auth/context.js'
import { auditLog, userAppScope, users } from '../db/schema.js'
import { ulid } from 'ulid'

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  name: z.string().min(1),
  role: z.enum(ROLES),
  scopeAllApps: z.boolean().default(true),
  appIds: z.array(z.string()).default([]),
})

const publicUser = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  scopeAllApps: users.scopeAllApps,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db, auth } = app.deps

  const countUsers = async () => (await db.select({ id: users.id }).from(users)).length

  async function audit(entry: {
    userId: string | null
    action: string
    targetType?: string
    targetId?: string
    detail?: unknown
    ip?: string
  }) {
    await db.insert(auditLog).values({
      id: ulid(),
      userId: entry.userId,
      authPath: entry.userId ? 'password' : 'system',
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      detail: (entry.detail ?? null) as never,
      ip: entry.ip ?? null,
    })
  }

  app.get('/api/setup/status', async () => ({ needsSetup: (await countUsers()) === 0 }))

  app.post('/api/setup/admin', async (request, reply) => {
    if ((await countUsers()) > 0) {
      return reply.code(409).send({ error: 'already_initialised' })
    }
    const body = createUserSchema
      .pick({ email: true, password: true, name: true })
      .parse(request.body)

    const result = await auth.api.signUpEmail({ body, asResponse: true })
    if (!result.ok) return reply.code(result.status).send(await result.json())

    // Role is server-owned, so promote after creation rather than via the sign-up body.
    await db.update(users).set({ role: 'admin', scopeAllApps: true }).where(eq(users.email, body.email))
    const [row] = await db.select(publicUser).from(users).where(eq(users.email, body.email))
    await audit({ userId: row?.id ?? null, action: 'setup.admin_created', targetType: 'user', targetId: row?.id })

    result.headers.forEach((value, key) => reply.header(key, value))
    return reply.code(201).send(row)
  })

  app.get('/api/me', async (request) => {
    const ctx = requireAuth(request)
    const [row] = await db.select(publicUser).from(users).where(eq(users.id, ctx.userId))
    return { ...row, appIds: ctx.appIds }
  })

  app.get('/api/users', async (request) => {
    requireAdmin(request)
    return db.select(publicUser).from(users)
  })

  app.post('/api/users', async (request, reply) => {
    const ctx = requireAdmin(request)
    const body = createUserSchema.parse(request.body)

    const result = await auth.api.signUpEmail({
      body: { email: body.email, password: body.password, name: body.name },
      asResponse: true,
    })
    if (!result.ok) return reply.code(result.status).send(await result.json())

    await db
      .update(users)
      .set({ role: body.role, scopeAllApps: body.scopeAllApps })
      .where(eq(users.email, body.email))

    const [row] = await db.select(publicUser).from(users).where(eq(users.email, body.email))
    if (row && !body.scopeAllApps && body.appIds.length > 0) {
      await db.insert(userAppScope).values(body.appIds.map((appId) => ({ userId: row.id, appId })))
    }
    await audit({
      userId: ctx.userId, action: 'user.created', targetType: 'user', targetId: row?.id,
      detail: { role: body.role }, ip: request.ip,
    })
    return reply.code(201).send(row)
  })

  app.patch('/api/users/:id', async (request, reply) => {
    const ctx = requireAdmin(request)
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z
      .object({
        name: z.string().min(1).optional(),
        role: z.enum(ROLES).optional(),
        scopeAllApps: z.boolean().optional(),
        disabled: z.boolean().optional(),
      })
      .parse(request.body)

    if (body.role === 'viewer' || body.disabled === true) {
      const admins = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), ne(users.id, id)))
      if (admins.length === 0) return reply.code(409).send({ error: 'last_admin' })
    }

    await db
      .update(users)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.scopeAllApps !== undefined ? { scopeAllApps: body.scopeAllApps } : {}),
        ...(body.disabled !== undefined
          ? { disabledAt: body.disabled ? Math.floor(Date.now() / 1000) : null }
          : {}),
      })
      .where(eq(users.id, id))

    await audit({ userId: ctx.userId, action: 'user.updated', targetType: 'user', targetId: id, detail: body, ip: request.ip })
    const [row] = await db.select(publicUser).from(users).where(eq(users.id, id))
    return row
  })

  app.put('/api/users/:id/scope', async (request) => {
    const ctx = requireAdmin(request)
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const body = z
      .object({ scopeAllApps: z.boolean(), appIds: z.array(z.string()).default([]) })
      .parse(request.body)

    await db.update(users).set({ scopeAllApps: body.scopeAllApps }).where(eq(users.id, id))
    await db.delete(userAppScope).where(eq(userAppScope.userId, id))
    if (!body.scopeAllApps && body.appIds.length > 0) {
      await db.insert(userAppScope).values(body.appIds.map((appId) => ({ userId: id, appId })))
    }
    await audit({ userId: ctx.userId, action: 'user.scope_set', targetType: 'user', targetId: id, detail: body, ip: request.ip })
    return { scopeAllApps: body.scopeAllApps, appIds: body.appIds }
  })

  app.delete('/api/users/:id', async (request, reply) => {
    const ctx = requireAdmin(request)
    const { id } = z.object({ id: z.string() }).parse(request.params)

    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), ne(users.id, id)))
    if (admins.length === 0) return reply.code(409).send({ error: 'last_admin' })

    await db.delete(users).where(eq(users.id, id))
    await audit({ userId: ctx.userId, action: 'user.deleted', targetType: 'user', targetId: id, ip: request.ip })
    return reply.code(204).send()
  })
}
```

- [ ] **Step 4: Register the routes in `src/server/app.ts`**

```ts
import { userRoutes } from './routes/users.js'
// after healthRoutes:
await app.register(userRoutes)
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run src/server/routes/users.test.ts`
Expected: PASS, 8 tests. If `auth.api.signUpEmail` has a different shape in the installed version, adapt the call while keeping behaviour identical — role must still be assigned server-side after creation, never from the request body.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/users.ts src/server/routes/users.test.ts src/server/app.ts
git commit -m "feat: add user management API with first-admin bootstrap and last-admin protection"
```

---

### Task 13: Web shell — Vite, Tailwind, router, login

**Files:**
- Create: `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `index.html`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/index.css`, `src/web/api/client.ts`, `src/web/auth/useSession.ts`, `src/web/routes/Login.tsx`, `src/web/routes/Shell.tsx`, `src/web/routes/Placeholder.tsx`, `src/server/routes/spa.ts`
- Modify: `src/server/app.ts`
- Test: `src/web/api/client.test.ts`

**Interfaces:**
- Consumes: the API from Tasks 8–12
- Produces: a served SPA with `/login`, `/` (launcher placeholder), `/apps` (admin placeholder), guarded by session state

- [ ] **Step 1: Install web dependencies**

```bash
pnpm add react react-dom react-router-dom @tanstack/react-query
pnpm add -D @vitejs/plugin-react vite tailwindcss @tailwindcss/vite \
  @types/react @types/react-dom jsdom @testing-library/react concurrently
```

- [ ] **Step 2: Write `vite.config.ts`**

```ts
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  build: { outDir: 'dist/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
})
```

Tailwind v4 is configured through the Vite plugin and a CSS `@import`; there is no `tailwind.config.ts` unless you need to extend the theme. Skip creating `tailwind.config.ts` and `postcss.config.js` if `@tailwindcss/vite` is installed.

- [ ] **Step 3: Write `index.html` and `src/web/index.css`**

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>Homestead</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

`src/web/index.css`:

```css
@import "tailwindcss";

:root { color-scheme: light dark; }

body {
  @apply bg-white text-slate-900 antialiased;
}

@media (prefers-color-scheme: dark) {
  body { @apply bg-slate-950 text-slate-100; }
}
```

- [ ] **Step 4: Write the failing test**

`src/web/api/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from '@web/api/client'

describe('apiFetch', () => {
  it('returns parsed JSON on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    await expect(apiFetch('/api/health')).resolves.toEqual({ ok: 1 })
  })

  it('throws ApiError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    })))
    await expect(apiFetch('/api/users')).rejects.toBeInstanceOf(ApiError)
    await expect(apiFetch('/api/users')).rejects.toMatchObject({ status: 403 })
  })

  it('returns null for 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await expect(apiFetch('/api/users/x')).resolves.toBeNull()
  })
})
```

- [ ] **Step 5: Run the test and confirm it fails**

Run: `pnpm vitest run src/web/api/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Write `src/web/api/client.ts`**

```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API request failed with ${status}`)
    this.name = 'ApiError'
  }
}

export async function apiFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (response.status === 204) return null as T

  const isJson = response.headers.get('content-type')?.includes('application/json')
  const body = isJson ? await response.json() : await response.text()

  if (!response.ok) throw new ApiError(response.status, body)
  return body as T
}
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm vitest run src/web/api/client.test.ts`
Expected: PASS, 3 tests. Add `environment: 'jsdom'` per-file via `// @vitest-environment jsdom` at the top if `Response` is unavailable in the node environment.

- [ ] **Step 8: Write `src/web/auth/useSession.ts`**

```ts
import { useQuery } from '@tanstack/react-query'
import type { Role } from '@shared/types'
import { ApiError, apiFetch } from '@web/api/client'

export type Me = {
  id: string
  email: string
  name: string
  role: Role
  scopeAllApps: boolean
  appIds: string[]
}

export function useSession() {
  return useQuery({
    queryKey: ['me'],
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await apiFetch<Me>('/api/me')
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      }
    },
  })
}

export function useSetupStatus() {
  return useQuery({
    queryKey: ['setup-status'],
    queryFn: () => apiFetch<{ needsSetup: boolean }>('/api/setup/status'),
  })
}
```

- [ ] **Step 9: Write the route components**

`src/web/routes/Login.tsx`:

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { apiFetch } from '@web/api/client'
import { useSetupStatus } from '@web/auth/useSession'

export function Login() {
  const setup = useSetupStatus()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const needsSetup = setup.data?.needsSetup === true

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (needsSetup) {
        await apiFetch('/api/setup/admin', {
          method: 'POST',
          body: JSON.stringify({ email, password, name }),
        })
      } else {
        await apiFetch('/api/auth/sign-in/email', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        })
      }
      await queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch {
      setError(needsSetup ? 'Could not create the first admin.' : 'Incorrect email or password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Homestead</h1>
          <p className="text-sm text-slate-500">
            {needsSetup ? 'Create the first administrator account.' : 'Sign in to continue.'}
          </p>
        </div>

        {needsSetup && (
          <input
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required
          />
        )}
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2"
          type="email" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)} required autoComplete="username"
        />
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2"
          type="password" placeholder="Password" value={password}
          onChange={(e) => setPassword(e.target.value)} required
          autoComplete={needsSetup ? 'new-password' : 'current-password'}
          minLength={needsSetup ? 12 : undefined}
        />

        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

        <button
          type="submit" disabled={busy}
          className="w-full rounded-lg bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Working…' : needsSetup ? 'Create admin' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
```

`src/web/routes/Placeholder.tsx`:

```tsx
export function Placeholder({ title }: { title: string }) {
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-slate-500">Built in a later phase.</p>
    </div>
  )
}
```

`src/web/routes/Shell.tsx`:

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet } from 'react-router-dom'
import { apiFetch } from '@web/api/client'
import type { Me } from '@web/auth/useSession'

export function Shell({ me }: { me: Me }) {
  const queryClient = useQueryClient()
  const isAdmin = me.role === 'admin'

  const link = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 text-sm rounded-lg ${isActive ? 'bg-slate-900 text-white' : 'text-slate-600'}`

  async function signOut() {
    await apiFetch('/api/auth/sign-out', { method: 'POST', body: '{}' })
    await queryClient.invalidateQueries({ queryKey: ['me'] })
  }

  return (
    <div className="min-h-dvh">
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
        <span className="mr-auto font-semibold">Homestead</span>
        <NavLink to="/" className={link} end>Apps</NavLink>
        {isAdmin && <NavLink to="/apps" className={link}>Manage</NavLink>}
        {isAdmin && <NavLink to="/settings" className={link}>Settings</NavLink>}
        <button type="button" onClick={signOut} className="px-3 py-2 text-sm text-slate-600">
          Sign out
        </button>
      </header>
      <main><Outlet /></main>
    </div>
  )
}
```

`src/web/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from '@web/auth/useSession'
import { Login } from '@web/routes/Login'
import { Placeholder } from '@web/routes/Placeholder'
import { Shell } from '@web/routes/Shell'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
})

function Routed() {
  const { data: me, isPending } = useSession()

  if (isPending) return <div className="p-6 text-sm text-slate-500">Loading…</div>
  if (!me) return <Login />

  const isAdmin = me.role === 'admin'

  return (
    <Routes>
      <Route element={<Shell me={me} />}>
        <Route path="/" element={<Placeholder title="Launcher" />} />
        <Route
          path="/apps/*"
          element={isAdmin ? <Placeholder title="Manage apps" /> : <Navigate to="/" replace />}
        />
        <Route
          path="/settings/*"
          element={isAdmin ? <Placeholder title="Settings" /> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter><Routed /></BrowserRouter>
    </QueryClientProvider>
  )
}
```

`src/web/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@web/App'
import '@web/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 10: Write `src/server/routes/spa.ts`**

```ts
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

export async function spaRoutes(app: FastifyInstance): Promise<void> {
  const root = resolve('dist/web')
  if (!existsSync(root)) {
    app.log.warn('dist/web not found; run `pnpm build:web` to serve the SPA')
    return
  }

  await app.register(fastifyStatic, { root, wildcard: false })

  // History fallback: any non-API path renders the SPA shell.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', path: request.url })
    }
    return reply.sendFile('index.html', join(root))
  })
}
```

Register it **last** in `buildApp`, and delete the earlier `setNotFoundHandler` from Task 8 so there is only one.

- [ ] **Step 11: Verify the whole thing runs**

```bash
pnpm build:web
HOMESTEAD_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
HOMESTEAD_BASE_URL=http://localhost:3000 \
HOMESTEAD_DB_PATH=./data/dev.db \
HOMESTEAD_SKIP_MOUNT_PREFLIGHT=true \
pnpm dev:server
```

Open `http://localhost:3000`. Expected: the first-run screen offering to create an administrator. Create one, confirm you land on the shell with "Apps", "Manage", and "Settings" visible.

- [ ] **Step 12: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: add React shell with login, first-run setup, and SPA serving"
```

---

## Self-Review

**Spec coverage for 1A's slice:**

| Spec requirement | Task |
|---|---|
| Single package, three zones, path aliases | 1 |
| Validated configuration, Access dormant unless both values set | 2, 10 |
| Complete schema including `exposures` and Cloudflare columns | 3 |
| `scopeAllApps` as an explicit boolean | 3, 11 |
| Two-tier history tables | 3 (schema only; scheduler is 1C) |
| AES-256-GCM secrets from `HOMESTEAD_SECRET_KEY` | 4 |
| `realpath` confinement surviving symlink escapes | 5 |
| `Host` interface shaped as a future network boundary | 6 |
| SHA-256 hash guard against on-disk drift | 6 |
| Mount preflight catching silent empty-volume misconfiguration | 7 |
| `trustProxy` and `CF-Connecting-IP` for audit IPs | 8, 9 |
| `role` server-owned via `input: false` | 9 |
| Cookie `Secure` conditional, both origins trusted | 2, 9 |
| Access `aud` verification | 10 |
| Capability model, viewers read-only | 11 |
| Single scope predicate used by every app query | 11 |
| First-admin bootstrap that disables itself | 12 |
| Audit log entries for user changes | 12 |
| Responsive shell, dark mode, role-aware navigation | 13 |

**Deferred to later plans, intentionally:** adoption and compose editing (1B), probes and scheduler (1C), launcher, admin inventory, edit tabs, onboarding wizard (1D). The `checkResults` / `checkRollups` / `imageStatus` / `exposures` tables exist but are unread.

**Known adaptation points.** Better-Auth's exact API for `signUpEmail`, `getSession`, and the drizzle adapter export path can shift between majors. Tasks 9 and 12 instruct verifying against the installed `.d.ts` and adapting the call while preserving behaviour — specifically that `role` is never accepted from a request body.
