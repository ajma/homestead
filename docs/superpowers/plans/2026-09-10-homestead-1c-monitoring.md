# Homestead Phase 1C — Probes, Scheduler and Live Status

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run docker, internal-HTTP and external-HTTP probes on a database-driven schedule, record their results under two-tier retention, and push transitions to the browser over SSE.

**Architecture:** A 5-second in-process tick selects probes whose `nextRunAt` has passed, runs them through a concurrency limiter, and reschedules them with jitter. `nextRunAt` lives in the database rather than in timer handles, so probes can be created and deleted at runtime and a restart resumes without a stampede. Each result and its denormalised copy on the probe row are written in one transaction, and only confirmed *transitions* reach `/api/events`.

**Tech Stack:** TypeScript (strict, ESM), Fastify, Drizzle + libSQL, dockerode, Node `fetch` with `AbortSignal`, zod 4, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — sections 3 (`probes`, `check_results`, `check_rollups`), 5 (all of it), 8 (Live updates).

**Prior phases:** `docs/superpowers/plans/2026-09-10-homestead-1b-ii-carry-forward.md` and `2026-09-09-homestead-1b-i-carry-forward.md`. Read both before Task 1 — the first names four items this phase must handle, two of which are Task 1.

## Global Constraints

- **TypeScript:** ESM only, `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: "bundler"`, `target: "ES2022"`, `lib` includes `ES2023`. Local imports inside `src/server` use relative paths with `.js` extensions; tests import via `@server/*` and `@shared/*`.
- **TypeScript 7 removed `baseUrl`.** Never add it; `paths` targets stay relative with `./`.
- **`vitest` does not typecheck.** `pnpm exec tsc --noEmit` is a separate gate.
- **A single green run proves nothing.** One test last phase failed roughly one run in five. Run the suite at least three times before believing it.
- **`process._getActiveHandles()` does not track timers.** Use `process.getActiveResourcesInfo()` filtered for `Timeout` when asserting a timer was cleared. Sockets *are* tracked there.
- **zod 4.** `z.string().url()` and `z.string().email()` are deprecated; use `z.url()` / `z.email()`.
- **No new dependencies.**
- **Every non-2xx response body carries an `error` slug.**
- **`loadApp(db, ctx, id)` in `src/server/routes/apps.ts` is the only way a route loads an app by id.** Out of scope is 404, not 403.
- **Viewers hold only `app:read`.** They see probe *status*, never probe configuration, targets or `detail` payloads — a target is an internal URL and a detail payload can carry response fragments.
- **Raw tool output never reaches a viewer-facing field.** `AppStatusSummary` splits `detail` from `adminDetail` for this reason; anything new that carries an error follows the same split.
- **A guarantee stated in a comment must be provided by the code beneath it.** Five separate instances of that gap were found in the previous phase, four of them late. If you write "never throws", put the guard around everything the sentence covers — including database writes.
- **Biome clean** (`pnpm exec biome check .`) and the full suite green before any task is called done. **343 tests** exist at the start of this phase.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/monitoring/types.ts` | `ProbeRow`, `ProbeResult`, `ProbeContext`, `ProbeRunner`. |
| `src/server/monitoring/status-pattern.ts` | Parse and match `expectedStatusPattern` (`2xx,3xx`, `200,204,301`). Pure. |
| `src/server/monitoring/transition.ts` | Consecutive-failure thresholds, the grace window, `statusSince`. Pure. |
| `src/server/monitoring/docker-runner.ts` | The docker probe, reading one shared container snapshot. |
| `src/server/monitoring/http-runner.ts` | `http_internal` and `http_external`, including Access classification. |
| `src/server/monitoring/persist.ts` | One transaction: `check_results` row plus the denormalised probe row. |
| `src/server/monitoring/scheduler.ts` | The tick, due selection, concurrency limit, jitter, shared snapshot. |
| `src/server/monitoring/retention.ts` | Hourly rollup, pruning, startup catch-up. |
| `src/server/routes/probes.ts` | Probe CRUD, and suggestion of internal targets from published ports. |
| `src/server/routes/events.ts` | `/api/events` — transitions only, scope-filtered. |
| `src/server/apps/status-for.ts` | `statusFor`, extracted from the `appRoutes` closure. |

---

### Task 1: Carry-forward — extract `statusFor`, prefer the resolved project name

**Files:**
- Create: `src/server/apps/status-for.ts`, `src/server/apps/status-for.test.ts`
- Modify: `src/server/routes/apps.ts`, `src/server/routes/containers.ts`, `src/server/routes/logs.ts`

**Interfaces:**
- Consumes: `ComposeConfigCache`, `Host`, `rollUpStatus`.
- Produces:

```ts
export type StatusDeps = { host: Host; composeConfig: ComposeConfigCache }
export type AppRow = typeof apps.$inferSelect

/** The project name compose would use right now, or the stored one if it cannot be read. */
export async function currentProjectName(deps: StatusDeps, row: AppRow): Promise<string>

export async function statusFor(
  deps: StatusDeps,
  row: AppRow,
  containers?: ContainerSummary[],
): Promise<AppStatusSummary>
```

Both items come from the 1B-ii carry-forward. The scheduler needs `statusFor`, and it is the
scheduler that turns the stale-project-name problem from momentary into permanent.

**The stale name, measured last phase:** adding `COMPOSE_PROJECT_NAME=media` to an app's `.env`
over SSH makes a running container report `status: "down"` with `"0/1 services up, 1 missing"`,
`GET /api/apps/:id/containers` return `[]`, and the logs route 404. `apps.projectName` is
written at adoption and reconciled after writes made *through* Homestead, but nothing reconciles
an out-of-band edit. `statusFor` already resolves the compose config and holds the correct name
in `resolved.resolved.projectName` — and then queries containers with the stored one anyway.

- [ ] **Step 1: Write the failing test**

`src/server/apps/status-for.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ComposeConfigCache } from '@server/apps/compose-config'
import { currentProjectName, statusFor } from '@server/apps/status-for'
import { FakeHost } from '@server/test-helpers'

const CONFIG = (name: string) =>
  JSON.stringify({ name, services: { web: { image: 'nginx' } } })

const row = {
  id: 'a1', hostId: 'local', slug: 'jellyfin', displayName: 'Jellyfin',
  directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
} as never

function deps(configName: string) {
  const host = new FakeHost()
  host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  host.composeResults.set('config --format json', {
    exitCode: 0, stdout: CONFIG(configName), stderr: '',
  })
  return { host, composeConfig: new ComposeConfigCache(host) }
}

describe('currentProjectName', () => {
  it('prefers what compose resolves over the stored copy', async () => {
    // The stored copy is written at adoption. An SSH edit to `.env` setting
    // COMPOSE_PROJECT_NAME makes it wrong, and every container lookup then matches
    // nothing — a running stack reads as down with all services missing.
    expect(await currentProjectName(deps('media'), row)).toBe('media')
  })

  it('falls back to the stored copy when compose cannot be resolved', async () => {
    const d = deps('media')
    d.host.composeResults.set('config --format json', {
      exitCode: 1, stdout: '', stderr: 'broken',
    })
    expect(await currentProjectName(d, row)).toBe('jellyfin')
  })

  it('falls back when the compose file cannot be read at all', async () => {
    const d = deps('media')
    d.host.readTextFileErrors.set('jellyfin/compose.yaml', new Error('ENOENT'))
    expect(await currentProjectName(d, row)).toBe('jellyfin')
  })
})

describe('statusFor', () => {
  it('finds containers under the resolved name, not the stored one', async () => {
    const d = deps('media')
    d.host.containers = [{
      id: 'c1', names: ['media-web-1'], image: 'nginx', state: 'running',
      status: 'Up 2 hours', project: 'media', service: 'web', labels: {},
    }]
    // With the stored name the query matches nothing and this reads "down, 1 missing".
    expect(await statusFor(d, row)).toEqual({ status: 'up', detail: '1/1 services up' })
  })

  it('keeps raw compose stderr out of the viewer-facing field', async () => {
    const d = deps('media')
    d.host.composeResults.set('config --format json', {
      exitCode: 1, stdout: '', stderr: '/volume2/docker/jellyfin/.env: bad value sk-live-9',
    })
    const result = await statusFor(d, row)
    expect(result.detail).toBe('compose configuration is invalid')
    expect(result.adminDetail).toContain('sk-live-9')
  })

  it('uses a supplied container list without asking Docker', async () => {
    const d = deps('media')
    const before = d.host.listContainersCalls
    await statusFor(d, row, [])
    expect(d.host.listContainersCalls).toBe(before)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/apps/status-for.test.ts`
Expected: FAIL — cannot find module `@server/apps/status-for`.

- [ ] **Step 3: Write `src/server/apps/status-for.ts`**

Move the body of `statusFor` out of `appRoutes` and give it explicit deps.

```ts
import type { ComposeConfigCache } from './compose-config.js'
import type { apps } from '../db/schema.js'
import type { AppStatusSummary } from './serialize.js'
import type { ContainerSummary, Host } from '../host/types.js'
import { rollUpStatus } from './status.js'

export type StatusDeps = { host: Host; composeConfig: ComposeConfigCache }
export type AppRow = typeof apps.$inferSelect

/**
 * The project name compose would use for this app right now.
 *
 * `apps.projectName` is written at adoption and reconciled after writes made through
 * Homestead, but an SSH edit to `.env` setting `COMPOSE_PROJECT_NAME` changes it
 * underneath us. Measured: the stored name then matches no container, so a running stack
 * reports `down` with every service missing, the containers list is empty, and the logs
 * route 404s. Resolving is already happening for the status rollup; using its answer
 * costs nothing.
 *
 * The stored copy remains the fallback: when compose cannot be resolved at all we have
 * nothing better, and a stale name beats no name.
 */
export async function currentProjectName(deps: StatusDeps, row: AppRow): Promise<string> {
  try {
    const resolved = await deps.composeConfig.resolve({
      directory: row.directory,
      composeFile: row.composeFile,
    })
    if (resolved.valid && resolved.resolved.projectName !== '') {
      return resolved.resolved.projectName
    }
  } catch {
    // Unreadable compose file. Fall through.
  }
  return row.projectName ?? ''
}

export async function statusFor(
  deps: StatusDeps,
  row: AppRow,
  containers?: ContainerSummary[],
): Promise<AppStatusSummary> {
  const target = { directory: row.directory, composeFile: row.composeFile }
  try {
    const resolved = await deps.composeConfig.resolve(target)
    if (!resolved.valid) {
      // Raw `docker compose config` stderr routinely carries absolute paths and
      // interpolated `.env` values, so it goes in `adminDetail` and the viewer gets a
      // description instead.
      return {
        status: 'unknown',
        detail: 'compose configuration is invalid',
        adminDetail: resolved.message,
      }
    }
    const found =
      containers ??
      (await deps.host.listContainers({ project: resolved.resolved.projectName }))
    return rollUpStatus(resolved.resolved.services, found)
  } catch (error) {
    // The compose root is an SMB share the user edits over SSH, so a renamed or moved
    // file is ordinary operation, not an exception worth a 500.
    return {
      status: 'unknown',
      detail: 'compose file could not be read',
      adminDetail: error instanceof Error ? error.message : String(error),
    }
  }
}
```

- [ ] **Step 4: Update the three routes**

`apps.ts` deletes its local `statusFor` and imports this one, passing `{ host, composeConfig }`.
`containers.ts` and `logs.ts` replace `row.projectName ?? ''` in their `listContainers` calls
with `await currentProjectName({ host, composeConfig }, row)`. Both files will need
`composeConfig` from `app.deps`.

**`GET /api/apps` needs the same change and is easy to miss.** It fetches one container
snapshot and partitions it into a `byProject` map, then looks each row up by
`row.projectName ?? ''` — the stored copy — and hands the result to `statusFor` as its
`containers` argument, which makes `statusFor` skip its own lookup entirely. So fixing
`statusFor` alone leaves the list route exactly as wrong as before.

Measured with the stored name stale: `GET /api/apps/:id` reports `up, 1/1 services up`
while `GET /api/apps` reports `down, 0/1 services up, 1 missing` — the same app, the same
instant, two answers, and the wrong one is on the launcher. Change the lookup to:

```ts
        const project = await currentProjectName({ host, composeConfig }, row)
        const status = await statusFor({ host, composeConfig }, row, byProject.get(project) ?? [])
```

The extra `resolve` per row is a cache hit — `ComposeConfigCache` is keyed on file content —
so this costs a map lookup, not a subprocess. The existing test asserting one `listContainers`
call per request must still pass.

- [ ] **Step 5: Run everything and commit**

```bash
pnpm exec vitest run src/server/apps/status-for.test.ts && pnpm test && pnpm exec tsc --noEmit
git add src/server/apps/status-for.ts src/server/apps/status-for.test.ts src/server/routes
git commit -m "Resolve the project name per request instead of trusting the stored copy"
```

---

### Task 2: `expectedStatusPattern` matching

**Files:**
- Create: `src/server/monitoring/status-pattern.ts`, `src/server/monitoring/status-pattern.test.ts`

**Interfaces:**
- Produces:

```ts
export function matchesStatusPattern(pattern: string, status: number): boolean
/** Whether a pattern has at least one usable term. For validating user input. */
export function isValidStatusPattern(pattern: string): boolean
```

The spec calls it "a comma-separated list of literal codes and `Nxx` classes — e.g. `2xx,3xx` or
`200,204,301`". Pure, and worth its own file because every HTTP probe's verdict routes through
it and a permissive bug here reports dead apps as healthy.

- [ ] **Step 1: Write the failing test**

`src/server/monitoring/status-pattern.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { matchesStatusPattern } from '@server/monitoring/status-pattern'

describe('matchesStatusPattern', () => {
  it.each([
    ['2xx,3xx', 200, true],
    ['2xx,3xx', 204, true],
    ['2xx,3xx', 301, true],
    ['2xx,3xx', 404, false],
    ['2xx,3xx', 500, false],
    ['200,204,301', 200, true],
    ['200,204,301', 201, false],
    ['4xx', 418, true],
    ['5xx', 503, true],
  ])('%s vs %i -> %s', (pattern, status, expected) => {
    expect(matchesStatusPattern(pattern, status)).toBe(expected)
  })

  it('tolerates whitespace and case in the pattern', () => {
    expect(matchesStatusPattern(' 2XX , 301 ', 204)).toBe(true)
    expect(matchesStatusPattern(' 2XX , 301 ', 301)).toBe(true)
  })

  it('rejects everything when the pattern is empty or nonsense', () => {
    // Failing CLOSED matters: a pattern that matches nothing shows the app as down, which
    // the user investigates. One that matches everything shows a dead app as healthy
    // forever, which they never find out about.
    for (const pattern of ['', '   ', 'banana', ',,,']) {
      expect(matchesStatusPattern(pattern, 200)).toBe(false)
    }
  })

  it('ignores an unparseable term but honours the rest', () => {
    expect(matchesStatusPattern('banana,2xx', 200)).toBe(true)
    expect(matchesStatusPattern('banana,2xx', 404)).toBe(false)
  })

  it('validates a pattern independently of any status', () => {
    // The matcher fails closed, which is right — but a user who types `2x` for `2xx`
    // then sees their app go red with nothing saying the pattern is the problem. The
    // probe API rejects it at the point they type it instead.
    for (const good of ['2xx', '2xx,3xx', '200', '200,204,301', ' 2XX , 301 ']) {
      expect(isValidStatusPattern(good), good).toBe(true)
    }
    for (const bad of ['', '   ', ',,,', 'banana', '2x', '20', '6xx', '1000']) {
      expect(isValidStatusPattern(bad), bad).toBe(false)
    }
  })

  it('does not treat a class as a prefix match', () => {
    // `2xx` must not match 2, 20, or 2000.
    for (const status of [2, 20, 2000]) {
      expect(matchesStatusPattern('2xx', status)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/monitoring/status-pattern.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/monitoring/status-pattern.ts`**

```ts
/**
 * Matches an HTTP status against a comma-separated pattern of literal codes and `Nxx`
 * classes — `2xx,3xx`, `200,204,301`.
 *
 * Fails CLOSED. An empty or unparseable pattern matches nothing, so the probe reads down
 * and the user investigates. The opposite mistake — matching everything — reports a dead
 * app as healthy indefinitely, which nobody ever notices.
 */
const CLASS_TERM = /^([1-5])xx$/
const LITERAL_TERM = /^[1-5][0-9]{2}$/

/** The terms a pattern contains, ignoring blanks and anything unparseable. */
function usableTerms(pattern: string): string[] {
  return pattern
    .split(',')
    .map((raw) => raw.trim().toLowerCase())
    .filter((term) => CLASS_TERM.test(term) || LITERAL_TERM.test(term))
}

export function matchesStatusPattern(pattern: string, status: number): boolean {
  if (!Number.isInteger(status) || status < 100 || status > 599) return false

  for (const term of usableTerms(pattern)) {
    const asClass = CLASS_TERM.exec(term)
    if (asClass) {
      if (Math.floor(status / 100) === Number(asClass[1])) return true
      continue
    }
    if (Number(term) === status) return true
  }

  return false
}

/**
 * Whether a pattern would ever match anything.
 *
 * The matcher failing closed is right at runtime, but on its own it means a user who
 * types `2x` for `2xx` watches their app go red with nothing saying the pattern is at
 * fault. The probe API calls this when they type it, so the mistake is caught where it
 * can still be explained.
 */
export function isValidStatusPattern(pattern: string): boolean {
  return usableTerms(pattern).length > 0
}
```

- [ ] **Step 4: Run it and commit**

```bash
pnpm exec vitest run src/server/monitoring/status-pattern.test.ts
git add src/server/monitoring/status-pattern.ts src/server/monitoring/status-pattern.test.ts
git commit -m "Match HTTP status patterns, failing closed on nonsense"
```

---

### Task 3: Transition thresholds and the grace window

**Files:**
- Create: `src/server/monitoring/transition.ts`, `src/server/monitoring/transition.test.ts`

**Interfaces:**
- Produces:

```ts
export type ProbeState = {
  lastStatus: 'up' | 'degraded' | 'down' | 'starting' | 'unknown'
  consecutiveFailures: number
  statusSince: number | null
}

export type TransitionInput = {
  state: ProbeState
  observed: 'up' | 'degraded' | 'down'
  now: number
  /** `apps.graceUntil`, in seconds. */
  graceUntil: number | null
  failureThreshold: number   // default 2
}

export type TransitionOutput = {
  status: 'up' | 'degraded' | 'down' | 'starting' | 'unknown'
  consecutiveFailures: number
  statusSince: number
  /** True only when `status` differs from `state.lastStatus`. Drives the SSE fan-out. */
  changed: boolean
}

export function applyTransition(input: TransitionInput): TransitionOutput
```

Spec §5: "Default **2 consecutive failures to go down, 1 success to recover** — asymmetric
because the 'action' triggered by a failure is a human looking at their phone, so a false alarm
costs more than 60 seconds of delayed detection. `statusSince` moves only on a confirmed
transition, so the timeline records real outages rather than packet loss." And: "The
post-lifecycle grace window means a restart you initiated is never reported as an outage."

Pure, so every combination is cheap to pin — and this is the logic that decides whether the
user's phone buzzes.

- [ ] **Step 1: Write the failing test**

`src/server/monitoring/transition.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyTransition, type ProbeState } from '@server/monitoring/transition'

const NOW = 1_800_000_000
const state = (over: Partial<ProbeState> = {}): ProbeState => ({
  lastStatus: 'up', consecutiveFailures: 0, statusSince: NOW - 3600, ...over,
})
const run = (over: Partial<Parameters<typeof applyTransition>[0]> = {}) =>
  applyTransition({
    state: state(), observed: 'up', now: NOW, graceUntil: null, failureThreshold: 2, ...over,
  })

describe('applyTransition', () => {
  it('does not go down on a single failure', () => {
    // The asymmetry: one failed check is packet loss, and a false alarm costs more than
    // sixty seconds of delayed detection.
    const out = run({ observed: 'down' })
    expect(out.status).toBe('up')
    expect(out.consecutiveFailures).toBe(1)
    expect(out.changed).toBe(false)
    expect(out.statusSince).toBe(NOW - 3600)
  })

  it('goes down on the second consecutive failure', () => {
    const out = run({ observed: 'down', state: state({ consecutiveFailures: 1 }) })
    expect(out).toMatchObject({ status: 'down', changed: true, statusSince: NOW })
  })

  it('recovers on the first success', () => {
    const out = run({
      observed: 'up',
      state: state({ lastStatus: 'down', consecutiveFailures: 5, statusSince: NOW - 600 }),
    })
    expect(out).toMatchObject({ status: 'up', consecutiveFailures: 0, changed: true, statusSince: NOW })
  })

  it('leaves statusSince alone when nothing changed', () => {
    // The timeline must record real outages, not every sample.
    const out = run({ observed: 'up', state: state({ statusSince: NOW - 9999 }) })
    expect(out.changed).toBe(false)
    expect(out.statusSince).toBe(NOW - 9999)
  })

  it('resets the failure count on any success', () => {
    const out = run({ observed: 'up', state: state({ consecutiveFailures: 1 }) })
    expect(out.consecutiveFailures).toBe(0)
  })

  it('reports starting during the grace window instead of down', () => {
    // A restart the user initiated is never an outage.
    const out = run({
      observed: 'down',
      graceUntil: NOW + 60,
      state: state({ consecutiveFailures: 5, lastStatus: 'up' }),
    })
    expect(out.status).toBe('starting')
  })

  it('does not let the grace window mask a success', () => {
    const out = run({ observed: 'up', graceUntil: NOW + 60 })
    expect(out.status).toBe('up')
  })

  it('stops masking once the grace window has passed', () => {
    const out = run({
      observed: 'down', graceUntil: NOW - 1, state: state({ consecutiveFailures: 1 }),
    })
    expect(out.status).toBe('down')
  })

  it('counts failures during grace so the fall is immediate when it ends', () => {
    // Otherwise a stack that never comes back looks healthy for two more intervals after
    // the window closes.
    const out = run({ observed: 'down', graceUntil: NOW + 60 })
    expect(out.consecutiveFailures).toBe(1)
  })

  it('treats degraded as a failure for counting but reports it distinctly', () => {
    const first = run({ observed: 'degraded' })
    expect(first).toMatchObject({ status: 'up', consecutiveFailures: 1, changed: false })
    const second = run({ observed: 'degraded', state: state({ consecutiveFailures: 1 }) })
    expect(second).toMatchObject({ status: 'degraded', changed: true })
  })

  it('honours a threshold of 1', () => {
    const out = run({ observed: 'down', failureThreshold: 1 })
    expect(out).toMatchObject({ status: 'down', changed: true })
  })

  it('sets statusSince on the first ever check', () => {
    const out = run({ observed: 'up', state: state({ lastStatus: 'unknown', statusSince: null }) })
    expect(out).toMatchObject({ status: 'up', changed: true, statusSince: NOW })
  })

  it('holds unknown, not starting, for an unconfirmed first failure', () => {
    // Nothing is starting — the probe has simply not confirmed a failure yet. Saying
    // `starting` implies a deploy the user did not do, and the launcher already has a
    // rendering for unknown.
    const out = run({ observed: 'down', state: state({ lastStatus: 'unknown', statusSince: null }) })
    expect(out).toMatchObject({ status: 'unknown', consecutiveFailures: 1, changed: false })
  })

  it('keeps statusSince moving when a restart begins', () => {
    // A review called this a false outage record. It is not: the status is `starting`,
    // not `down`, and "the restart you initiated is never reported as an outage" is
    // delivered by that value. `statusSince` means "the current status began at", so
    // freezing it would have a restarting app claim it has been starting since whenever
    // it was last healthy — wrong in a way the timeline cannot recover from.
    const out = run({ observed: 'down', graceUntil: NOW + 60, state: state({ statusSince: NOW - 5000 }) })
    expect(out).toMatchObject({ status: 'starting', statusSince: NOW, changed: true })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/monitoring/transition.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/monitoring/transition.ts`**

```ts
export type ProbeState = {
  lastStatus: 'up' | 'degraded' | 'down' | 'starting' | 'unknown'
  consecutiveFailures: number
  statusSince: number | null
}

export type TransitionInput = {
  state: ProbeState
  observed: 'up' | 'degraded' | 'down'
  now: number
  graceUntil: number | null
  failureThreshold: number
}

export type TransitionOutput = {
  status: 'up' | 'degraded' | 'down' | 'starting' | 'unknown'
  consecutiveFailures: number
  statusSince: number
  changed: boolean
}

/**
 * Decides what a single observation does to a probe's recorded state.
 *
 * Asymmetric on purpose: N consecutive failures to fall, one success to recover. The
 * action a failure triggers is a human picking up their phone, so a false alarm costs
 * more than a minute of delayed detection.
 *
 * `statusSince` moves only on a confirmed transition. That is what makes the timeline a
 * record of outages rather than of samples.
 */
export function applyTransition(input: TransitionInput): TransitionOutput {
  const { state, observed, now, graceUntil, failureThreshold } = input
  const failed = observed !== 'up'

  // Count failures even inside the grace window. Suppressing the count as well as the
  // status would mean a stack that never comes back reads healthy for another
  // `failureThreshold` intervals after the window closes.
  const consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0

  const inGrace = graceUntil !== null && graceUntil > now

  let status: TransitionOutput['status']
  if (!failed) {
    status = 'up'
  } else if (inGrace) {
    // A restart the user initiated is not an outage.
    status = 'starting'
  } else if (consecutiveFailures >= failureThreshold) {
    status = observed
  } else {
    // Not yet confirmed: hold whatever we were showing. A probe that has never reported
    // anything holds `unknown` rather than claiming `starting` — nothing is starting, we
    // simply have not confirmed a failure yet, and the launcher already renders unknown.
    status = state.lastStatus === 'unknown' ? 'unknown' : state.lastStatus
  }

  const changed = status !== state.lastStatus
  return {
    status,
    consecutiveFailures,
    statusSince: changed || state.statusSince === null ? now : state.statusSince,
    changed,
  }
}
```

- [ ] **Step 4: Run it and commit**

```bash
pnpm exec vitest run src/server/monitoring/transition.test.ts
git add src/server/monitoring/transition.ts src/server/monitoring/transition.test.ts
git commit -m "Confirm probe transitions before reporting them"
```

---

### Task 4: The docker probe runner

**Files:**
- Create: `src/server/monitoring/types.ts`, `src/server/monitoring/docker-runner.ts`, `src/server/monitoring/docker-runner.test.ts`

**Interfaces:**
- Consumes: `statusFor` (Task 1), `ContainerSummary`.
- Produces:

```ts
export type ProbeRow = typeof probes.$inferSelect

export type ProbeResult = {
  status: 'up' | 'degraded' | 'down'
  latencyMs?: number
  detail?: Record<string, unknown>
  faultClass?: 'app' | 'network' | 'config'
}

export type ProbeContext = {
  app: AppRow
  /** One whole-host `listContainers()` snapshot shared by every docker probe in a tick. */
  containers: ContainerSummary[] | null
  deps: StatusDeps
}

export interface ProbeRunner {
  kind: 'docker' | 'http_internal' | 'http_external'
  run(probe: ProbeRow, ctx: ProbeContext): Promise<ProbeResult>
}

export const dockerRunner: ProbeRunner
```

Spec §5: "All docker probes in a tick share **one** `listContainers({ all: true })` snapshot
indexed by project label — one Engine API call for the whole host, not one per app." Note the
signature is `listContainers(filters?: { project?: string })` — there is no `all` option to
pass, because `LocalHost` already hardcodes `all: true`, so the whole-host snapshot is
`listContainers()` with no argument. The snapshot is `null` when that call failed, which is not
the same as an empty host.

- [ ] **Step 1: Write the failing test**

`src/server/monitoring/docker-runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ComposeConfigCache } from '@server/apps/compose-config'
import { dockerRunner } from '@server/monitoring/docker-runner'
import { FakeHost } from '@server/test-helpers'
import type { ContainerSummary } from '@server/host/types'

const CONFIG = JSON.stringify({
  name: 'jellyfin',
  services: { web: { image: 'nginx' }, db: { image: 'postgres' } },
})

const app = {
  id: 'a1', hostId: 'local', slug: 'jellyfin', displayName: 'Jellyfin',
  directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
} as never

const probe = { id: 'p1', appId: 'a1', kind: 'docker' } as never

const container = (service: string, state: string, project = 'jellyfin'): ContainerSummary => ({
  id: `${project}-${service}`, names: [`${project}-${service}-1`], image: 'x',
  state, status: state === 'running' ? 'Up 2 hours' : 'Exited (1)', project, service, labels: {},
})

function ctx(containers: ContainerSummary[] | null) {
  const host = new FakeHost()
  host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  host.composeResults.set('config --format json', { exitCode: 0, stdout: CONFIG, stderr: '' })
  return { app, containers, deps: { host, composeConfig: new ComposeConfigCache(host) } }
}

describe('dockerRunner', () => {
  it('is up when every expected service is running', async () => {
    const result = await dockerRunner.run(probe, ctx([
      container('web', 'running'), container('db', 'running'),
    ]))
    expect(result).toMatchObject({ status: 'up', faultClass: undefined })
    expect(result.detail?.summary).toBe('2/2 services up')
  })

  it('is down with an app fault when a service is missing', async () => {
    const result = await dockerRunner.run(probe, ctx([container('web', 'running')]))
    expect(result).toMatchObject({ status: 'down', faultClass: 'app' })
  })

  it('filters the shared snapshot by project, ignoring other apps', async () => {
    // The snapshot is every container on the host. Counting another project's would make
    // an unrelated app's health change this one's.
    const result = await dockerRunner.run(probe, ctx([
      container('web', 'running'), container('db', 'running'),
      container('web', 'exited', 'paperless'),
    ]))
    expect(result.status).toBe('up')
  })

  it('reports config, not app, when the compose file will not resolve', async () => {
    const c = ctx([])
    c.deps.host.composeResults.set('config --format json', {
      exitCode: 1, stdout: '', stderr: 'bad yaml',
    })
    expect(await dockerRunner.run(probe, c)).toMatchObject({ status: 'down', faultClass: 'config' })
  })

  it('reports network, not app, when the snapshot is unavailable', async () => {
    // `null` means the Engine API call failed. Reporting that as an app fault blames the
    // user's stack for a broken Docker socket.
    expect(await dockerRunner.run(probe, ctx(null))).toMatchObject({
      status: 'down', faultClass: 'network',
    })
  })

  it('keeps raw compose stderr out of the detail payload', async () => {
    const c = ctx([])
    c.deps.host.composeResults.set('config --format json', {
      exitCode: 1, stdout: '', stderr: '/volume2/docker/jellyfin/.env: sk-live-9',
    })
    const result = await dockerRunner.run(probe, c)
    expect(JSON.stringify(result.detail)).not.toContain('sk-live-9')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/monitoring/docker-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/monitoring/types.ts`**

```ts
import type { apps, probes } from '../db/schema.js'
import type { ContainerSummary } from '../host/types.js'
import type { StatusDeps } from '../apps/status-for.js'

export type ProbeRow = typeof probes.$inferSelect
export type AppRow = typeof apps.$inferSelect

export type ProbeResult = {
  status: 'up' | 'degraded' | 'down'
  latencyMs?: number
  detail?: Record<string, unknown>
  faultClass?: 'app' | 'network' | 'config'
}

export type ProbeContext = {
  app: AppRow
  /**
   * Every container on the host, or `null` when the Engine API call failed.
   *
   * `null` and `[]` are different answers and must stay different: an empty host means
   * nothing is running, a failed call means we do not know, and blaming the user's stack
   * for a broken socket is how a monitoring system loses trust.
   */
  containers: ContainerSummary[] | null
  deps: StatusDeps
}

export interface ProbeRunner {
  kind: ProbeRow['kind']
  run(probe: ProbeRow, ctx: ProbeContext): Promise<ProbeResult>
}
```

- [ ] **Step 4: Write `src/server/monitoring/docker-runner.ts`**

```ts
import { currentProjectName, statusFor } from '../apps/status-for.js'
import type { ProbeContext, ProbeResult, ProbeRow, ProbeRunner } from './types.js'

export const dockerRunner: ProbeRunner = {
  kind: 'docker',

  async run(_probe: ProbeRow, ctx: ProbeContext): Promise<ProbeResult> {
    if (ctx.containers === null) {
      // The Engine API call failed for the whole tick. Not the app's fault.
      return {
        status: 'down',
        faultClass: 'network',
        detail: { summary: 'Docker is not reachable' },
      }
    }

    const project = await currentProjectName(ctx.deps, ctx.app)
    const mine = ctx.containers.filter((container) => container.project === project)
    const rolled = await statusFor(ctx.deps, ctx.app, mine)

    if (rolled.status === 'unknown') {
      // `statusFor` returns unknown only when the compose file could not be read or
      // resolved — a configuration problem, not a dead container. `adminDetail` holds raw
      // stderr and must not travel into a payload the viewer's status line can reach.
      return {
        status: 'down',
        faultClass: 'config',
        detail: { summary: rolled.detail ?? 'compose configuration is invalid' },
      }
    }

    // `starting` is not one of the three verdicts a runner may return — the grace window
    // in `applyTransition` is what turns a confirmed failure into `starting`, and it needs
    // to see the raw observation to do that.
    const status = rolled.status === 'starting' ? 'degraded' : rolled.status
    return {
      status,
      ...(status === 'up' ? {} : { faultClass: 'app' as const }),
      detail: { summary: rolled.detail ?? '' },
    }
  },
}
```

- [ ] **Step 5: Run it and commit**

```bash
pnpm exec vitest run src/server/monitoring/docker-runner.test.ts && pnpm test
git add src/server/monitoring/types.ts src/server/monitoring/docker-runner.ts src/server/monitoring/docker-runner.test.ts
git commit -m "Add the docker probe, reading one shared container snapshot"
```

---

### Task 5: The HTTP probe runners

**Files:**
- Create: `src/server/monitoring/http-runner.ts`, `src/server/monitoring/http-runner.test.ts`

**Interfaces:**
- Consumes: `matchesStatusPattern` (Task 2), the probe types (Task 4).
- Produces:

```ts
export function createHttpRunners(deps: {
  fetch: typeof fetch
  /** Access service-token headers, or null in Phase 1C where no exposure exists yet. */
  accessCredentials?: () => Promise<{ clientId: string; clientSecret: string } | null>
}): { internal: ProbeRunner; external: ProbeRunner }
```

**`redirect: 'manual'` is the single most load-bearing line in this phase.** Spec §5: "When
Access rejects a request it redirects to the team login page, and that login page returns
`200 OK`. A monitor using default `fetch` behaviour follows the redirect, sees 200, and reports
the app up indefinitely — even with the origin dead."

The external classification table, verbatim from the spec:

| Observation | Status | `faultClass` |
|---|---|---|
| Expected 2xx/3xx from origin | up | — |
| Redirect to `*.cloudflareaccess.com` | degraded | config |
| Cloudflare 502 / 503 / 1033 | down | network |
| DNS resolution failure | down | config |
| Timeout | down | network |

- [ ] **Step 1: Write the failing test**

`src/server/monitoring/http-runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createHttpRunners } from '@server/monitoring/http-runner'
import type { ProbeContext, ProbeRow } from '@server/monitoring/types'

const ctx = {} as ProbeContext
const probe = (over: Partial<ProbeRow> = {}): ProbeRow =>
  ({
    id: 'p1', appId: 'a1', kind: 'http_internal', target: 'http://nas.local:8096',
    expectedStatusPattern: '2xx,3xx', timeoutMs: 5000, insecureTls: false,
    followRedirects: false,
    ...over,
  }) as ProbeRow

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

describe('http_internal', () => {
  it('is up for an accepted status', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 204 }))
    const result = await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)
    expect(result.status).toBe('up')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('is down with an app fault for a rejected status', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 500 }))
    expect(await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)).toMatchObject({
      status: 'down', faultClass: 'app',
    })
  })

  it('never follows redirects', async () => {
    // The whole reason this phase exists. A 302 must be judged, not chased.
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 302 }))
    await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)
    expect(calls[0]?.init?.redirect).toBe('manual')
  })

  it('is down with a network fault on a connection failure', async () => {
    const impl = (async () => {
      throw new Error('connect ECONNREFUSED 192.168.1.10:8096')
    }) as unknown as typeof fetch
    expect(await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)).toMatchObject({
      status: 'down', faultClass: 'network',
    })
  })

  it('is down with a config fault when the host does not resolve', async () => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND nas.local')
    }) as unknown as typeof fetch
    expect(await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)).toMatchObject({
      status: 'down', faultClass: 'config',
    })
  })

  it('is down with a config fault when the target is missing or unparseable', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    const runners = createHttpRunners({ fetch: impl })
    expect(await runners.internal.run(probe({ target: null }), ctx)).toMatchObject({
      status: 'down', faultClass: 'config',
    })
    expect(await runners.internal.run(probe({ target: 'not a url' }), ctx)).toMatchObject({
      status: 'down', faultClass: 'config',
    })
    // Nothing was requested for either.
    expect(calls).toHaveLength(0)
  })

  it('refuses a non-http scheme without making the request', async () => {
    // The API rejects these when the user types one, but this is the code that performs
    // the fetch, and a row can reach it by other routes. Measured before this check:
    // `file:///etc/passwd` was passed to fetch.
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    const runners = createHttpRunners({ fetch: impl })
    for (const target of ['file:///etc/passwd', 'ftp://x/y', 'data:text/plain,hi']) {
      const result = await runners.internal.run(probe({ target }), ctx)
      expect(result, target).toMatchObject({ status: 'down', faultClass: 'config' })
    }
    expect(calls).toHaveLength(0)
  })

  it('passes an abort signal derived from the probe timeout', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    await createHttpRunners({ fetch: impl }).internal.run(probe({ timeoutMs: 1234 }), ctx)
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not read a body at all on the internal path', async () => {
    // The internal runner classifies on the status line alone, so it never touches the
    // body. Asserting a size cap here would pass without any cap existing — the external
    // runner is the one that reads, and it has its own test below.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(1000)))
        controller.close()
      },
    })
    const { impl } = fakeFetch(() => new Response(body, { status: 200 }))
    const result = await createHttpRunners({ fetch: impl }).internal.run(probe(), ctx)
    expect(result.status).toBe('up')
    expect(JSON.stringify(result.detail)).not.toContain('xxx')
  })
})

describe('http_external', () => {
  const external = (over: Partial<ProbeRow> = {}) =>
    probe({ kind: 'http_external', target: 'https://jellyfin.example.com', ...over })

  const creds = async () => ({ clientId: 'cid', clientSecret: 'secret' })

  it('sends the Access service-token headers', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(external(), ctx)
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['cf-access-client-id']).toBe('cid')
    expect(headers['cf-access-client-secret']).toBe('secret')
  })

  it('calls a redirect to the Access login page degraded/config, not up', async () => {
    // The failure this classification exists for: that login page returns 200, so a
    // monitor following redirects reports a dead origin as healthy forever.
    const { impl } = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' },
        }),
    )
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(external(), ctx),
    ).toMatchObject({ status: 'degraded', faultClass: 'config' })
  })

  it.each([502, 503])('calls a Cloudflare %i down/network', async (status) => {
    const { impl } = fakeFetch(() => new Response(null, { status }))
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(external(), ctx),
    ).toMatchObject({ status: 'down', faultClass: 'network' })
  })

  it('calls a Cloudflare 1033 body down/network even behind a 530', async () => {
    const { impl } = fakeFetch(() => new Response('Error 1033: Argo Tunnel error', { status: 530 }))
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(external(), ctx),
    ).toMatchObject({ status: 'down', faultClass: 'network' })
  })

  it('is degraded/config when no service token is configured', async () => {
    // Without credentials every request lands on the login page; saying "up" would be a lie
    // and saying "down" would blame the app.
    const { impl } = fakeFetch(() => new Response(null, { status: 200 }))
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: async () => null }).external.run(
        external(), ctx,
      ),
    ).toMatchObject({ status: 'degraded', faultClass: 'config' })
  })

  it('is up for an accepted status from the origin', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 200 }))
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(external(), ctx),
    ).toMatchObject({ status: 'up' })
  })

  it('stops reading a huge error body instead of buffering all of it', async () => {
    // This is the path that DOES read a body — looking for Cloudflare's 1033 under a
    // 5xx. `response.text()` would buffer the whole thing first, so an origin answering
    // a 5xx with a gigabyte would be pulled in full every 60 seconds.
    let produced = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1
        controller.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024)))
      },
      cancel() {
        cancelled = true
      },
    })
    const { impl } = fakeFetch(() => new Response(body, { status: 520 }))
    const result = await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
      external(), ctx,
    )
    expect(result.status).toBe('down')
    // A handful of 64KB chunks, not an unbounded stream, and the transfer was stopped.
    expect(produced).toBeLessThan(5)
    expect(cancelled).toBe(true)
  })

  it('finds a marker that straddles the sample boundary', async () => {
    // Slicing the accumulated bytes back to exactly the cap cut a marker in half: 2047
    // filler bytes then "1033" decoded as "…1", so a tunnel outage was reported as an
    // application fault. The read is already bounded; the slice only created this.
    const { impl } = fakeFetch(
      () => new Response(`${'x'.repeat(2047)}1033`, { status: 530 }),
    )
    expect(
      await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(external(), ctx),
    ).toMatchObject({ status: 'down', faultClass: 'network' })
  })

  it('never leaks the service token into the detail payload', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 500 }))
    const result = await createHttpRunners({ fetch: impl, accessCredentials: creds }).external.run(
      external(), ctx,
    )
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/monitoring/http-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/monitoring/http-runner.ts`**

```ts
import { matchesStatusPattern } from './status-pattern.js'
import type { ProbeContext, ProbeResult, ProbeRow, ProbeRunner } from './types.js'

/** Enough of the body to recognise a Cloudflare error page, and no more. */
const BODY_SAMPLE_BYTES = 2048

type AccessCredentials = { clientId: string; clientSecret: string }

function classifyThrown(error: unknown): ProbeResult {
  const message = error instanceof Error ? error.message : String(error)
  // DNS is a configuration mistake — a hostname that does not exist. A refused
  // connection or a timeout is the network. The distinction is the whole point of
  // faultClass: it decides whether the UI says "check the address" or "the tunnel is down".
  const isDns = /ENOTFOUND|EAI_AGAIN/i.test(message)
  const isTimeout = /abort|timeout/i.test(message)
  return {
    status: 'down',
    faultClass: isDns ? 'config' : 'network',
    detail: { error: isTimeout ? 'timed out' : isDns ? 'host does not resolve' : 'unreachable' },
  }
}

/**
 * Reads at most `BODY_SAMPLE_BYTES` and then stops the transfer.
 *
 * `response.text()` would buffer the WHOLE body before slicing, so an origin behind the
 * tunnel that answers a 5xx with a gigabyte would be read in full — every 60 seconds,
 * for the life of the probe. Streaming and cancelling bounds what crosses the wire, not
 * just what we keep.
 */
async function sampleBody(response: Response): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < BODY_SAMPLE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } catch {
    // A truncated or broken body is not worth failing the classification over.
  } finally {
    // Stops the transfer rather than merely ignoring the rest of it.
    await reader.cancel().catch(() => {})
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  // Decode everything we read, deliberately WITHOUT slicing to the cap.
  //
  // The loop already stopped once `total` reached the cap, so memory is bounded by the
  // cap plus one chunk either way — the slice bounded nothing extra. What it did do was
  // cut a marker that straddled the boundary: a body of 2047 filler bytes followed by
  // "1033" decoded as "…1", `includes('1033')` failed, and a tunnel outage was reported
  // as an application fault.
  return new TextDecoder().decode(joined)
}

export function createHttpRunners(deps: {
  fetch: typeof fetch
  accessCredentials?: () => Promise<AccessCredentials | null>
}): { internal: ProbeRunner; external: ProbeRunner } {
  async function request(
    probe: ProbeRow,
    headers: Record<string, string>,
  ): Promise<{ response: Response; latencyMs: number } | { failure: ProbeResult }> {
    if (!probe.target) {
      return { failure: { status: 'down', faultClass: 'config', detail: { error: 'no target' } } }
    }
    // Scheme-check here as well as at the API. The probe API rejects a non-http(s) target
    // when the user types it, but this is the code that actually makes the request, and a
    // row can reach it by other routes — a migration, an import, a direct database edit.
    // The component that performs the fetch is the right place to refuse a scheme it
    // should never fetch.
    let parsed: URL
    try {
      parsed = new URL(probe.target)
    } catch {
      return { failure: { status: 'down', faultClass: 'config', detail: { error: 'target is not a URL' } } }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        failure: { status: 'down', faultClass: 'config', detail: { error: 'target must be http or https' } },
      }
    }

    const startedAt = Date.now()
    try {
      const response = await deps.fetch(probe.target, {
        method: 'GET',
        headers,
        // Load-bearing. Access rejects by redirecting to a login page that returns 200,
        // so a monitor that follows redirects reports a dead origin as healthy forever.
        redirect: 'manual',
        signal: AbortSignal.timeout(probe.timeoutMs),
      })
      return { response, latencyMs: Date.now() - startedAt }
    } catch (error) {
      return { failure: classifyThrown(error) }
    }
  }

  const internal: ProbeRunner = {
    kind: 'http_internal',
    // The default pattern accepts 3xx, which the spec specifies. That is right here and
    // not the blind spot the external classification exists to close: an app redirecting
    // to its own login page is reachable, which is all an internal probe asks. Access
    // redirecting to *its* login page is an interception by something that is not the
    // app, which is why only the external runner inspects the destination.
    async run(probe: ProbeRow, _ctx: ProbeContext): Promise<ProbeResult> {
      const attempt = await request(probe, {})
      if ('failure' in attempt) return attempt.failure

      const { response, latencyMs } = attempt
      const ok = matchesStatusPattern(probe.expectedStatusPattern, response.status)
      return {
        status: ok ? 'up' : 'down',
        latencyMs,
        ...(ok ? {} : { faultClass: 'app' as const }),
        detail: { status: response.status },
      }
    },
  }

  const external: ProbeRunner = {
    kind: 'http_external',
    async run(probe: ProbeRow, _ctx: ProbeContext): Promise<ProbeResult> {
      const credentials = (await deps.accessCredentials?.()) ?? null
      if (!credentials) {
        // Every request would land on the login page. "Up" would be a lie and "down"
        // would blame the app for a missing service token.
        return {
          status: 'degraded',
          faultClass: 'config',
          detail: { error: 'no Access service token configured' },
        }
      }

      const attempt = await request(probe, {
        'cf-access-client-id': credentials.clientId,
        'cf-access-client-secret': credentials.clientSecret,
      })
      if ('failure' in attempt) return attempt.failure

      const { response, latencyMs } = attempt
      const location = response.headers.get('location') ?? ''

      if (/\.cloudflareaccess\.com/i.test(location)) {
        return {
          status: 'degraded',
          faultClass: 'config',
          latencyMs,
          detail: { status: response.status, error: 'Access rejected the service token' },
        }
      }

      if (response.status === 502 || response.status === 503) {
        return {
          status: 'down',
          faultClass: 'network',
          latencyMs,
          detail: { status: response.status, error: 'tunnel or origin unreachable' },
        }
      }

      // Cloudflare reports tunnel failures as a 1033 in the body, sometimes under a 530.
      if (response.status >= 500) {
        const body = await sampleBody(response)
        if (body.includes('1033')) {
          return {
            status: 'down',
            faultClass: 'network',
            latencyMs,
            detail: { status: response.status, error: 'Argo Tunnel error 1033' },
          }
        }
        return {
          status: 'down',
          faultClass: 'app',
          latencyMs,
          detail: { status: response.status },
        }
      }

      const ok = matchesStatusPattern(probe.expectedStatusPattern, response.status)
      return {
        status: ok ? 'up' : 'down',
        latencyMs,
        ...(ok ? {} : { faultClass: 'app' as const }),
        detail: { status: response.status },
      }
    },
  }

  return { internal, external }
}
```

- [ ] **Step 4: Run it and commit**

```bash
pnpm exec vitest run src/server/monitoring/http-runner.test.ts && pnpm test
git add src/server/monitoring/http-runner.ts src/server/monitoring/http-runner.test.ts
git commit -m "Add HTTP probes that judge redirects instead of following them"
```

---

### Task 6: Persisting a result in one transaction

**Files:**
- Create: `src/server/monitoring/persist.ts`, `src/server/monitoring/persist.test.ts`

**Interfaces:**
- Consumes: `applyTransition` (Task 3), `ProbeResult` (Task 4).
- Produces:

```ts
export type PersistedTransition = {
  probeId: string
  appId: string
  status: 'up' | 'degraded' | 'down' | 'starting'
  faultClass: 'app' | 'network' | 'config' | null
  changed: boolean
}

export async function persistResult(
  db: Db,
  probe: ProbeRow,
  result: ProbeResult,
  opts: { now: number; graceUntil: number | null; failureThreshold: number },
): Promise<PersistedTransition>
```

Spec §5: "Each result writes `check_results` and updates the denormalised `probes` state in
**one transaction**." The denormalisation is only safe because there is exactly one writer and
the two writes cannot separate.

- [ ] **Step 1: Write the failing test**

`src/server/monitoring/persist.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { createDb, runMigrations } from '@server/db/client'
import { apps, checkResults, hosts, probes } from '@server/db/schema'
import { persistResult } from '@server/monitoring/persist'

async function seed() {
  const { db } = await createDb(':memory:')
  await runMigrations(db)
  await db.insert(hosts).values({ id: 'local', name: 'l', composeRoot: '/v', dockerSocket: '/s' })
  const appId = ulid()
  await db.insert(apps).values({
    id: appId, hostId: 'local', slug: 'j', displayName: 'J',
    directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
  })
  const probeId = ulid()
  await db.insert(probes).values({ id: probeId, appId, kind: 'docker' })
  const [probe] = await db.select().from(probes).where(eq(probes.id, probeId))
  if (!probe) throw new Error('seed failed')
  return { db, probe, appId }
}

const NOW = 1_800_000_000
const opts = { now: NOW, graceUntil: null, failureThreshold: 2 }

describe('persistResult', () => {
  it('writes a sample and the denormalised state together', async () => {
    const { db, probe } = await seed()
    const out = await persistResult(db, probe, { status: 'up', latencyMs: 12 }, opts)
    expect(out).toMatchObject({ status: 'up', changed: true })

    const [sample] = await db.select().from(checkResults)
    expect(sample).toMatchObject({ probeId: probe.id, status: 'up', latencyMs: 12 })

    const [updated] = await db.select().from(probes).where(eq(probes.id, probe.id))
    expect(updated).toMatchObject({
      lastStatus: 'up', lastLatencyMs: 12, consecutiveFailures: 0,
      lastCheckedAt: NOW, statusSince: NOW,
    })
  })

  it('reports changed only on a confirmed transition', async () => {
    const { db, probe } = await seed()
    await persistResult(db, probe, { status: 'up' }, opts)
    const [afterFirst] = await db.select().from(probes).where(eq(probes.id, probe.id))
    const second = await persistResult(db, afterFirst as never, { status: 'up' }, opts)
    expect(second.changed).toBe(false)
  })

  it('holds the previous status until the failure threshold is met', async () => {
    const { db, probe } = await seed()
    await persistResult(db, probe, { status: 'up' }, opts)
    const [up] = await db.select().from(probes).where(eq(probes.id, probe.id))
    const first = await persistResult(db, up as never, { status: 'down' }, opts)
    expect(first).toMatchObject({ status: 'up', changed: false })

    const [held] = await db.select().from(probes).where(eq(probes.id, probe.id))
    expect(held?.consecutiveFailures).toBe(1)
    const second = await persistResult(db, held as never, { status: 'down' }, opts)
    expect(second).toMatchObject({ status: 'down', changed: true })
  })

  it('records what was observed in the sample and the debounced status on the probe', async () => {
    // These deliberately differ. A probe flapping below the threshold never confirms a
    // transition, so samples holding the debounced status would record uninterrupted
    // `up` and uptime would read 100% for an app failing every other minute.
    const { db, probe } = await seed()
    await persistResult(db, probe, { status: 'up' }, opts)
    const [up] = await db.select().from(probes).where(eq(probes.id, probe.id))

    const transition = await persistResult(db, up as never, { status: 'down' }, opts)
    expect(transition.status).toBe('up') // held: one failure is not a confirmed outage

    const samples = await db.select().from(checkResults).orderBy(checkResults.checkedAt)
    expect(samples.map((s) => s.status)).toEqual(['up', 'down'])

    const [after] = await db.select().from(probes).where(eq(probes.id, probe.id))
    expect(after?.lastStatus).toBe('up')
  })

  it('stores the fault class and detail on both rows', async () => {
    const { db, probe } = await seed()
    await persistResult(
      db, probe,
      { status: 'down', faultClass: 'network', detail: { error: 'timed out' } },
      { ...opts, failureThreshold: 1 },
    )
    const [sample] = await db.select().from(checkResults)
    expect(sample).toMatchObject({ faultClass: 'network' })
    expect(sample?.detail).toEqual({ error: 'timed out' })
    const [updated] = await db.select().from(probes).where(eq(probes.id, probe.id))
    expect(updated?.lastFaultClass).toBe('network')
  })

  it('writes nothing at all when the transaction fails', async () => {
    // The denormalised copy is only trustworthy because it cannot separate from its
    // sample. A half-write would leave the launcher showing a status no sample supports.
    const { db, probe } = await seed()
    const original = db.update.bind(db)
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
    ;(db as any).update = () => {
      throw new Error('SQLITE_BUSY')
    }
    try {
      await expect(persistResult(db, probe, { status: 'up' }, opts)).rejects.toThrow('SQLITE_BUSY')
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      ;(db as any).update = original
    }
    expect(await db.select().from(checkResults)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/monitoring/persist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/monitoring/persist.ts`**

```ts
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Db } from '../db/client.js'
import { checkResults, probes } from '../db/schema.js'
import { applyTransition } from './transition.js'
import type { ProbeResult, ProbeRow } from './types.js'

export type PersistedTransition = {
  probeId: string
  appId: string
  status: 'up' | 'degraded' | 'down' | 'starting'
  faultClass: 'app' | 'network' | 'config' | null
  changed: boolean
}

/**
 * Writes the sample and the denormalised copy on the probe row **together**.
 *
 * The launcher reads the denormalised columns with one indexed query and no aggregation.
 * That is only safe because exactly one writer — the scheduler — maintains them, and
 * because these two writes cannot separate: a sample without its rollup, or a rollup
 * without its sample, is a status the timeline cannot explain.
 */
export async function persistResult(
  db: Db,
  probe: ProbeRow,
  result: ProbeResult,
  opts: { now: number; graceUntil: number | null; failureThreshold: number },
): Promise<PersistedTransition> {
  const transition = applyTransition({
    state: {
      lastStatus: probe.lastStatus,
      consecutiveFailures: probe.consecutiveFailures,
      statusSince: probe.statusSince,
    },
    observed: result.status,
    now: opts.now,
    graceUntil: opts.graceUntil,
    failureThreshold: opts.failureThreshold,
  })

  await db.transaction(async (tx) => {
    // The SAMPLE records what was OBSERVED, not the debounced status.
    //
    // Spec §3 calls `check_results` "every sample", and that is what makes 48 hours of
    // raw data worth keeping: a probe flapping fail/recover/fail/recover never confirms
    // a transition, so storing the held status would record it as uninterrupted `up` and
    // uptime would read 100% for an app failing every other minute. The debounced view
    // — the one the launcher shows — lives on the probe row below.
    //
    // A consequence worth knowing: a deploy's grace window shows `starting` on the probe
    // row while the samples record the `down` that was actually observed, so a restart
    // does count against uptime. That is honest — the app was unreachable — and the
    // rollup has only up/degraded/down buckets, so there is nowhere to put `starting`.
    await tx.insert(checkResults).values({
      id: ulid(),
      probeId: probe.id,
      status: result.status,
      faultClass: result.faultClass ?? null,
      latencyMs: result.latencyMs ?? null,
      detail: result.detail ?? null,
      checkedAt: opts.now,
    })

    await tx
      .update(probes)
      .set({
        lastStatus: transition.status,
        lastLatencyMs: result.latencyMs ?? null,
        lastDetail: result.detail ?? null,
        lastFaultClass: result.faultClass ?? null,
        lastCheckedAt: opts.now,
        statusSince: transition.statusSince,
        consecutiveFailures: transition.consecutiveFailures,
      })
      .where(eq(probes.id, probe.id))
  })

  return {
    probeId: probe.id,
    appId: probe.appId,
    status: transition.status,
    faultClass: result.faultClass ?? null,
    changed: transition.changed,
  }
}
```

- [ ] **Step 4: Run it and commit**

```bash
pnpm exec vitest run src/server/monitoring/persist.test.ts && pnpm test
git add src/server/monitoring/persist.ts src/server/monitoring/persist.test.ts
git commit -m "Write each probe sample and its denormalised copy in one transaction"
```

---

### Task 7: The scheduler

**Files:**
- Create: `src/server/monitoring/scheduler.ts`, `src/server/monitoring/scheduler.test.ts`
- Modify: `src/server/app.ts`, `src/server/index.ts`, `src/server/test-helpers.ts`

**Interfaces:**
- Consumes: the runners, `persistResult`, `Host.listContainers`.
- Produces:

```ts
export class Scheduler {
  constructor(deps: {
    db: Db
    host: Host
    composeConfig: ComposeConfigCache
    runners: Record<ProbeRow['kind'], ProbeRunner>
    now?: () => number
    random?: () => number
  })
  /** Runs every probe that is due. Never throws. Returns how many it ran. */
  tick(): Promise<number>
  start(): void
  stop(): void
}
```

Spec §5: "An in-process tick every 5s selects probes where `nextRunAt <= now`, runs them through
a concurrency limiter (~8), and sets `nextRunAt = now + intervalSeconds ± 10% jitter`."

Jitter matters for a specific reason worth keeping in the code: sixty probes created in one
adoption pass would otherwise fire in the same second forever.

- [ ] **Step 1: Write the failing test**

`src/server/monitoring/scheduler.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { ComposeConfigCache } from '@server/apps/compose-config'
import { Scheduler } from '@server/monitoring/scheduler'
import { createDb, runMigrations } from '@server/db/client'
import { apps, checkResults, hosts, probes } from '@server/db/schema'
import { FakeHost } from '@server/test-helpers'
import type { ProbeResult, ProbeRunner } from '@server/monitoring/types'

const NOW = 1_800_000_000

function stubRunner(kind: ProbeRunner['kind'], result: ProbeResult, log: string[]): ProbeRunner {
  return {
    kind,
    async run(probe) {
      log.push(probe.id)
      return result
    },
  }
}

async function seed(probeCount: number, over: Record<string, unknown> = {}) {
  const { db } = await createDb(':memory:')
  await runMigrations(db)
  await db.insert(hosts).values({ id: 'local', name: 'l', composeRoot: '/v', dockerSocket: '/s' })
  const appId = ulid()
  await db.insert(apps).values({
    id: appId, hostId: 'local', slug: 'j', displayName: 'J',
    directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
  })
  const ids: string[] = []
  for (let i = 0; i < probeCount; i++) {
    const id = ulid()
    ids.push(id)
    await db.insert(probes).values({ id, appId, kind: 'docker', nextRunAt: 0, ...over })
  }
  const host = new FakeHost()
  host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  return { db, host, appId, ids }
}

function build(db: Awaited<ReturnType<typeof seed>>['db'], host: FakeHost, log: string[]) {
  return new Scheduler({
    db, host,
    composeConfig: new ComposeConfigCache(host),
    runners: {
      docker: stubRunner('docker', { status: 'up' }, log),
      http_internal: stubRunner('http_internal', { status: 'up' }, log),
      http_external: stubRunner('http_external', { status: 'up' }, log),
    },
    now: () => NOW,
    random: () => 0.5, // no jitter offset
  })
}

describe('Scheduler.tick', () => {
  it('runs due probes and reschedules them with the interval', async () => {
    const { db, host, ids } = await seed(1, { intervalSeconds: 60 })
    const log: string[] = []
    expect(await build(db, host, log).tick()).toBe(1)
    expect(log).toEqual(ids)
    const [probe] = await db.select().from(probes).where(eq(probes.id, ids[0] ?? ''))
    expect(probe?.nextRunAt).toBe(NOW + 60)
    expect(await db.select().from(checkResults)).toHaveLength(1)
  })

  it('skips probes that are not due yet', async () => {
    const { db, host } = await seed(1, { nextRunAt: NOW + 30 })
    const log: string[] = []
    expect(await build(db, host, log).tick()).toBe(0)
    expect(log).toEqual([])
  })

  it('skips disabled probes', async () => {
    const { db, host } = await seed(1, { enabled: false })
    const log: string[] = []
    expect(await build(db, host, log).tick()).toBe(0)
  })

  it('applies jitter within ±10% of the interval', async () => {
    const { db, host, ids } = await seed(1, { intervalSeconds: 100 })
    const log: string[] = []
    const scheduler = new Scheduler({
      db, host, composeConfig: new ComposeConfigCache(host),
      runners: {
        docker: stubRunner('docker', { status: 'up' }, log),
        http_internal: stubRunner('http_internal', { status: 'up' }, log),
        http_external: stubRunner('http_external', { status: 'up' }, log),
      },
      now: () => NOW,
      random: () => 1, // maximum positive jitter
    })
    await scheduler.tick()
    const [probe] = await db.select().from(probes).where(eq(probes.id, ids[0] ?? ''))
    expect(probe?.nextRunAt).toBe(NOW + 110)
  })

  it('takes ONE container snapshot for the whole tick', async () => {
    // Sixty apps must not mean sixty Engine API calls every minute.
    const { db, host } = await seed(5)
    const log: string[] = []
    host.listContainersCalls = 0
    await build(db, host, log).tick()
    expect(log).toHaveLength(5)
    expect(host.listContainersCalls).toBe(1)
  })

  it('never runs more than the concurrency limit at once', async () => {
    const { db, host } = await seed(20)
    let inFlight = 0
    let peak = 0
    const slow: ProbeRunner = {
      kind: 'docker',
      async run() {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        return { status: 'up' }
      },
    }
    const scheduler = new Scheduler({
      db, host, composeConfig: new ComposeConfigCache(host),
      runners: { docker: slow, http_internal: slow, http_external: slow },
      now: () => NOW, random: () => 0.5,
    })
    await scheduler.tick()
    expect(peak).toBeLessThanOrEqual(8)
  })

  it('reschedules a probe whose runner throws, and keeps going', async () => {
    // One broken probe must not stop the tick or wedge itself into running every 5s
    // forever.
    const { db, host, ids } = await seed(2)
    const exploding: ProbeRunner = {
      kind: 'docker',
      async run(probe) {
        if (probe.id === ids[0]) throw new Error('runner exploded')
        return { status: 'up' }
      },
    }
    const scheduler = new Scheduler({
      db, host, composeConfig: new ComposeConfigCache(host),
      runners: { docker: exploding, http_internal: exploding, http_external: exploding },
      now: () => NOW, random: () => 0.5,
    })
    await expect(scheduler.tick()).resolves.toBe(2)
    const [broken] = await db.select().from(probes).where(eq(probes.id, ids[0] ?? ''))
    expect(broken?.nextRunAt).toBeGreaterThan(NOW)
    expect(broken?.lastStatus).toBe('unknown')
  })

  it('passes null for the snapshot when Docker is unreachable', async () => {
    const { db, host } = await seed(1)
    host.listContainers = async () => {
      throw new Error('connect ENOENT')
    }
    let seen: unknown = 'not called'
    const capturing: ProbeRunner = {
      kind: 'docker',
      async run(_probe, ctx) {
        seen = ctx.containers
        return { status: 'down', faultClass: 'network' }
      },
    }
    const scheduler = new Scheduler({
      db, host, composeConfig: new ComposeConfigCache(host),
      runners: { docker: capturing, http_internal: capturing, http_external: capturing },
      now: () => NOW, random: () => 0.5,
    })
    await scheduler.tick()
    expect(seen).toBeNull()
  })

  it('stop() clears its timer', async () => {
    const { db, host } = await seed(0)
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    const before = timers()
    const scheduler = build(db, host, [])
    scheduler.start()
    expect(timers()).toBeGreaterThan(before)
    scheduler.stop()
    expect(timers()).toBe(before)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/monitoring/scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/monitoring/scheduler.ts`**

```ts
import { and, eq, lte } from 'drizzle-orm'
import type { ComposeConfigCache } from '../apps/compose-config.js'
import type { Db } from '../db/client.js'
import { apps, probes } from '../db/schema.js'
import type { ContainerSummary, Host } from '../host/types.js'
import { persistResult, type PersistedTransition } from './persist.js'
import type { ProbeRow, ProbeRunner } from './types.js'

const TICK_MS = 5_000
const CONCURRENCY = 8
const JITTER_FRACTION = 0.1
const FAILURE_THRESHOLD = 2

export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly listeners = new Set<(t: PersistedTransition) => void>()

  constructor(
    private readonly deps: {
      db: Db
      host: Host
      composeConfig: ComposeConfigCache
      runners: Record<ProbeRow['kind'], ProbeRunner>
      now?: () => number
      random?: () => number
    },
  ) {}

  /** Transitions only. The SSE route subscribes; nothing else should need this. */
  onTransition(listener: (t: PersistedTransition) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    // Do not hold the process open for the sake of the monitor.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Runs every due probe. Never throws.
   *
   * A tick that throws would be swallowed by `setInterval`'s void call and vanish, so the
   * guarantee is not decoration: it is what keeps a single malformed probe row from
   * silently stopping all monitoring.
   */
  async tick(): Promise<number> {
    // A slow tick must not overlap itself. This is also what makes `persistResult` safe:
    // it computes the transition from a `ProbeRow` read earlier in the tick, so two
    // concurrent runs of one probe would both start from the same
    // `consecutiveFailures` and each write 1 where the second should write 2. One tick
    // at a time, and each probe appearing once per tick, is what prevents that.
    if (this.ticking) return 0
    this.ticking = true
    try {
      const now = this.now()
      const due = await this.deps.db
        .select()
        .from(probes)
        .where(and(eq(probes.enabled, true), lte(probes.nextRunAt, now)))

      if (due.length === 0) return 0

      // One snapshot for every docker probe in this tick. Sixty apps must not mean sixty
      // Engine API calls a minute. `null` means the call failed, which the runner reports
      // as a network fault rather than blaming every app at once.
      let containers: ContainerSummary[] | null = null
      if (due.some((probe) => probe.kind === 'docker')) {
        try {
          // No filter: the whole host in one call. `LocalHost` already asks Docker for
          // stopped containers too, which the rollup needs to report a service as down.
          containers = await this.deps.host.listContainers()
        } catch {
          containers = null
        }
      }

      await this.runAll(due, containers, now)
      return due.length
    } catch {
      return 0
    } finally {
      this.ticking = false
    }
  }

  private async runAll(
    due: ProbeRow[],
    containers: ContainerSummary[] | null,
    now: number,
  ): Promise<void> {
    const queue = [...due]
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const probe = queue.shift()
        if (!probe) return
        await this.runOne(probe, containers, now)
      }
    })
    await Promise.all(workers)
  }

  private async runOne(
    probe: ProbeRow,
    containers: ContainerSummary[] | null,
    now: number,
  ): Promise<void> {
    // Reschedule FIRST, in its own statement, so a probe whose runner throws does not
    // stay due and get retried every 5 seconds forever.
    await this.reschedule(probe, now)

    try {
      const [app] = await this.deps.db.select().from(apps).where(eq(apps.id, probe.appId))
      if (!app) return

      const runner = this.deps.runners[probe.kind]
      const result = await runner.run(probe, {
        app,
        containers,
        deps: { host: this.deps.host, composeConfig: this.deps.composeConfig },
      })

      const transition = await persistResult(this.deps.db, probe, result, {
        now,
        graceUntil: app.graceUntil,
        failureThreshold: FAILURE_THRESHOLD,
      })

      if (transition.changed) {
        for (const listener of this.listeners) {
          try {
            listener(transition)
          } catch {
            // A subscriber's failure is not the scheduler's problem, and must not stop
            // the remaining subscribers or the tick.
          }
        }
      }
    } catch {
      // One probe's failure ends that probe's turn, not the tick.
    }
  }

  private async reschedule(probe: ProbeRow, now: number): Promise<void> {
    // ±10%. Sixty probes created in one adoption pass would otherwise fire in the same
    // second, forever.
    const spread = probe.intervalSeconds * JITTER_FRACTION
    const offset = (this.random() * 2 - 1) * spread
    const nextRunAt = Math.round(now + probe.intervalSeconds + offset)
    await this.deps.db.update(probes).set({ nextRunAt }).where(eq(probes.id, probe.id))
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000)
  }

  private random(): number {
    return this.deps.random?.() ?? Math.random()
  }
}
```

- [ ] **Step 4: Wire it**

`AppDeps` gains `scheduler: Scheduler`. Construct it in `index.ts` with the real runners
(`createHttpRunners({ fetch })`) and call `scheduler.start()` after `buildApp`. In
`test-helpers.ts` construct it but **do not** start it — a ticking scheduler in the test suite
is a source of exactly the flakiness this project has already paid for.

- [ ] **Step 5: Run everything and commit**

```bash
pnpm exec vitest run src/server/monitoring/scheduler.test.ts && pnpm test && pnpm exec tsc --noEmit
git add src/server/monitoring/scheduler.ts src/server/monitoring/scheduler.test.ts src/server/app.ts src/server/index.ts src/server/test-helpers.ts
git commit -m "Add the probe scheduler with a shared snapshot and jittered rescheduling"
```

---

### Task 8: Retention — hourly rollup, pruning, startup catch-up

**Files:**
- Create: `src/server/monitoring/retention.ts`, `src/server/monitoring/retention.test.ts`

**Interfaces:**
- Produces:

```ts
export const RAW_RETENTION_HOURS = 48
export const ROLLUP_RETENTION_DAYS = 90

/** Aggregates every complete hour that has no rollup yet, then prunes. Never throws. */
export async function runRetention(db: Db, now: number): Promise<{ hoursRolled: number }>
```

Spec §3: 20 apps × 3 probes at 60s is ~2.6M rows a month, so raw samples last 48 hours and
hourly rollups last 90 days. Spec §5: the job "catches up on startup after downtime" — which is
why it aggregates *every* un-rolled complete hour rather than only the previous one.

- [ ] **Step 1: Write the failing test**

`src/server/monitoring/retention.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { createDb, runMigrations } from '@server/db/client'
import { apps, checkResults, checkRollups, hosts, probes } from '@server/db/schema'
import { runRetention } from '@server/monitoring/retention'

const HOUR = 3600
/** A round hour boundary, so the arithmetic in the test is obvious. */
const T0 = 1_800_000_000 - (1_800_000_000 % HOUR)

async function seed() {
  const { db } = await createDb(':memory:')
  await runMigrations(db)
  await db.insert(hosts).values({ id: 'local', name: 'l', composeRoot: '/v', dockerSocket: '/s' })
  const appId = ulid()
  await db.insert(apps).values({
    id: appId, hostId: 'local', slug: 'j', displayName: 'J',
    directory: 'jellyfin', composeFile: 'compose.yaml', projectName: 'jellyfin',
  })
  const probeId = ulid()
  await db.insert(probes).values({ id: probeId, appId, kind: 'docker' })
  return { db, probeId }
}

const sample = (probeId: string, checkedAt: number, status: string, latencyMs?: number) => ({
  id: ulid(), probeId, status: status as never, checkedAt,
  latencyMs: latencyMs ?? null, faultClass: null, detail: null,
})

describe('runRetention', () => {
  it('aggregates a complete hour into one rollup row', async () => {
    const { db, probeId } = await seed()
    await db.insert(checkResults).values([
      sample(probeId, T0 + 10, 'up', 10),
      sample(probeId, T0 + 20, 'up', 30),
      sample(probeId, T0 + 30, 'down'),
      sample(probeId, T0 + 40, 'degraded'),
    ])
    const out = await runRetention(db, T0 + HOUR + 60)
    expect(out.hoursRolled).toBe(1)

    const [rollup] = await db.select().from(checkRollups)
    expect(rollup).toMatchObject({
      probeId, hourStart: T0, upCount: 2, downCount: 1, degradedCount: 1,
      avgLatencyMs: 20, maxLatencyMs: 30,
    })
  })

  it('does not roll up the hour still in progress', async () => {
    const { db, probeId } = await seed()
    await db.insert(checkResults).values([sample(probeId, T0 + 10, 'up')])
    // We are inside T0's hour, so it is incomplete.
    expect((await runRetention(db, T0 + 60)).hoursRolled).toBe(0)
    expect(await db.select().from(checkRollups)).toHaveLength(0)
  })

  it('catches up several hours after downtime', async () => {
    // The job runs hourly, but the machine may have been off. Rolling only the previous
    // hour would silently lose everything older.
    const { db, probeId } = await seed()
    await db.insert(checkResults).values([
      sample(probeId, T0 + 10, 'up'),
      sample(probeId, T0 + HOUR + 10, 'up'),
      sample(probeId, T0 + 2 * HOUR + 10, 'down'),
    ])
    expect((await runRetention(db, T0 + 3 * HOUR + 60)).hoursRolled).toBe(3)
    expect(await db.select().from(checkRollups)).toHaveLength(3)
  })

  it('is idempotent — running twice does not double-count', async () => {
    const { db, probeId } = await seed()
    await db.insert(checkResults).values([sample(probeId, T0 + 10, 'up')])
    await runRetention(db, T0 + HOUR + 60)
    await runRetention(db, T0 + HOUR + 60)
    const rows = await db.select().from(checkRollups)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.upCount).toBe(1)
  })

  it('prunes raw samples older than 48 hours but keeps newer ones', async () => {
    const { db, probeId } = await seed()
    const now = T0 + 100 * HOUR
    await db.insert(checkResults).values([
      sample(probeId, now - 49 * HOUR, 'up'),
      sample(probeId, now - 47 * HOUR, 'up'),
    ])
    await runRetention(db, now)
    const remaining = await db.select().from(checkResults)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.checkedAt).toBe(now - 47 * HOUR)
  })

  it('prunes rollups older than 90 days', async () => {
    const { db, probeId } = await seed()
    const now = T0 + 200 * 24 * HOUR
    await db.insert(checkRollups).values([
      { probeId, hourStart: now - 91 * 24 * HOUR, upCount: 1 },
      { probeId, hourStart: now - 89 * 24 * HOUR, upCount: 1 },
    ])
    await runRetention(db, now)
    const remaining = await db.select().from(checkRollups)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.hourStart).toBe(now - 89 * 24 * HOUR)
  })

  it('rolls up before pruning, so a 49-hour-old sample is not lost unaggregated', async () => {
    // Ordering matters: prune first and the oldest hour vanishes without ever being
    // summarised, leaving a hole in the 30-day timeline.
    const { db, probeId } = await seed()
    const now = T0 + 50 * HOUR
    await db.insert(checkResults).values([sample(probeId, T0 + 10, 'up')])
    await runRetention(db, now)
    expect(await db.select().from(checkResults)).toHaveLength(0)
    const [rollup] = await db.select().from(checkRollups).where(eq(checkRollups.probeId, probeId))
    expect(rollup?.upCount).toBe(1)
  })

  it('does not throw when the database rejects a write', async () => {
    const { db } = await seed()
    const original = db.insert.bind(db)
    // biome-ignore lint/suspicious/noExplicitAny: narrow test double over one method
    ;(db as any).insert = () => {
      throw new Error('SQLITE_BUSY')
    }
    try {
      await expect(runRetention(db, T0 + HOUR + 60)).resolves.toMatchObject({ hoursRolled: 0 })
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      ;(db as any).insert = original
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/monitoring/retention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/monitoring/retention.ts`**

```ts
import { lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { checkResults, checkRollups } from '../db/schema.js'

const HOUR = 3600
export const RAW_RETENTION_HOURS = 48
export const ROLLUP_RETENTION_DAYS = 90

/**
 * Aggregates every complete hour that has no rollup yet, then prunes both tiers.
 *
 * "Every un-rolled hour", not "the previous hour", because the machine may have been off:
 * this is the startup catch-up the spec asks for and the hourly job at the same time.
 *
 * Rolling up strictly BEFORE pruning is load-bearing. Reversed, a sample older than the
 * raw window is deleted before it is ever summarised, and the 30-day timeline gets a hole
 * that nothing can fill afterwards.
 *
 * Never throws: this runs on a timer whose rejection would vanish.
 */
export async function runRetention(db: Db, now: number): Promise<{ hoursRolled: number }> {
  let hoursRolled = 0
  try {
    const currentHourStart = now - (now % HOUR)

    // One statement: bucket every sample from a complete hour that has no rollup row yet.
    // `INSERT … SELECT … WHERE NOT EXISTS` keeps it idempotent, so a second run in the
    // same hour changes nothing.
    const inserted = await db.run(sql`
      INSERT INTO check_rollups (probe_id, hour_start, up_count, degraded_count, down_count, avg_latency_ms, max_latency_ms)
      SELECT
        probe_id,
        checked_at - (checked_at % ${HOUR}) AS hour_start,
        SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END),
        CAST(AVG(latency_ms) AS INTEGER),
        MAX(latency_ms)
      FROM check_results
      WHERE checked_at < ${currentHourStart}
      GROUP BY probe_id, hour_start
      HAVING NOT EXISTS (
        SELECT 1 FROM check_rollups r
        WHERE r.probe_id = check_results.probe_id AND r.hour_start = hour_start
      )
    `)
    hoursRolled = Number(inserted.rowsAffected ?? 0)

    await db.delete(checkResults).where(lt(checkResults.checkedAt, now - RAW_RETENTION_HOURS * HOUR))
    await db
      .delete(checkRollups)
      .where(lt(checkRollups.hourStart, now - ROLLUP_RETENTION_DAYS * 24 * HOUR))
  } catch {
    // A retention failure is a disk-space problem for tomorrow, not a reason to take the
    // timer down today.
  }
  return { hoursRolled }
}
```

- [ ] **Step 4: Run it and commit**

```bash
pnpm exec vitest run src/server/monitoring/retention.test.ts && pnpm test
git add src/server/monitoring/retention.ts src/server/monitoring/retention.test.ts
git commit -m "Roll samples into hourly buckets before pruning them"
```

---

### Task 9: Probe CRUD, and a docker probe on adoption

**Files:**
- Create: `src/server/routes/probes.ts`, `src/server/routes/probes.test.ts`
- Modify: `src/server/routes/apps.ts`, `src/server/app.ts`

**Interfaces:**
- Produces: `GET /api/apps/:id/probes`, `POST /api/apps/:id/probes`, `PATCH /api/probes/:probeId`, `DELETE /api/probes/:probeId`, `GET /api/apps/:id/probes/suggestions`.

Spec §3: "One `docker` probe per app, created on adoption. Zero or more `http_internal` probes,
user-configured. Multiple are supported deliberately: an \*arr stack has four web UIs and one
URL per app under-reports it." And: "Probe creation suggests targets from the compose file's
published ports."

Configuration requires `app:config`. **Viewers get 403 from every route here** — a probe's
`target` is an internal URL and its `lastDetail` can carry response fragments. Viewers see
status through the app DTO, which is Task 10's business.

- [ ] **Step 1: Write the failing test**

`src/server/routes/probes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp, createViewer, signUpAdmin } from '@server/test-helpers'

const CONFIG = JSON.stringify({
  name: 'jellyfin',
  services: {
    web: { image: 'nginx', ports: [{ published: '8096' }] },
    admin: { image: 'nginx', ports: [{ published: '9000' }] },
  },
})

async function withApp() {
  const app = await buildTestApp()
  const { cookie } = await signUpAdmin(app)
  app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  app.deps.host.composeResults.set('config --format json', {
    exitCode: 0, stdout: CONFIG, stderr: '',
  })
  const adopted = await app.inject({
    method: 'POST', url: '/api/apps/adopt', headers: { cookie },
    payload: { directories: ['jellyfin'] },
  })
  return { app, cookie, id: adopted.json().adopted[0].id as string }
}

describe('probe routes', () => {
  it('creates a docker probe when an app is adopted', async () => {
    const { app, cookie, id } = await withApp()
    const res = await app.inject({ method: 'GET', url: `/api/apps/${id}/probes`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0]).toMatchObject({ kind: 'docker', enabled: true })
    await app.close()
  })

  it('suggests internal targets from the published ports', async () => {
    const { app, cookie, id } = await withApp()
    const res = await app.inject({
      method: 'GET', url: `/api/apps/${id}/probes/suggestions`, headers: { cookie },
    })
    expect(res.json().map((s: { target: string }) => s.target)).toEqual([
      'http://localhost:8096', 'http://localhost:9000',
    ])
    await app.close()
  })

  it('accepts several internal probes for one app', async () => {
    // An *arr stack has four web UIs; one URL per app under-reports it.
    const { app, cookie, id } = await withApp()
    for (const target of ['http://localhost:8096', 'http://localhost:9000']) {
      const res = await app.inject({
        method: 'POST', url: `/api/apps/${id}/probes`, headers: { cookie },
        payload: { kind: 'http_internal', target, label: target },
      })
      expect(res.statusCode).toBe(201)
    }
    const list = await app.inject({ method: 'GET', url: `/api/apps/${id}/probes`, headers: { cookie } })
    expect(list.json()).toHaveLength(3) // the docker probe plus two
    await app.close()
  })

  it('refuses a second docker probe for one app', async () => {
    const { app, cookie, id } = await withApp()
    const res = await app.inject({
      method: 'POST', url: `/api/apps/${id}/probes`, headers: { cookie },
      payload: { kind: 'docker' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('probe_exists')
    await app.close()
  })

  it('requires a target for an http probe', async () => {
    const { app, cookie, id } = await withApp()
    const res = await app.inject({
      method: 'POST', url: `/api/apps/${id}/probes`, headers: { cookie },
      payload: { kind: 'http_internal' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('rejects a target that is not http or https', async () => {
    // The target is fetched by the server. A `file:` or `gopher:` target is an SSRF
    // primitive dressed as a health check.
    const { app, cookie, id } = await withApp()
    for (const target of ['file:///etc/passwd', 'gopher://x', 'javascript:alert(1)']) {
      const res = await app.inject({
        method: 'POST', url: `/api/apps/${id}/probes`, headers: { cookie },
        payload: { kind: 'http_internal', target },
      })
      expect(res.statusCode, target).toBe(400)
    }
    await app.close()
  })

  it('updates and deletes a probe', async () => {
    const { app, cookie, id } = await withApp()
    const created = await app.inject({
      method: 'POST', url: `/api/apps/${id}/probes`, headers: { cookie },
      payload: { kind: 'http_internal', target: 'http://localhost:8096' },
    })
    const probeId = created.json().id
    const patched = await app.inject({
      method: 'PATCH', url: `/api/probes/${probeId}`, headers: { cookie },
      payload: { intervalSeconds: 120, enabled: false },
    })
    expect(patched.json()).toMatchObject({ intervalSeconds: 120, enabled: false })
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/probes/${probeId}`, headers: { cookie } }))
        .statusCode,
    ).toBe(204)
    await app.close()
  })

  it('refuses a viewer everywhere', async () => {
    // A probe's target is an internal URL and its detail can carry response fragments.
    const { app, cookie, id } = await withApp()
    const viewer = await createViewer(app, cookie)
    const probeId = (await app.inject({ method: 'GET', url: `/api/apps/${id}/probes`, headers: { cookie } }))
      .json()[0].id
    const attempts: Array<[string, string]> = [
      ['GET', `/api/apps/${id}/probes`],
      ['GET', `/api/apps/${id}/probes/suggestions`],
      ['POST', `/api/apps/${id}/probes`],
      ['PATCH', `/api/probes/${probeId}`],
      ['DELETE', `/api/probes/${probeId}`],
    ]
    for (const [method, url] of attempts) {
      const res = await app.inject({
        method: method as never, url, headers: { cookie: viewer.cookie },
        payload: { kind: 'http_internal', target: 'http://x' },
      })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    await app.close()
  })

  it('returns 404 for a probe on an app outside the caller\'s scope', async () => {
    const { app, cookie, id } = await withApp()
    const probeId = (await app.inject({ method: 'GET', url: `/api/apps/${id}/probes`, headers: { cookie } }))
      .json()[0].id
    await app.inject({
      method: 'POST', url: '/api/users', headers: { cookie },
      payload: {
        email: 'scoped@example.com', password: 'correct-horse-battery', name: 'S',
        role: 'admin', scopeAllApps: false, appIds: [],
      },
    })
    const signIn = await app.inject({
      method: 'POST', url: '/api/auth/sign-in/email',
      payload: { email: 'scoped@example.com', password: 'correct-horse-battery' },
    })
    const scoped = String(signIn.headers['set-cookie'] ?? '').split(';')[0] ?? ''
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/probes/${probeId}`, headers: { cookie: scoped }, payload: { enabled: false } }))
        .statusCode,
    ).toBe(404)
    await app.close()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/routes/probes.test.ts`
Expected: FAIL — routes not found.

- [ ] **Step 3: Write `src/server/routes/probes.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ulid } from 'ulid'
import { z } from 'zod'
import { requireCapability } from '../auth/context.js'
import { probes } from '../db/schema.js'
import { isValidStatusPattern } from '../monitoring/status-pattern.js'
import { loadApp } from './apps.js'

/** The server fetches this URL. Anything but http(s) is an SSRF primitive. */
const targetSchema = z.string().refine((value) => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}, 'target must be an http or https URL')

const createBody = z
  .object({
    kind: z.enum(['docker', 'http_internal', 'http_external']),
    target: targetSchema.optional(),
    label: z.string().min(1).optional(),
    // Validated here, not just matched at runtime. The matcher fails closed, so `2x`
    // silently takes the app red with nothing saying the pattern is the problem.
    expectedStatusPattern: z.string().refine(isValidStatusPattern, 'not a status pattern').optional(),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
    intervalSeconds: z.number().int().min(10).max(86_400).optional(),
    // Not accepted while it does nothing. Node's `fetch` has no per-request TLS option,
    // so the runner cannot honour this, and a switch that silently has no effect is worse
    // than an absent one: a user with a self-signed LAN certificate would turn it on,
    // watch the probe keep failing, and have no way to tell why.
    insecureTls: z.literal(false).optional(),
  })
  .refine((body) => body.kind === 'docker' || body.target !== undefined, {
    message: 'an http probe needs a target',
  })

/**
 * Configuration only — never the denormalised state columns.
 *
 * `lastStatus`, `statusSince`, `consecutiveFailures` and their siblings have exactly one
 * writer, `persistResult`, and that is the whole reason the launcher can read them with
 * one indexed query and no aggregation. A second writer here would desynchronise them
 * from `check_results` silently.
 */
const patchBody = z.object({
  label: z.string().min(1).nullable().optional(),
  target: targetSchema.optional(),
  expectedStatusPattern: z.string().refine(isValidStatusPattern, 'not a status pattern').optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  intervalSeconds: z.number().int().min(10).max(86_400).optional(),
  insecureTls: z.literal(false).optional(),
  enabled: z.boolean().optional(),
})

export async function probeRoutes(app: FastifyInstance): Promise<void> {
  const { db, composeConfig } = app.deps

  /** Loads a probe and checks the caller may see its app. 404 either way. */
  async function loadProbe(ctx: Parameters<typeof loadApp>[1], probeId: string) {
    const [probe] = await db.select().from(probes).where(eq(probes.id, probeId))
    if (!probe) return null
    return (await loadApp(db, ctx, probe.appId)) ? probe : null
  }

  app.get('/api/apps/:id/probes', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    if (!(await loadApp(db, ctx, id))) return reply.code(404).send({ error: 'not_found' })
    return db.select().from(probes).where(eq(probes.appId, id))
  })

  app.get('/api/apps/:id/probes/suggestions', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const row = await loadApp(db, ctx, id)
    if (!row) return reply.code(404).send({ error: 'not_found' })

    const resolved = await composeConfig.resolve({
      directory: row.directory,
      composeFile: row.composeFile,
    })
    if (!resolved.valid) return []
    // Published ports are the only thing here that reliably names a reachable endpoint.
    return resolved.resolved.services.flatMap((service) =>
      service.publishedPorts.map((port) => ({
        service: service.name,
        target: `http://localhost:${port}`,
      })),
    )
  })

  app.post('/api/apps/:id/probes', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { id } = z.object({ id: z.string() }).parse(request.params)
    if (!(await loadApp(db, ctx, id))) return reply.code(404).send({ error: 'not_found' })
    const body = createBody.parse(request.body)

    if (body.kind !== 'http_internal') {
      // Exactly one docker probe per app, and exactly one external probe per exposure.
      const existing = await db
        .select()
        .from(probes)
        .where(and(eq(probes.appId, id), eq(probes.kind, body.kind)))
      if (existing.length > 0) {
        return reply.code(409).send({ error: 'probe_exists' })
      }
    }

    const probeId = ulid()
    await db.insert(probes).values({ id: probeId, appId: id, ...body })
    const [created] = await db.select().from(probes).where(eq(probes.id, probeId))
    return reply.code(201).send(created)
  })

  app.patch('/api/probes/:probeId', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { probeId } = z.object({ probeId: z.string() }).parse(request.params)
    if (!(await loadProbe(ctx, probeId))) return reply.code(404).send({ error: 'not_found' })
    const body = patchBody.parse(request.body)
    if (Object.keys(body).length === 0) return reply.code(400).send({ error: 'no_fields' })

    await db.update(probes).set(body).where(eq(probes.id, probeId))
    const [updated] = await db.select().from(probes).where(eq(probes.id, probeId))
    return updated
  })

  app.delete('/api/probes/:probeId', async (request, reply) => {
    const ctx = requireCapability(request, 'app:config')
    const { probeId } = z.object({ probeId: z.string() }).parse(request.params)
    if (!(await loadProbe(ctx, probeId))) return reply.code(404).send({ error: 'not_found' })
    await db.delete(probes).where(eq(probes.id, probeId))
    return reply.code(204).send()
  })
}
```

- [ ] **Step 4: Create the docker probe on adoption**

In the adopt loop in `src/server/routes/apps.ts`, immediately after the successful `apps` insert
and inside the same `try`:

```ts
        // One docker probe per app, from the moment it exists. An adopted app with no
        // probe is invisible to monitoring until someone notices and adds one by hand.
        await db.insert(probes).values({ id: ulid(), appId: id, kind: 'docker' })
```

- [ ] **Step 5: Register, run, commit**

```bash
# app.ts: await app.register(probeRoutes) after imageRoutes, before spaRoutes
pnpm exec vitest run src/server/routes/probes.test.ts && pnpm test && pnpm exec tsc --noEmit
git add src/server/routes/probes.ts src/server/routes/probes.test.ts src/server/routes/apps.ts src/server/app.ts
git commit -m "Add probe configuration, and a docker probe on adoption"
```

---

### Task 10: `/api/events` — transitions only, scope-filtered

**Files:**
- Create: `src/server/routes/events.ts`, `src/server/routes/events.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Consumes: `Scheduler.onTransition`, `sseResponse`, `visibleAppsWhere`.
- Produces: `GET /api/events` (SSE).

Spec §5: "`/api/events` (SSE) emits **transitions only**, filtered server-side by the same scope
predicate the REST queries use." Spec §8: "One `EventSource` for the whole app, mounted at the
shell. Events carry `{ appId, probeId, status, faultClass }`."

This is the one route in the phase a **viewer** may open — it is how their launcher updates —
so the scope filter is the security boundary, and it is applied server-side per event.

- [ ] **Step 1: Write the failing test**

`src/server/routes/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp, createViewer, signUpAdmin } from '@server/test-helpers'
import type { PersistedTransition } from '@server/monitoring/persist'

const CONFIG = JSON.stringify({ name: 'jellyfin', services: { web: { image: 'nginx' } } })

async function withApp() {
  const app = await buildTestApp()
  const { cookie } = await signUpAdmin(app)
  app.deps.host.files.set('jellyfin/compose.yaml', 'services: {}\n')
  app.deps.host.composeResults.set('config --format json', {
    exitCode: 0, stdout: CONFIG, stderr: '',
  })
  const adopted = await app.inject({
    method: 'POST', url: '/api/apps/adopt', headers: { cookie },
    payload: { directories: ['jellyfin'] },
  })
  return { app, cookie, id: adopted.json().adopted[0].id as string }
}

const transition = (appId: string, over: Partial<PersistedTransition> = {}): PersistedTransition => ({
  probeId: 'p1', appId, status: 'down', faultClass: 'app', changed: true, ...over,
})

/** Opens the stream, emits, then closes it so `inject` can settle. */
async function collect(
  app: Awaited<ReturnType<typeof withApp>>['app'],
  cookie: string,
  emit: () => void,
) {
  const streaming = app.inject({ method: 'GET', url: '/api/events', headers: { cookie } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  emit()
  await new Promise((resolve) => setTimeout(resolve, 20))
  app.deps.scheduler.stop()
  app.deps.events.closeAll()
  return streaming
}

describe('/api/events', () => {
  it('emits a transition to an admin', async () => {
    const { app, cookie, id } = await withApp()
    const res = await collect(app, cookie, () => app.deps.events.publish(transition(id)))
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.body).toContain('event: status')
    expect(JSON.parse(res.body.match(/event: status\ndata: (.*)/)?.[1] ?? '{}')).toMatchObject({
      appId: id, probeId: 'p1', status: 'down', faultClass: 'app',
    })
    await app.close()
  })

  it('is open to a viewer — this is how their launcher updates', async () => {
    const { app, cookie, id } = await withApp()
    const viewer = await createViewer(app, cookie)
    const res = await collect(app, viewer.cookie, () => app.deps.events.publish(transition(id)))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('event: status')
    await app.close()
  })

  it('does not send a scoped viewer events for apps they cannot see', async () => {
    // The scope predicate is the security boundary here, applied per event rather than
    // per query.
    const { app, cookie, id } = await withApp()
    const scoped = await createViewer(app, cookie, { scopeAllApps: false, appIds: [] })
    const res = await collect(app, scoped.cookie, () => app.deps.events.publish(transition(id)))
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('event: status')
    expect(res.body).not.toContain(id)
    await app.close()
  })

  it('never emits a non-transition', async () => {
    // "Transitions only" is what keeps one EventSource from carrying a message per probe
    // per interval for every app.
    const { app, cookie, id } = await withApp()
    const res = await collect(app, cookie, () =>
      app.deps.events.publish(transition(id, { changed: false })),
    )
    expect(res.body).not.toContain('event: status')
    await app.close()
  })

  it('refuses an anonymous client', async () => {
    const { app } = await withApp()
    expect((await app.inject({ method: 'GET', url: '/api/events' })).statusCode).toBe(401)
    await app.close()
  })

  it('unsubscribes when the client disconnects', async () => {
    const { app, cookie, id } = await withApp()
    await collect(app, cookie, () => app.deps.events.publish(transition(id)))
    // The bus must not retain a listener per closed tab.
    expect(app.deps.events.subscriberCount()).toBe(0)
    await app.close()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run src/server/routes/events.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write `src/server/routes/events.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { inScope, requireAuth } from '../auth/context.js'
import type { PersistedTransition } from '../monitoring/persist.js'
import { sseResponse } from '../sse.js'

/**
 * The fan-out point between the scheduler and every open browser tab.
 *
 * Kept separate from the scheduler so the route does not reach into it, and so a test can
 * publish a transition without running a tick.
 */
export class EventBus {
  private readonly subscribers = new Set<(t: PersistedTransition) => void>()
  private readonly closers = new Set<() => void>()

  /**
   * `onClose` is separate from the transition channel on purpose. Pushing a sentinel
   * value through `subscribe` would make every subscriber type-check for something that
   * is not a transition, to serve one test affordance.
   */
  subscribe(listener: (t: PersistedTransition) => void, onClose?: () => void): () => void {
    this.subscribers.add(listener)
    if (onClose) this.closers.add(onClose)
    return () => {
      this.subscribers.delete(listener)
      if (onClose) this.closers.delete(onClose)
    }
  }

  publish(transition: PersistedTransition): void {
    // Transitions only. Emitting every sample would put one message per probe per
    // interval on every open tab, for a status that did not change.
    if (!transition.changed) return
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(transition)
      } catch {
        // One tab's failure is not another's.
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size
  }

  /**
   * Ends every open stream. A test affordance today — `inject` buffers a response and
   * cannot settle while a stream is open — and the hook a graceful shutdown will call.
   */
  closeAll(): void {
    for (const close of [...this.closers]) close()
  }
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  const { events } = app.deps

  app.get('/api/events', async (request, reply) => {
    // Deliberately `requireAuth`, not a capability: this is the only monitoring route a
    // viewer may open, and it is how their launcher updates.
    const ctx = requireAuth(request)

    const sse = sseResponse(request, reply)
    let done: (() => void) | null = null
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })

    const unsubscribe = events.subscribe(
      (transition) => {
        // The scope predicate, applied per event. A scoped viewer must not learn that an
        // app they cannot see exists, let alone that it just went down.
        if (!inScope(ctx, transition.appId)) return
        sse.send('status', {
          appId: transition.appId,
          probeId: transition.probeId,
          status: transition.status,
          faultClass: transition.faultClass,
        })
      },
      () => done?.(),
    )

    void sse.closed.then(() => done?.())

    try {
      await finished
    } finally {
      unsubscribe()
      sse.close()
    }
  })
}
```

- [ ] **Step 4: Wire the bus to the scheduler**

`AppDeps` gains `events: EventBus`. In `index.ts` and `test-helpers.ts`, construct the bus,
construct the scheduler, and connect them:

```ts
const events = new EventBus()
const scheduler = new Scheduler({ db, host, composeConfig, runners })
scheduler.onTransition((transition) => events.publish(transition))
```

Register `eventRoutes` after `probeRoutes` and before `spaRoutes`.

- [ ] **Step 5: Run everything and commit**

```bash
pnpm exec vitest run src/server/routes/events.test.ts && pnpm test && pnpm exec tsc --noEmit && pnpm exec biome check .
git add src/server/routes/events.ts src/server/routes/events.test.ts src/server/app.ts src/server/index.ts src/server/test-helpers.ts
git commit -m "Push probe transitions to the browser, filtered by scope"
```

---

## Self-Review

**Spec coverage for 1C's slice:**

| Spec requirement | Task |
|---|---|
| 5s tick selecting `nextRunAt <= now`, concurrency ~8, jitter ±10% (§5) | 7 |
| `nextRunAt` in the database so probes are runtime-editable and restarts do not stampede (§5) | 7 |
| One `listContainers({ all: true })` snapshot per tick (§5) | 7 |
| `ProbeRunner` / `ProbeResult` interface with `faultClass` (§5) | 4 |
| docker runner from the shared snapshot (§5) | 4 |
| `http_internal`: timeout, `redirect: 'manual'`, status pattern, capped body (§5) | 2, 5 |
| `http_external`: Access headers and the full classification table (§5) | 5 |
| 2 failures down / 1 success up; `statusSince` on confirmed transitions only (§5) | 3 |
| Post-lifecycle grace renders as `starting` (§4, §5) | 3 |
| One transaction for `check_results` + denormalised probe row (§5) | 6 |
| Hourly rollup, 48h / 90d retention, startup catch-up (§3, §5) | 8 |
| `/api/events` transitions only, scope-filtered server-side (§5, §8) | 10 |
| One docker probe per app on adoption; many `http_internal`; suggestions from published ports (§3) | 9 |

**Carry-forward items closed:** `statusFor` extracted (Task 1); the stale `projectName`
preferred from the resolved config (Task 1); `ImageUpdateChecker.check` scheduled — **not** in
this plan, see below.

**Deliberately deferred:**

- **The daily image-update sweep.** `ImageUpdateChecker.check(app)` is ready and never throws,
  but wiring it needs a second, much slower cadence than the 5s probe tick. It belongs with
  the retention timer in a follow-up rather than bolted onto Task 7 — and 1D needs nothing
  from it that Task 9's manual trigger does not already provide.
- **`http_external` has nothing to probe yet.** No exposure exists until Phase 2, so
  `accessCredentials` returns null and the runner reports `degraded/config`. The
  classification table is implemented and tested now because it is the part most likely to be
  got wrong later, and because getting `redirect: 'manual'` wrong is silent.
- **Per-install settings.** The spec says the interval, threshold, grace and retention numbers
  are per-install with these as shipped defaults. The `settings` table exists; reading from it
  is a small, separable change and every value is already a named constant.
- **Graceful shutdown**, still open from 1B-ii. `Scheduler.stop()` exists and is tested; the
  SIGTERM handler that calls it belongs with the Dockerfile.

**Type consistency check:** `ProbeRow`, `ProbeResult`, `ProbeContext` and `ProbeRunner` are
defined in Task 4's `types.ts` and used by Tasks 5, 7. `StatusDeps` and `AppRow` come from
Task 1 and are used by Tasks 4 and 7. `PersistedTransition` is defined in Task 6 and consumed by
Tasks 7 and 10. `applyTransition` (Task 3) is called only from `persistResult` (Task 6).
`matchesStatusPattern` (Task 2) is called only from the HTTP runners (Task 5). Tasks 9 and 10
both import `loadApp` from `apps.ts`, which 1B-ii already exported at module scope.
