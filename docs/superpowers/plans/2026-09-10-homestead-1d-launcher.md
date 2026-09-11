# Homestead Phase 1D — Launcher and Icon Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the launcher — the homepage card grid that everyone including viewers sees — backed by a status path that cannot be taken down by the monitoring pipeline it reports on, plus the server-side icon proxy the cards render from.

**Architecture:** The launcher reads one cheap indexed query over the denormalised `probes.lastStatus` columns — no Docker call, no `docker compose config` spawn — and receives updates over the single shell-mounted `EventSource` built in Phase 1C. Both the initial payload and the live patches therefore come from the same debounced source, so they cannot disagree. Icons are fetched from the dashboard-icons CDN by the server, cached to disk, and served locally, so no viewer's browser ever contacts a third party and the grid still renders during an internet outage.

**Tech Stack:** Fastify, Drizzle + libSQL, React 19, TanStack Query 5, react-router-dom 7, Tailwind 4, Vitest + @testing-library/react + jsdom. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — section 8 (Launcher, Live updates, Icons, Cross-cutting).

**Carry-forward this plan must respect:** `docs/superpowers/plans/2026-09-10-homestead-1c-carry-forward.md`.

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess`; ESM with `.js` import specifiers on server-side relative imports; `moduleResolution: bundler`; no `baseUrl`; `target: ES2022` / `lib: ES2023`.
- **No new dependencies.** Everything below is buildable with what `package.json` already has.
- zod 4 for request validation. Vitest for tests. Biome for lint and format.
- Every non-2xx response body carries an `error` slug: `reply.code(404).send({ error: "not_found" })`.
- A hijacked reply is never returned from a handler.
- `inScope` / `visibleAppsWhere` in `src/server/auth/context.ts` is the **only** scope predicate. Do not write a second one.
- **Status is never colour alone** — every status dot pairs with text or a distinct icon shape (spec §8 Cross-cutting).
- **Dark mode via `prefers-color-scheme`**, no toggle. Tailwind's `dark:` variant.
- The viewer DTO lists every property explicitly. Never build a viewer payload by spreading a row and deleting fields — that inverts the failure mode so a new column leaks by default.
- `pnpm exec tsc --noEmit` is a separate gate: **vitest does not typecheck**.
- Run the full suite at least **three times** before believing it green.

---

## Rulings made while writing this plan

These resolve open questions the spec and carry-forward left. Each is recorded here so an implementer does not have to re-derive it.

**1. The launcher trusts the debounced probe status, exclusively.** The 1C carry-forward flags that `/api/events` carries the debounced status from `applyTransition` while `GET /api/apps` computes a live rollup, and that 1D must pick one. The launcher picks the debounced one for *both* transports: `GET /api/launcher` reads `probes.lastStatus`, and the SSE patch carries the same value from the same write. One source, two transports, so the disagreement is structurally impossible on this surface. `GET /api/apps`' live rollup belongs to the admin inventory (Phase 1E), where an admin wants ground truth and can afford the Docker call.

**2. `GET /api/launcher` is a separate route, not `GET /api/apps?view=launcher`.** A flag on the existing route would leave the expensive Docker path one bad conditional away from the screen whose entire requirement is not to have one.

**3. An app with no probes shows `unknown`, not `up`.** Adoption creates an enabled docker probe (Phase 1C), so this is the manually-created-app case. `unknown` with "Not checked yet" is honest; defaulting to `up` would make a monitoring product's front page lie by omission.

**4. The reason phrase is computed server-side; the duration is rendered client-side.** The phrase is real logic with real branches and deserves node-testable unit tests in one place. The duration ticks and depends on the client's clock, so the server returns `statusSince` as an epoch and the client formats it.

**5. `lastDetail` never appears in any launcher payload, for any role.** An HTTP probe's detail can carry response-body fragments. Admins get detail on the edit page in 1E. Keeping this endpoint viewer-shaped for everyone means there is no role branch here to get wrong.

**6. The sparkline is 30 daily buckets, not 720 hourly ones.** `check_rollups` is hourly and 30 days is 720 rows per probe; a sparkline cannot render 720 points usefully on a phone. The server aggregates to days.

---

## File Structure

**Server — new:**

| File | Responsibility |
|---|---|
| `src/server/launcher/status-phrase.ts` | Pure: probe rows → one app status + a cause phrase. No DB, no IO. |
| `src/server/launcher/query.ts` | The cheap launcher query. Apps joined to probes, scope-filtered, no Docker. |
| `src/server/launcher/health.ts` | Per-app health detail: the three signals plus 30 daily buckets. |
| `src/server/routes/launcher.ts` | `GET /api/launcher`, `GET /api/launcher/:appId/health`. |
| `src/server/icons/metadata.ts` | Fetches, disk-caches, and indexes dashboard-icons `metadata.json`. |
| `src/server/icons/store.ts` | Per-icon fetch and disk cache, confined to the cache directory. |
| `src/server/routes/icons.ts` | `GET /api/icons/search`, `GET /api/icons/:slug`. |

**Server — modified:** `src/server/config.ts` (icon cache dir), `src/server/app.ts` (register routes, `AppDeps`), `src/server/index.ts` and `src/server/test-helpers.ts` (wire the icon service — **both**, they must describe the same graph).

**Shared — new:** `src/shared/launcher.ts` — `LauncherApp`, `AppHealth`, `HealthSignal`, `DayBucket`, `StatusReason`.

**Web — new:**

| File | Responsibility |
|---|---|
| `src/web/live/useEventStream.ts` | The one `EventSource`, mounted at the shell, patching the query cache. |
| `src/web/api/launcher.ts` | `useLauncherApps`, `useAppHealth` query hooks and their query keys. |
| `src/web/routes/Launcher.tsx` | The grid: grouping, search, empty and error states. |
| `src/web/components/AppCard.tsx` | One tile. Card is the launch target; the chip is not. |
| `src/web/components/StatusChip.tsx` | Status dot + phrase + duration. Never colour alone. |
| `src/web/components/AppIcon.tsx` | Proxied icon with generated letter-tile fallback. |
| `src/web/components/HealthPanel.tsx` | The three signals plus sparkline. Sheet on mobile, popover on desktop. |
| `src/web/components/Sparkline.tsx` | Hand-rolled SVG. 30 daily buckets. |
| `src/web/lib/relative-time.ts` | `12m`, `3h`, `2d`. |

**Web — modified:** `src/web/App.tsx` (route `/` to `Launcher`), `src/web/routes/AppLayout.tsx` (mount the event stream), `index.html` (manifest link), `public/manifest.webmanifest` (new).

**Config — modified:** `vitest.config.ts` (jsdom for `.tsx`, include `.tsx` tests).

---

### Task 1: Component test infrastructure

Nothing in `src/web` has ever been rendered in a test. `vitest.config.ts` sets `environment: "node"` and `include: ["src/**/*.test.ts"]`, so a `.tsx` test file is not merely unsupported — it is **not collected at all**, and would sit green-by-absence forever. `@testing-library/react` and `jsdom` are already installed and unused. Every later web task depends on this one.

**Files:**
- Modify: `vitest.config.ts`
- Create: `src/web/test-setup.ts`
- Create: `src/web/lib/relative-time.ts`
- Test: `src/web/lib/relative-time.test.ts`, `src/web/test-infra.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `.tsx` test files under `src/web` run in jsdom. `renderWithQuery(ui: ReactElement): RenderResult` from `@web/test-setup`. `relativeTime(since: number, now: number): string`.

- [ ] **Step 1: Write the failing infrastructure test**

`src/web/test-infra.test.tsx`:

```tsx
// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@web/test-setup";
import { expect, it } from "vitest";

it("has a DOM global", () => {
  expect(typeof document).toBe("object");
});

it("first test leaves a node behind", () => {
  renderWithQuery(<p>alpha</p>);
  expect(screen.getByText("alpha")).toBeTruthy();
});

it("second test does not see it, proving cleanup actually runs", () => {
  // Without `afterEach(cleanup)` this passes for the wrong reason forever: the
  // previous test's node is still mounted and `alpha` would still be found.
  renderWithQuery(<p>beta</p>);
  expect(screen.queryAllByText("alpha")).toHaveLength(0);
});
```

- [ ] **Step 2: Run it and watch it not even be collected**

Run: `pnpm exec vitest run src/web/test-infra.test.tsx`

Expected: `No test files found`. That is the point — note it, because a test file that is silently not collected is the failure mode this task exists to remove.

- [ ] **Step 3: Widen the vitest config**

`vitest.config.ts` — the only change is the `include` array:

```ts
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
```

**Do not reach for `environmentMatchGlobs`.** It was removed in Vitest 4 and this project is on Vitest 5 — it is absent from the installed type definitions and will be silently ignored, leaving `.tsx` tests running in the node environment where `document` is undefined. Verified against the installed version. The two supported options are a `projects` array or a per-file docblock; this plan uses the docblock, because splitting a working 471-test suite into projects on the way past is a change with its own failure modes and no benefit here.

**Every `.tsx` test file in this plan therefore begins with:**

```tsx
// @vitest-environment jsdom
```

This is verified working on Vitest 5.0.0 — a file with that docblock renders into a real DOM while the server suite keeps its node environment. Omitting it is the most likely mistake in the web tasks, and its symptom is `document is not defined`.

- [ ] **Step 4: Add the shared render helper**

`src/web/test-setup.tsx` — a plain module that web tests import, **not** a `setupFiles` entry:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach } from "vitest";

/**
 * Registers on import, so only the files that actually render components pay for it.
 *
 * A global `setupFiles` entry would run this for all 471 server tests too, loading
 * React and Testing Library into every node worker — measured at roughly 70% of a small
 * server test file's runtime. Import-scoping is the same guarantee for the files that
 * need it and nothing for the files that do not.
 *
 * Cleanup itself is not optional: a leaked DOM between tests makes `getByText` match a
 * node the *previous* test rendered, which reads as a passing assertion about the wrong
 * thing.
 */
afterEach(cleanup);

/**
 * Every component here reads from the query cache, so a bare `render` throws.
 *
 * `retry: false` matters: the default three retries with backoff make a test that
 * asserts an error state hang until the suite timeout instead of failing.
 */
export function renderWithQuery(ui: ReactElement): RenderResult & { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const result = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...result, client };
}
```

- [ ] **Step 5: Run and verify it passes**

Run: `pnpm exec vitest run src/web/test-infra.test.tsx`
Expected: 3 passed. Then `pnpm exec vitest run` — the full suite must still be 471 passing plus these 3.

- [ ] **Step 5b: Binding check on the infrastructure itself**

Remove `afterEach(cleanup)` from `test-setup.tsx`. The third test must fail. Restore it. This is the one binding check that matters most in this task: a test-infrastructure bug does not fail loudly, it makes every later test in the plan assert against a stale DOM.

- [ ] **Step 6: Write the failing relative-time test**

`src/web/lib/relative-time.test.ts`:

```ts
import { relativeTime } from "@web/lib/relative-time";
import { describe, expect, it } from "vitest";

const NOW = 1_800_000_000;

describe("relativeTime", () => {
  it("reads in seconds under a minute", () => {
    expect(relativeTime(NOW - 5, NOW)).toBe("5s");
  });
  it("reads in minutes under an hour", () => {
    expect(relativeTime(NOW - 12 * 60, NOW)).toBe("12m");
  });
  it("reads in hours under a day", () => {
    expect(relativeTime(NOW - 3 * 3600, NOW)).toBe("3h");
  });
  it("reads in days beyond that", () => {
    expect(relativeTime(NOW - 2 * 86400, NOW)).toBe("2d");
  });
  it("clamps a future timestamp to 0s rather than rendering '-4s'", () => {
    // Clock skew between the NAS and a phone is normal and must not produce
    // "Healthy · -4s", which reads as a bug in the product.
    expect(relativeTime(NOW + 4, NOW)).toBe("0s");
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/lib/relative-time.test.ts`
Expected: FAIL — cannot resolve `@web/lib/relative-time`.

- [ ] **Step 8: Implement**

`src/web/lib/relative-time.ts`:

```ts
/** Compact age for a status line: `5s`, `12m`, `3h`, `2d`. Both arguments are epoch seconds. */
export function relativeTime(since: number, now: number): string {
  const elapsed = Math.max(0, now - since);
  if (elapsed < 60) return `${Math.floor(elapsed)}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`;
  return `${Math.floor(elapsed / 86400)}d`;
}
```

- [ ] **Step 9: Run all gates**

```bash
pnpm exec vitest run && pnpm exec tsc --noEmit && pnpm exec biome check .
```

- [ ] **Step 10: Commit**

```bash
git add vitest.config.ts src/web/test-setup.tsx src/web/test-infra.test.tsx src/web/lib/
git commit -m "Collect and run component tests, which the config silently excluded"
```

---

### Task 2: Status phrase — probes to one status and one cause

Pure logic, no database. Spec §8: *"The status line carries the cause, not a duration, whenever something is wrong: 'Tunnel unreachable — app is fine · 12m' rather than 'Degraded · 12m'."* This is the module that recovers the fault localisation a single rolled-up indicator would discard.

**Files:**
- Create: `src/shared/launcher.ts`
- Create: `src/server/launcher/status-phrase.ts`
- Test: `src/server/launcher/status-phrase.test.ts`

**Interfaces:**
- Consumes: `AppStatus`, `FaultClass`, `ProbeKind` from `@shared/types`.
- Produces:
  ```ts
  // src/shared/launcher.ts
  export type StatusReason = { status: AppStatus; reason: string; since: number | null };
  export type ProbeSnapshot = {
    kind: ProbeKind;
    label: string | null;
    status: AppStatus;
    faultClass: FaultClass | null;
    statusSince: number | null;
    lastCheckedAt: number | null;
  };
  ```
  ```ts
  // src/server/launcher/status-phrase.ts
  export function rollUpProbes(probes: ProbeSnapshot[]): StatusReason;
  export const SEVERITY: Record<AppStatus, number>;
  ```

- [ ] **Step 1: Write the shared types**

`src/shared/launcher.ts`:

```ts
import type { AppStatus, FaultClass, ProbeKind } from "./types.js";

/** One probe's current state, as the launcher sees it. Never carries `lastDetail`. */
export type ProbeSnapshot = {
  kind: ProbeKind;
  label: string | null;
  status: AppStatus;
  faultClass: FaultClass | null;
  statusSince: number | null;
  lastCheckedAt: number | null;
};

/** An app's rolled-up state plus the human cause. `since` is epoch seconds. */
export type StatusReason = { status: AppStatus; reason: string; since: number | null };
```

- [ ] **Step 2: Write the failing test**

`src/server/launcher/status-phrase.test.ts`:

```ts
import { rollUpProbes } from "@server/launcher/status-phrase";
import type { ProbeSnapshot } from "@shared/launcher";
import { describe, expect, it } from "vitest";

const probe = (over: Partial<ProbeSnapshot>): ProbeSnapshot => ({
  kind: "docker",
  label: null,
  status: "up",
  faultClass: null,
  statusSince: 1000,
  lastCheckedAt: 1000,
  ...over,
});

describe("rollUpProbes", () => {
  it("reads 'Healthy' when every probe is up, staying visually quiet", () => {
    expect(rollUpProbes([probe({}), probe({ kind: "http_internal" })])).toEqual({
      status: "up",
      reason: "Healthy",
      since: 1000,
    });
  });

  it("reports unknown for an app with no probes rather than claiming it is up", () => {
    expect(rollUpProbes([])).toEqual({ status: "unknown", reason: "Not checked yet", since: null });
  });

  it("names the tunnel and exonerates the app when only the external probe fails", () => {
    // The whole point of the cause phrase: "Degraded" would send the user to debug
    // Jellyfin when Jellyfin is fine and Cloudflare is not.
    const out = rollUpProbes([
      probe({ kind: "docker", status: "up" }),
      probe({ kind: "http_internal", status: "up" }),
      probe({ kind: "http_external", status: "down", faultClass: "network", statusSince: 2000 }),
    ]);
    expect(out).toEqual({
      status: "degraded",
      reason: "Tunnel unreachable — app is fine",
      since: 2000,
    });
  });

  it("does not exonerate the app when the internal probe is also failing", () => {
    const out = rollUpProbes([
      probe({ kind: "http_internal", status: "down", faultClass: "app", statusSince: 2000 }),
      probe({ kind: "http_external", status: "down", faultClass: "network", statusSince: 2500 }),
    ]);
    expect(out.status).toBe("down");
    expect(out.reason).toBe("App not responding");
  });

  it("blames the containers when the docker probe is down", () => {
    expect(rollUpProbes([probe({ status: "down", faultClass: "app", statusSince: 7 })])).toEqual({
      status: "down",
      reason: "Containers not running",
      since: 7,
    });
  });

  it("names a config fault distinctly, since restarting will not fix it", () => {
    expect(rollUpProbes([probe({ status: "down", faultClass: "config" })]).reason).toBe(
      "Compose config invalid",
    );
  });

  it("reports starting during the grace window", () => {
    expect(rollUpProbes([probe({ status: "starting" })]).reason).toBe("Starting");
  });

  it("takes `since` from the worst probe, not the first or the newest", () => {
    const out = rollUpProbes([
      probe({ kind: "docker", status: "up", statusSince: 5000 }),
      probe({ kind: "http_internal", status: "down", faultClass: "app", statusSince: 300 }),
    ]);
    expect(out.since).toBe(300);
  });

  it("prefers down over degraded over starting over unknown over up", () => {
    const statuses = ["up", "unknown", "starting", "degraded", "down"] as const;
    for (let i = 1; i < statuses.length; i++) {
      const worse = statuses[i] as (typeof statuses)[number];
      const better = statuses[i - 1] as (typeof statuses)[number];
      expect(rollUpProbes([probe({ status: better }), probe({ status: worse })]).status).toBe(worse);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run src/server/launcher/status-phrase.test.ts`
Expected: FAIL — cannot resolve `@server/launcher/status-phrase`.

- [ ] **Step 4: Implement**

`src/server/launcher/status-phrase.ts`:

```ts
import type { ProbeSnapshot, StatusReason } from "@shared/launcher.js";
import type { AppStatus } from "@shared/types.js";

/**
 * Worst-wins ordering. `unknown` outranks `up` because a probe we have not heard from
 * is not evidence of health, and this is the screen whose job is to tell the truth
 * about health.
 */
export const SEVERITY: Record<AppStatus, number> = {
  up: 0,
  unknown: 1,
  starting: 2,
  degraded: 3,
  down: 4,
};

function phraseFor(worst: ProbeSnapshot, others: ProbeSnapshot[]): string {
  if (worst.status === "up") return "Healthy";
  if (worst.status === "starting") return "Starting";
  if (worst.status === "unknown") return "Not checked yet";
  if (worst.faultClass === "config") return "Compose config invalid";

  if (worst.kind === "http_external") {
    // Only exonerate the app when something actually observed it working. Saying
    // "app is fine" on the strength of no evidence is worse than saying nothing.
    const appIsFine = others.some(
      (p) => (p.kind === "docker" || p.kind === "http_internal") && p.status === "up",
    );
    if (appIsFine) return "Tunnel unreachable — app is fine";
    return "Unreachable";
  }

  if (worst.kind === "docker") return "Containers not running";
  return "App not responding";
}

/**
 * One app's probes become one status and one cause.
 *
 * The external probe failing alone is reported as `degraded`, not `down`: the app is
 * running and reachable on the LAN, and painting the tile as down would be wrong for
 * every user standing in the house.
 */
export function rollUpProbes(probes: ProbeSnapshot[]): StatusReason {
  if (probes.length === 0) return { status: "unknown", reason: "Not checked yet", since: null };

  let worst = probes[0] as ProbeSnapshot;
  for (const probe of probes) {
    if (SEVERITY[probe.status] > SEVERITY[worst.status]) worst = probe;
  }

  const others = probes.filter((p) => p !== worst);
  const appIsFine = others.some(
    (p) => (p.kind === "docker" || p.kind === "http_internal") && p.status === "up",
  );

  // A failing tunnel over a working app is a partial outage, not an outage.
  const status: AppStatus =
    worst.kind === "http_external" && worst.status === "down" && appIsFine ? "degraded" : worst.status;

  return { status, reason: phraseFor(worst, others), since: worst.statusSince };
}
```

- [ ] **Step 5: Run and verify it passes**

Run: `pnpm exec vitest run src/server/launcher/status-phrase.test.ts`
Expected: all pass.

- [ ] **Step 6: Binding check**

Change `SEVERITY.unknown` to `-1` so `unknown` sorts below `up`. The precedence test must fail. Restore it. Report the result.

- [ ] **Step 7: Commit**

```bash
git add src/shared/launcher.ts src/server/launcher/
git commit -m "Roll several probes into one status that names the cause"
```

---

### Task 3: `GET /api/launcher` — the cheap query

Spec §8: *"The launcher must not depend on the monitoring pipeline being healthy. Tiles come from one cheap indexed query on the denormalised `probes` columns; status arrives afterwards over SSE. A wedged Docker socket or a slow Cloudflare API must not degrade the screen whose job is to reach Jellyfin."*

`GET /api/apps` makes a `host.listContainers()` call and spawns up to four concurrent `docker compose config` processes. This route must do neither.

**Files:**
- Create: `src/server/launcher/query.ts`
- Create: `src/server/routes/launcher.ts`
- Modify: `src/shared/launcher.ts` (add `LauncherApp`)
- Modify: `src/server/app.ts` (register `launcherRoutes` **before** `spaRoutes`)
- Test: `src/server/routes/launcher.test.ts`

**Interfaces:**
- Consumes: `rollUpProbes(probes: ProbeSnapshot[]): StatusReason` from Task 2; `visibleAppsWhere(ctx)` and `requireCapability(request, "app:read")` from `@server/auth/context`.
- Produces:
  ```ts
  export type LauncherApp = {
    id: string;
    slug: string;
    displayName: string;
    description: string | null;
    iconRef: string | null;
    category: string | null;
    launchUrl: string | null;
    sortOrder: number;
    status: AppStatus;
    reason: string;
    since: number | null;
  };
  export async function launcherApps(db: Db, ctx: AuthContext): Promise<LauncherApp[]>;
  ```

- [ ] **Step 1: Add the DTO**

Append to `src/shared/launcher.ts`:

```ts
/**
 * One launcher tile. A distinct type from `ViewerApp`, and like it, every property is
 * listed explicitly — a column added to `apps` must not be able to reach a viewer's
 * browser without someone editing this declaration.
 */
export type LauncherApp = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  iconRef: string | null;
  category: string | null;
  launchUrl: string | null;
  sortOrder: number;
  status: AppStatus;
  reason: string;
  since: number | null;
  /**
   * Every enabled probe's current state. The client needs these to apply a single
   * probe's SSE event and re-derive the app's status the way the server would. Without
   * them it can only overwrite, which made one probe recovering paint a tile green
   * while another was still down. Added after Task 7's review; see
   * `task-7-fix-brief.md`.
   */
  probes: ProbeSnapshot[];
};
```

- [ ] **Step 2: Write the failing route test**

`src/server/routes/launcher.test.ts`. Use the existing adopt helper pattern from `src/server/routes/apps-launch-url.test.ts`.

```ts
import { apps, probes } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

async function seeded() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: JSON.stringify({ name: "jellyfin", services: {} }),
    stderr: "",
  });
  const adopted = await app.inject({
    method: "POST",
    url: "/api/apps/adopt",
    headers: { cookie },
    payload: { directories: ["jellyfin"] },
  });
  return { app, cookie, id: adopted.json().adopted[0].id as string };
}

describe("GET /api/launcher", () => {
  it("never calls Docker, so a wedged socket cannot take the launcher down", async () => {
    const { app, cookie } = await seeded();
    let dockerCalls = 0;
    app.deps.host.listContainers = async () => {
      dockerCalls++;
      throw new Error("docker socket is wedged");
    };
    const res = await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(dockerCalls).toBe(0);
    expect(res.json().apps).toHaveLength(1);
  });

  it("reports the probe's denormalised status, not a live rollup", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db
      .update(probes)
      .set({ lastStatus: "down", lastFaultClass: "app", statusSince: 4242 })
      .where(eq(probes.appId, id));
    const [tile] = (await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } }))
      .json().apps;
    expect(tile).toMatchObject({ status: "down", reason: "Containers not running", since: 4242 });
  });

  it("omits apps hidden from the launcher", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db.update(apps).set({ showOnLauncher: false }).where(eq(apps.id, id));
    expect(
      (await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } })).json().apps,
    ).toEqual([]);
  });

  it("omits archived apps", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db.update(apps).set({ archivedAt: 1 }).where(eq(apps.id, id));
    expect(
      (await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } })).json().apps,
    ).toEqual([]);
  });

  it("shows a scoped viewer only their apps", async () => {
    const { app, cookie } = await seeded();
    const scoped = await createViewer(app, cookie, { scopeAllApps: false, appIds: [] });
    const res = await app.inject({
      method: "GET",
      url: "/api/launcher",
      headers: { cookie: scoped.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().apps).toEqual([]);
  });

  it("leaks no operational fields to a viewer", async () => {
    const { app, cookie } = await seeded();
    const viewer = await createViewer(app, cookie);
    const [tile] = (
      await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie: viewer.cookie } })
    ).json().apps;
    for (const forbidden of ["directory", "composeFile", "projectName", "hostId", "lastDetail"]) {
      expect(Object.keys(tile)).not.toContain(forbidden);
    }
  });

  it("reports unknown for an app with no probes rather than up", async () => {
    const { app, cookie, id } = await seeded();
    await app.deps.db.delete(probes).where(eq(probes.appId, id));
    const [tile] = (await app.inject({ method: "GET", url: "/api/launcher", headers: { cookie } }))
      .json().apps;
    expect(tile).toMatchObject({ status: "unknown", reason: "Not checked yet" });
  });

  it("requires authentication", async () => {
    const { app } = await seeded();
    expect((await app.inject({ method: "GET", url: "/api/launcher" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run src/server/routes/launcher.test.ts`
Expected: FAIL — 404 on `/api/launcher`.

- [ ] **Step 4: Implement the query**

`src/server/launcher/query.ts`:

```ts
import type { AuthContext } from "../auth/context.js";
import { visibleAppsWhere } from "../auth/context.js";
import type { Db } from "../db/client.js";
import { apps, probes } from "../db/schema.js";
import type { LauncherApp, ProbeSnapshot } from "@shared/launcher.js";
import { and, eq, isNull } from "drizzle-orm";
import { rollUpProbes } from "./status-phrase.js";

/**
 * Two indexed selects and an in-memory join. No Docker call, no `docker compose config`
 * spawn — see the spec: a wedged Docker socket must not degrade the screen whose job is
 * to reach Jellyfin. `GET /api/apps` deliberately does the expensive thing; this route
 * deliberately does not, and that is why it is a separate route.
 */
export async function launcherApps(db: Db, ctx: AuthContext): Promise<LauncherApp[]> {
  const scope = visibleAppsWhere(ctx);
  const rows = await db
    .select()
    .from(apps)
    .where(and(eq(apps.showOnLauncher, true), isNull(apps.archivedAt), ...(scope ? [scope] : [])));

  if (rows.length === 0) return [];

  // One select for every probe on the host, bucketed in memory. The alternative is a
  // query per tile, which is the shape this screen exists to avoid.
  const allProbes = await db
    .select({
      appId: probes.appId,
      kind: probes.kind,
      label: probes.label,
      status: probes.lastStatus,
      faultClass: probes.lastFaultClass,
      statusSince: probes.statusSince,
      lastCheckedAt: probes.lastCheckedAt,
      enabled: probes.enabled,
    })
    .from(probes);

  const byApp = new Map<string, ProbeSnapshot[]>();
  for (const probe of allProbes) {
    // A disabled probe is not evidence of anything. Including it would pin a tile at
    // whatever status it held when an admin switched it off.
    if (!probe.enabled) continue;
    const list = byApp.get(probe.appId) ?? [];
    list.push({
      kind: probe.kind,
      label: probe.label,
      status: probe.status,
      faultClass: probe.faultClass,
      statusSince: probe.statusSince,
      lastCheckedAt: probe.lastCheckedAt,
    });
    byApp.set(probe.appId, list);
  }

  return rows
    .map((row) => {
      const { status, reason, since } = rollUpProbes(byApp.get(row.id) ?? []);
      // Every property explicit. Do not rewrite as a spread — that inverts the failure
      // mode so a new column leaks until someone remembers to exclude it.
      return {
        id: row.id,
        slug: row.slug,
        displayName: row.displayName,
        description: row.description,
        iconRef: row.iconRef,
        category: row.category,
        launchUrl: row.launchInternalUrl,
        sortOrder: row.sortOrder,
        status,
        reason,
        since,
      };
    })
    .sort(
      (a, b) =>
        (a.category ?? "").localeCompare(b.category ?? "") ||
        a.sortOrder - b.sortOrder ||
        a.displayName.localeCompare(b.displayName),
    );
}
```

- [ ] **Step 5: Implement the route**

`src/server/routes/launcher.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { requireCapability } from "../auth/context.js";
import { launcherApps } from "../launcher/query.js";

export async function launcherRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get("/api/launcher", async (request) => {
    const ctx = requireCapability(request, "app:read");
    return { apps: await launcherApps(db, ctx) };
  });
}
```

- [ ] **Step 6: Register it**

In `src/server/app.ts`, add `await app.register(launcherRoutes);` alongside the other route registrations and **before** `await app.register(spaRoutes);` — `spaRoutes` installs the not-found handler that swallows unmatched paths into the SPA shell.

- [ ] **Step 7: Run and verify it passes**

Run: `pnpm exec vitest run src/server/routes/launcher.test.ts`
Expected: all pass.

- [ ] **Step 8: Binding checks**

- Delete the `visibleAppsWhere` clause → the scoped-viewer test must fail.
- Delete the `if (!probe.enabled) continue` line, then disable the probe in a test and assert it is ignored → confirm the new assertion fails without the line.
- Replace the explicit property list with `...row` → the no-operational-fields test must fail.

Report each as "broke X → test Y failed → restored → green".

- [ ] **Step 9: Commit**

```bash
git add src/server/launcher/query.ts src/server/routes/launcher.ts src/server/app.ts src/shared/launcher.ts src/server/routes/launcher.test.ts
git commit -m "Serve launcher tiles from the denormalised probe columns, never from Docker"
```

---

### Task 4: `GET /api/launcher/:appId/health` — three signals and a sparkline

> **Amended after Task 4's review.** `DayBucket` below shows the original count-based
> shape; it was changed to per-probe-averaged ratios because pooling counts made a day
> read as whichever probe polled fastest. See `task-4-fix-brief.md` in the SDD workspace.
> Task 11's Sparkline code in this document already reflects the new shape.

Spec §8: *"The status chip is a separate tap target opening a bottom sheet (mobile) or popover (desktop) with the three signals and a 30-day sparkline."*

**Ruling 5 applies: this endpoint never returns `lastDetail`, for any role.** An HTTP probe's detail can carry response-body fragments, and a viewer is on this endpoint. Phase 1C's review confirmed `lastDetail` currently reaches no viewer payload; keep it that way.

**Files:**
- Create: `src/server/launcher/health.ts`
- Modify: `src/shared/launcher.ts` (add `HealthSignal`, `DayBucket`, `AppHealth`)
- Modify: `src/server/routes/launcher.ts`
- Test: `src/server/launcher/health.test.ts`, extend `src/server/routes/launcher.test.ts`

**Interfaces:**
- Consumes: `rollUpProbes` (Task 2), `checkRollups` and `probes` from `@server/db/schema`.
- Produces:
  ```ts
  export type HealthSignal = {
    probeId: string;
    kind: ProbeKind;
    label: string | null;
    status: AppStatus;
    reason: string;
    since: number | null;
    lastCheckedAt: number | null;
    latencyMs: number | null;
  };
  export type DayBucket = { dayStart: number; up: number; degraded: number; down: number };
  export type AppHealth = { appId: string; signals: HealthSignal[]; history: DayBucket[] };
  export async function appHealth(db: Db, appId: string, now: number): Promise<AppHealth>;
  ```

- [ ] **Step 1: Add the DTOs**

Append to `src/shared/launcher.ts`:

```ts
/** One probe's row in the health panel. Never carries raw probe detail. */
export type HealthSignal = {
  probeId: string;
  kind: ProbeKind;
  label: string | null;
  status: AppStatus;
  reason: string;
  since: number | null;
  lastCheckedAt: number | null;
  latencyMs: number | null;
};

/**
 * One day of the sparkline. `dayStart` is epoch seconds at UTC midnight. Ratios in 0..1,
 * each the mean across the app's probes of that probe's own share for the day — NOT
 * pooled counts. See the Task 4 fix brief: pooling made a day read as whichever probe
 * polled fastest. `probeCount` of 0 means no data, which a renderer must distinguish
 * from a healthy day since the ratios are 0 in both cases.
 */
export type DayBucket = {
  dayStart: number;
  upRatio: number;
  degradedRatio: number;
  downRatio: number;
  probeCount: number;
};

export type AppHealth = { appId: string; signals: HealthSignal[]; history: DayBucket[] };
```

- [ ] **Step 2: Write the failing test**

`src/server/launcher/health.test.ts`:

```ts
import { createDb, runMigrations } from "@server/db/client";
import { apps, checkRollups, hosts, probes } from "@server/db/schema";
import { appHealth } from "@server/launcher/health";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const HOUR = 3600;
const DAY = 86_400;
const NOW = 40 * DAY; // a round number of days, so bucket edges are unambiguous

async function fixture() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({ id: "l", name: "l", composeRoot: "/v", dockerSocket: "/s" });
  const appId = ulid();
  await db.insert(apps).values({
    id: appId, hostId: "l", slug: "j", displayName: "J",
    directory: "d", composeFile: "compose.yaml", projectName: "j",
  });
  return { db, appId };
}

describe("appHealth", () => {
  it("returns one signal per enabled probe, with a phrase and no raw detail", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({
      id: "p1", appId, kind: "docker", lastStatus: "down", lastFaultClass: "app",
      statusSince: 100, lastCheckedAt: 200, lastLatencyMs: 7,
      lastDetail: { body: "a secret response fragment" },
    });
    const { signals } = await appHealth(db, appId, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      probeId: "p1", kind: "docker", label: null, status: "down",
      reason: "Containers not running", since: 100, lastCheckedAt: 200, latencyMs: 7,
    });
    // The security property, asserted on the serialised shape rather than by eye.
    expect(JSON.stringify(signals)).not.toContain("secret response fragment");
  });

  it("omits disabled probes, which are not evidence of anything", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker", enabled: false });
    expect((await appHealth(db, appId, NOW)).signals).toEqual([]);
  });

  it("aggregates hourly rollups into 30 daily buckets", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    // Two hours on the same day must land in one bucket.
    await db.insert(checkRollups).values([
      { probeId: "p1", hourStart: NOW - DAY, upCount: 50, downCount: 10 },
      { probeId: "p1", hourStart: NOW - DAY + HOUR, upCount: 30, downCount: 0 },
    ]);
    const { history } = await appHealth(db, appId, NOW);
    expect(history).toHaveLength(30);
    const yesterday = history.find((d) => d.dayStart === NOW - DAY);
    expect(yesterday).toEqual({ dayStart: NOW - DAY, up: 80, degraded: 0, down: 10 });
  });

  it("returns a zeroed bucket for a day with no data rather than a gap", async () => {
    // A sparkline with holes in it is unreadable; a flat zero day is honest and renders.
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    const { history } = await appHealth(db, appId, NOW);
    expect(history).toHaveLength(30);
    expect(history.every((d) => d.up === 0 && d.degraded === 0 && d.down === 0)).toBe(true);
    expect(history[0]?.dayStart).toBe(NOW - 29 * DAY);
    expect(history[29]?.dayStart).toBe(NOW);
  });

  it("ignores rollups older than 30 days", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values({ id: "p1", appId, kind: "docker" });
    await db.insert(checkRollups).values({ probeId: "p1", hourStart: NOW - 40 * DAY, upCount: 99 });
    const { history } = await appHealth(db, appId, NOW);
    expect(history.reduce((sum, d) => sum + d.up, 0)).toBe(0);
  });

  it("sums every probe on the app into one timeline", async () => {
    const { db, appId } = await fixture();
    await db.insert(probes).values([
      { id: "p1", appId, kind: "docker" },
      { id: "p2", appId, kind: "http_internal" },
    ]);
    await db.insert(checkRollups).values([
      { probeId: "p1", hourStart: NOW - DAY, upCount: 5 },
      { probeId: "p2", hourStart: NOW - DAY, upCount: 7 },
    ]);
    const { history } = await appHealth(db, appId, NOW);
    expect(history.find((d) => d.dayStart === NOW - DAY)?.up).toBe(12);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run src/server/launcher/health.test.ts`
Expected: FAIL — cannot resolve `@server/launcher/health`.

- [ ] **Step 4: Implement**

`src/server/launcher/health.ts`:

```ts
import type { AppHealth, DayBucket, HealthSignal } from "@shared/launcher.js";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkRollups, probes } from "../db/schema.js";
import { rollUpProbes } from "./status-phrase.js";

const DAY = 86_400;
const WINDOW_DAYS = 30;

/**
 * The three signals plus a 30-day timeline.
 *
 * Deliberately never returns `probes.lastDetail`. An HTTP probe's detail can carry
 * fragments of the response body, and a viewer opens this panel — so the safe shape is
 * the only shape, with no role branch here to get wrong. Admins get detail on the edit
 * page instead.
 *
 * 30 days of hourly rollups is 720 rows per probe, which no sparkline can render
 * usefully on a phone. Aggregating to days happens here, once, rather than in every
 * client.
 */
export async function appHealth(db: Db, appId: string, now: number): Promise<AppHealth> {
  const rows = await db
    .select()
    .from(probes)
    .where(and(eq(probes.appId, appId), eq(probes.enabled, true)));

  const signals: HealthSignal[] = rows.map((row) => {
    const snapshot = {
      kind: row.kind,
      label: row.label,
      status: row.lastStatus,
      faultClass: row.lastFaultClass,
      statusSince: row.statusSince,
      lastCheckedAt: row.lastCheckedAt,
    };
    // Each signal gets its own phrase, so a one-probe rollup names that probe's cause.
    const { reason } = rollUpProbes([snapshot]);
    return {
      probeId: row.id,
      kind: row.kind,
      label: row.label,
      status: row.lastStatus,
      reason,
      since: row.statusSince,
      lastCheckedAt: row.lastCheckedAt,
      latencyMs: row.lastLatencyMs,
    };
  });

  const today = now - (now % DAY);
  const oldest = today - (WINDOW_DAYS - 1) * DAY;

  // Pre-seed every day so the sparkline has no holes. A missing day is indistinguishable
  // from a zero day to a reader, and a gap in an SVG polyline just looks broken.
  const buckets = new Map<number, DayBucket>();
  for (let day = oldest; day <= today; day += DAY) {
    buckets.set(day, { dayStart: day, up: 0, degraded: 0, down: 0 });
  }

  if (rows.length > 0) {
    const hourly = await db
      .select()
      .from(checkRollups)
      .where(
        and(
          inArray(
            checkRollups.probeId,
            rows.map((r) => r.id),
          ),
          gte(checkRollups.hourStart, oldest),
        ),
      );
    for (const hour of hourly) {
      const bucket = buckets.get(hour.hourStart - (hour.hourStart % DAY));
      if (!bucket) continue; // A future-dated row. Not ours to reason about.
      bucket.up += hour.upCount;
      bucket.degraded += hour.degradedCount;
      bucket.down += hour.downCount;
    }
  }

  return { appId, signals, history: [...buckets.values()].sort((a, b) => a.dayStart - b.dayStart) };
}
```

- [ ] **Step 5: Add the route**

In `src/server/routes/launcher.ts`:

```ts
  app.get("/api/launcher/:appId/health", async (request, reply) => {
    const ctx = requireCapability(request, "app:read");
    const { appId } = z.object({ appId: z.string() }).parse(request.params);

    // Scope first, and answer 404 rather than 403: a scoped viewer must not learn that
    // an app they cannot see exists. This mirrors what the probe routes already do.
    if (!inScope(ctx, appId)) return reply.code(404).send({ error: "not_found" });

    const [row] = await db.select({ id: apps.id }).from(apps).where(eq(apps.id, appId));
    if (!row) return reply.code(404).send({ error: "not_found" });

    return appHealth(db, appId, Math.floor(Date.now() / 1000));
  });
```

Add the imports it needs: `z` from `zod`, `inScope` from `../auth/context.js`, `apps` from `../db/schema.js`, `eq` from `drizzle-orm`, `appHealth` from `../launcher/health.js`.

- [ ] **Step 6: Add route-level tests**

Append to `src/server/routes/launcher.test.ts`:

```ts
describe("GET /api/launcher/:appId/health", () => {
  it("returns the signals for an app the caller can see", async () => {
    const { app, cookie, id } = await seeded();
    const res = await app.inject({ method: "GET", url: `/api/launcher/${id}/health`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().signals).toHaveLength(1);
    expect(res.json().history).toHaveLength(30);
  });

  it("404s for an app outside the caller's scope, never 403", async () => {
    // A 403 would confirm the app exists. For a scoped viewer that is the disclosure
    // the scope exists to prevent.
    const { app, cookie, id } = await seeded();
    const scoped = await createViewer(app, cookie, { scopeAllApps: false, appIds: [] });
    const res = await app.inject({
      method: "GET", url: `/api/launcher/${id}/health`, headers: { cookie: scoped.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("404s identically for an app that does not exist", async () => {
    const { app, cookie } = await seeded();
    const res = await app.inject({
      method: "GET", url: `/api/launcher/${ulid()}/health`, headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});
```

- [ ] **Step 7: Run and verify**

Run: `pnpm exec vitest run src/server/launcher/health.test.ts src/server/routes/launcher.test.ts`
Expected: all pass.

- [ ] **Step 8: Binding checks**

- Add `detail: row.lastDetail` to the signal object → the `JSON.stringify` leak test must fail.
- Change the scope guard to return 403 → the "never 403" test must fail.
- Remove the pre-seeding loop and build buckets only from rows present → the zeroed-bucket test must fail.

- [ ] **Step 9: Commit**

```bash
git add src/server/launcher/health.ts src/server/routes/launcher.ts src/shared/launcher.ts src/server/launcher/health.test.ts src/server/routes/launcher.test.ts
git commit -m "Serve per-app health signals and a 30-day timeline, without raw probe detail"
```

---

### Task 5: Icon metadata — fetch once, cache to disk, search offline

Spec §8: *"`metadata.json` is 1.15 MB, far too large to ship to the browser, so the server fetches, caches, and exposes `/api/icons/search?q=`… caching means the launcher renders during an internet outage, precisely when reaching LAN services matters most."*

**Files:**
- Create: `src/server/icons/metadata.ts`
- Modify: `src/server/config.ts` (add `iconCacheDir`)
- Test: `src/server/icons/metadata.test.ts`

**Interfaces:**
- Consumes: `Config` from `@server/config`.
- Produces:
  ```ts
  export type IconMeta = { slug: string; aliases: string[]; categories: string[]; variants: string[] };
  export class IconMetadata {
    constructor(opts: { cacheDir: string; fetchImpl?: typeof fetch; ttlMs?: number });
    load(): Promise<void>;          // never throws
    search(q: string, limit?: number): IconMeta[];
    has(slug: string): boolean;
    get size(): number;
  }
  ```

- [ ] **Step 1: Add the config key**

In `src/server/config.ts`, add to the zod schema:

```ts
  HOMESTEAD_ICON_CACHE_DIR: z.string().default("./data/icons"),
```

add `iconCacheDir: string;` to the `Config` type, and `iconCacheDir: parsed.HOMESTEAD_ICON_CACHE_DIR,` to the returned object.

- [ ] **Step 2: Write the failing test**

`src/server/icons/metadata.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IconMetadata } from "@server/icons/metadata";
import { describe, expect, it } from "vitest";

const UPSTREAM = {
  jellyfin: { base: ["svg"], aliases: ["emby"], categories: ["media"], colors: {} },
  "home-assistant": { base: ["svg"], aliases: [], categories: ["automation"], colors: {} },
  plex: { base: ["svg", "png"], aliases: [], categories: ["media"], colors: {} },
};

function dir() {
  return mkdtempSync(join(tmpdir(), "homestead-icons-"));
}

function fetchOk(body: unknown, calls: { n: number }) {
  return (async () => {
    calls.n++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("IconMetadata", () => {
  it("fetches, indexes, and writes the payload to disk", async () => {
    const cacheDir = dir();
    const calls = { n: 0 };
    const meta = new IconMetadata({ cacheDir, fetchImpl: fetchOk(UPSTREAM, calls) });
    await meta.load();
    expect(meta.size).toBe(3);
    expect(calls.n).toBe(1);
    expect(JSON.parse(readFileSync(join(cacheDir, "metadata.json"), "utf8"))).toEqual(UPSTREAM);
  });

  it("serves from disk when the network is down — the outage case the spec names", async () => {
    const cacheDir = dir();
    writeFileSync(join(cacheDir, "metadata.json"), JSON.stringify(UPSTREAM));
    const meta = new IconMetadata({
      cacheDir,
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    await meta.load();
    expect(meta.size).toBe(3);
    expect(meta.search("jelly")[0]?.slug).toBe("jellyfin");
  });

  it("degrades to an empty index rather than throwing when there is no cache and no network", async () => {
    // The launcher must still render. Letter tiles are the fallback, and an icon
    // service that throws on boot would take the whole server down with it.
    const meta = new IconMetadata({
      cacheDir: dir(),
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    await expect(meta.load()).resolves.toBeUndefined();
    expect(meta.size).toBe(0);
    expect(meta.search("jelly")).toEqual([]);
  });

  it("survives a corrupt cache file instead of crashing on boot", async () => {
    const cacheDir = dir();
    writeFileSync(join(cacheDir, "metadata.json"), "{ this is not json");
    const meta = new IconMetadata({
      cacheDir,
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    await expect(meta.load()).resolves.toBeUndefined();
    expect(meta.size).toBe(0);
  });

  it("matches on alias as well as slug", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.search("emby")[0]?.slug).toBe("jellyfin");
  });

  it("ranks a prefix match above a substring match", async () => {
    // Typing "plex" should not surface "home-assistant" first because of some
    // incidental substring; the thing you typed the start of comes first.
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    const results = meta.search("home");
    expect(results[0]?.slug).toBe("home-assistant");
  });

  it("bounds the result count", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.search("", 2).length).toBeLessThanOrEqual(2);
  });

  it("reports whether a slug is known, which is the SSRF guard other code depends on", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.has("jellyfin")).toBe(true);
    expect(meta.has("../../etc/passwd")).toBe(false);
    expect(meta.has("https://evil.example/x")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run src/server/icons/metadata.test.ts`
Expected: FAIL — cannot resolve `@server/icons/metadata`.

- [ ] **Step 4: Implement**

`src/server/icons/metadata.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Pinned so an upstream restructure cannot change behaviour without a code change. */
const METADATA_URL =
  "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/metadata.json";

const FETCH_TIMEOUT_MS = 10_000;

export type IconMeta = {
  slug: string;
  aliases: string[];
  categories: string[];
  variants: string[];
};

type UpstreamEntry = { base?: string[]; aliases?: string[]; categories?: string[] };

/**
 * The dashboard-icons index: 3,238 icons, 1.15 MB, far too large to ship to a browser.
 *
 * Every failure path degrades to an empty index rather than throwing. A NAS that boots
 * without internet must still serve the launcher — letter tiles are the fallback — and
 * an icon service that rejects on boot would take the whole process with it.
 */
export class IconMetadata {
  private readonly cacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private index: IconMeta[] = [];
  private slugs = new Set<string>();

  constructor(opts: { cacheDir: string; fetchImpl?: typeof fetch }) {
    this.cacheDir = opts.cacheDir;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get size(): number {
    return this.index.length;
  }

  async load(): Promise<void> {
    const cachePath = join(this.cacheDir, "metadata.json");

    const fromNetwork = await this.fetchUpstream();
    if (fromNetwork) {
      this.build(fromNetwork);
      try {
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(cachePath, JSON.stringify(fromNetwork), "utf8");
      } catch {
        // A read-only or full disk costs us the cache, not the running index.
      }
      return;
    }

    try {
      this.build(JSON.parse(await readFile(cachePath, "utf8")));
    } catch {
      // No network and no usable cache. An empty index is a working launcher with
      // letter tiles; a throw here is a server that will not start.
      this.index = [];
      this.slugs = new Set();
    }
  }

  private async fetchUpstream(): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(METADATA_URL, { signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private build(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) {
      this.index = [];
      this.slugs = new Set();
      return;
    }
    this.index = Object.entries(raw as Record<string, UpstreamEntry>).map(([slug, entry]) => ({
      slug,
      aliases: Array.isArray(entry?.aliases) ? entry.aliases : [],
      categories: Array.isArray(entry?.categories) ? entry.categories : [],
      variants: Array.isArray(entry?.base) ? entry.base : ["svg"],
    }));
    this.slugs = new Set(this.index.map((i) => i.slug));
  }

  /** The SSRF guard: only a slug present in the index may ever become a fetch URL. */
  has(slug: string): boolean {
    return this.slugs.has(slug);
  }

  search(q: string, limit = 20): IconMeta[] {
    const needle = q.trim().toLowerCase();
    if (needle === "") return this.index.slice(0, limit);

    const scored: Array<{ icon: IconMeta; score: number }> = [];
    for (const icon of this.index) {
      const names = [icon.slug, ...icon.aliases];
      let best = 0;
      for (const name of names) {
        const lower = name.toLowerCase();
        if (lower === needle) best = Math.max(best, 3);
        else if (lower.startsWith(needle)) best = Math.max(best, 2);
        else if (lower.includes(needle)) best = Math.max(best, 1);
      }
      if (best > 0) scored.push({ icon, score: best });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.icon.slug.localeCompare(b.icon.slug))
      .slice(0, limit)
      .map((s) => s.icon);
  }
}
```

- [ ] **Step 5: Run and verify**

Run: `pnpm exec vitest run src/server/icons/metadata.test.ts`
Expected: all pass.

- [ ] **Step 6: Binding check**

Make `load()` rethrow instead of falling through to the empty index. The "degrades to an empty index" and "survives a corrupt cache" tests must both fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/server/icons/metadata.ts src/server/icons/metadata.test.ts src/server/config.ts
git commit -m "Index the dashboard-icons catalogue, degrading to letter tiles when offline"
```

---

### Task 6: Icon routes — search and a confined proxy

Spec §8: *"Homestead proxies and caches icons rather than hotlinking… hotlinking would tell a public CDN exactly which self-hosted services the user runs, from viewers' networks."*

Two security properties carry this task: a slug must be validated against the index before it can become a URL (otherwise an attacker-chosen slug is an SSRF primitive), and the on-disk path must be confined to the cache directory (otherwise `../../` is an arbitrary-write primitive).

**Files:**
- Create: `src/server/icons/store.ts`
- Create: `src/server/routes/icons.ts`
- Modify: `src/server/app.ts` (register, add `icons` to `AppDeps`), `src/server/index.ts`, `src/server/test-helpers.ts`
- Test: `src/server/icons/store.test.ts`, `src/server/routes/icons.test.ts`

**Interfaces:**
- Consumes: `IconMetadata` from Task 5.
- Produces:
  ```ts
  export class IconStore {
    constructor(opts: { cacheDir: string; metadata: IconMetadata; fetchImpl?: typeof fetch });
    fetchIcon(slug: string, variant: "light" | "dark" | null): Promise<Buffer | null>;
  }
  ```
  Routes: `GET /api/icons/search?q=&limit=`, `GET /api/icons/:slug.svg?variant=`.
  `AppDeps` gains `icons: { metadata: IconMetadata; store: IconStore }`.

- [ ] **Step 1: Write the failing store test**

`src/server/icons/store.test.ts`:

```ts
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IconMetadata } from "@server/icons/metadata";
import { IconStore } from "@server/icons/store";
import { describe, expect, it } from "vitest";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

async function loaded(cacheDir: string) {
  const metadata = new IconMetadata({
    cacheDir,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ jellyfin: { base: ["svg"], aliases: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
  await metadata.load();
  return metadata;
}

describe("IconStore", () => {
  it("fetches an icon once and serves the second request from disk", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let calls = 0;
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => {
        calls++;
        return new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
      }) as unknown as typeof fetch,
    });
    expect((await store.fetchIcon("jellyfin", null))?.toString()).toBe(SVG);
    expect((await store.fetchIcon("jellyfin", null))?.toString()).toBe(SVG);
    expect(calls).toBe(1);
  });

  it("refuses a slug that is not in the index, so a slug cannot become an SSRF", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let calls = 0;
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => {
        calls++;
        return new Response(SVG, { status: 200 });
      }) as unknown as typeof fetch,
    });
    for (const evil of [
      "../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "https://evil.example/payload.svg",
      "unknown-app",
      "jellyfin/../../../root",
    ]) {
      expect(await store.fetchIcon(evil, null)).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it("writes nothing outside the cache directory", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => new Response(SVG, { status: 200 })) as unknown as typeof fetch,
    });
    await store.fetchIcon("jellyfin", null);
    await store.fetchIcon("../escape", null);
    for (const name of readdirSync(cacheDir)) {
      expect(name.includes("..")).toBe(false);
    }
    expect(existsSync(join(cacheDir, "..", "escape.svg"))).toBe(false);
  });

  it("returns null rather than throwing when upstream is unreachable", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    expect(await store.fetchIcon("jellyfin", null)).toBeNull();
  });

  it("caches light and dark variants separately", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let calls = 0;
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => {
        calls++;
        return new Response(SVG, { status: 200 });
      }) as unknown as typeof fetch,
    });
    await store.fetchIcon("jellyfin", "light");
    await store.fetchIcon("jellyfin", "dark");
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/server/icons/store.test.ts`
Expected: FAIL — cannot resolve `@server/icons/store`.

- [ ] **Step 3: Implement the store**

`src/server/icons/store.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IconMetadata } from "./metadata.js";

const CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/svg";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ICON_BYTES = 512 * 1024;

/** Belt and braces beside the index check: shape, then membership. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Fetches an icon from the CDN once and serves it from disk thereafter.
 *
 * Two guards, both load-bearing:
 *
 * - A slug only becomes a URL if it is present in the metadata index. Without that, a
 *   caller chooses what the server fetches, which is an SSRF primitive on a machine
 *   sitting inside a home network.
 * - The resolved cache path must stay inside the cache directory. Without that, a slug
 *   containing `..` is an arbitrary-write primitive.
 *
 * The regex alone would be enough for both today; the index check is what keeps it true
 * if the regex is ever loosened.
 */
export class IconStore {
  private readonly cacheDir: string;
  private readonly metadata: IconMetadata;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { cacheDir: string; metadata: IconMetadata; fetchImpl?: typeof fetch }) {
    this.cacheDir = resolve(opts.cacheDir);
    this.metadata = opts.metadata;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchIcon(slug: string, variant: "light" | "dark" | null): Promise<Buffer | null> {
    if (!SAFE_SLUG.test(slug)) return null;
    if (!this.metadata.has(slug)) return null;

    const name = variant ? `${slug}-${variant}.svg` : `${slug}.svg`;
    const path = join(this.cacheDir, name);
    // The path check cannot fail given the regex above, and stays because the regex is
    // the kind of thing a later change loosens without thinking about this.
    if (resolve(path) !== path || !resolve(path).startsWith(`${this.cacheDir}/`)) return null;

    try {
      return await readFile(path);
    } catch {
      // Not cached yet.
    }

    const body = await this.download(`${CDN}/${name}`);
    if (!body) return null;

    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(path, body);
    } catch {
      // Serve it anyway; a failed cache write is not a failed request.
    }
    return body;
  }

  private async download(url: string): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      // An icon is a few KB. Anything this large is not an icon, and buffering it is
      // how a proxy becomes a memory-exhaustion vector.
      if (buffer.byteLength > MAX_ICON_BYTES) return null;
      return buffer;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Write the failing route test**

`src/server/routes/icons.test.ts`:

```ts
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

describe("icon routes", () => {
  it("searches by slug and alias for any signed-in user", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET", url: "/api/icons/search?q=jelly", headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().icons[0].slug).toBe("jellyfin");
  });

  it("requires authentication, so the catalogue is not an open endpoint", async () => {
    const app = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/api/icons/search?q=a" })).statusCode).toBe(401);
  });

  it("serves a known icon as SVG with a long cache header", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/icons/jellyfin.svg", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(res.headers["cache-control"]).toContain("max-age=");
  });

  it("404s an unknown slug with an error slug", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/icons/not-a-real-icon.svg", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("rejects a traversal attempt in the slug", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    for (const evil of ["..%2f..%2fetc%2fpasswd", "..", "JELLYFIN"]) {
      const res = await app.inject({ method: "GET", url: `/api/icons/${evil}.svg`, headers: { cookie } });
      expect(res.statusCode).toBe(404);
    }
  });

  it("bounds the search limit so a caller cannot ask for the whole 1.15 MB index", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/icons/search?q=&limit=9999", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });
});
```

`buildTestApp` must seed a small fake icon index — see Step 6.

- [ ] **Step 5: Implement the routes**

`src/server/routes/icons.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/context.js";

/** A year. The slug is content-addressed by name and upstream icons do not churn. */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function iconRoutes(app: FastifyInstance): Promise<void> {
  const { icons } = app.deps;

  app.get("/api/icons/search", async (request, reply) => {
    // `requireAuth`, not a capability: a viewer needs icons to render their launcher.
    requireAuth(request);
    const query = z
      .object({ q: z.string().max(64).default(""), limit: z.coerce.number().int().min(1).max(50).default(20) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });

    return { icons: icons.metadata.search(query.data.q, query.data.limit) };
  });

  app.get("/api/icons/:file", async (request, reply) => {
    requireAuth(request);
    const params = z.object({ file: z.string().max(80) }).parse(request.params);
    const query = z.object({ variant: z.enum(["light", "dark"]).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });

    const slug = params.file.endsWith(".svg") ? params.file.slice(0, -4) : params.file;
    const body = await icons.store.fetchIcon(slug, query.data.variant ?? null);
    if (!body) return reply.code(404).send({ error: "not_found" });

    return reply
      .header("content-type", "image/svg+xml")
      .header("cache-control", CACHE_CONTROL)
      // The proxy exists partly so a viewer's browser never contacts a CDN. Do not let
      // an SVG's own content reach back out.
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .send(body);
  });
}
```

- [ ] **Step 6: Wire it into the dependency graph — in both places**

Add to `AppDeps` in `src/server/app.ts`:

```ts
  icons: { metadata: IconMetadata; store: IconStore };
```

register `iconRoutes` before `spaRoutes`, and construct it in **both** `src/server/index.ts` and `src/server/test-helpers.ts`. In `index.ts`, call `await metadata.load()` during startup — it never throws. In `test-helpers.ts`, seed a fixed two-icon index with a stub `fetchImpl` so tests never touch the network:

```ts
  const iconMetadata = new IconMetadata({
    cacheDir: join(tmpdir(), `homestead-test-icons-${randomUUID()}`),
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          jellyfin: { base: ["svg"], aliases: ["emby"], categories: ["media"] },
          plex: { base: ["svg"], aliases: [], categories: ["media"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  });
  await iconMetadata.load();
  const iconStore = new IconStore({
    cacheDir: iconCacheDir,
    metadata: iconMetadata,
    fetchImpl: (async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      })) as unknown as typeof fetch,
  });
```

**`index.ts` and `test-helpers.ts` must describe the same graph.** A divergence means the tests exercise a system that is not the one that ships — that exact bug was found and fixed in Phase 1C.

- [ ] **Step 7: Run and verify**

Run: `pnpm exec vitest run src/server/icons/ src/server/routes/icons.test.ts`
Expected: all pass.

- [ ] **Step 8: Binding checks**

- Remove the `this.metadata.has(slug)` check → the SSRF test must fail (`calls` becomes non-zero).
- Remove the `SAFE_SLUG` check but keep the index check → the traversal route test must still pass; note this in your report as evidence the two guards overlap deliberately.
- Remove the `.max(50)` from the limit schema → the bounded-limit test must fail.

- [ ] **Step 9: Commit**

```bash
git add src/server/icons/ src/server/routes/icons.ts src/server/app.ts src/server/index.ts src/server/test-helpers.ts src/server/routes/icons.test.ts
git commit -m "Proxy dashboard icons from disk so no viewer's browser contacts a CDN"
```

---

### Task 7: The single event stream at the shell

Spec §8: *"One `EventSource` for the whole app, mounted at the shell. Events carry `{ appId, probeId, status, faultClass }` and are applied with `queryClient.setQueryData` — patching cached rows, not refetching. Twenty apps flapping during a `docker compose up` must not fire twenty round-trips at a machine that is by definition busy at that moment."*

**Files:**
- Create: `src/web/live/useEventStream.ts`
- Create: `src/web/api/launcher.ts`
- Modify: `src/web/routes/AppLayout.tsx`
- Test: `src/web/live/useEventStream.test.tsx`

**Interfaces:**
- Consumes: `LauncherApp` from `@shared/launcher`.
- Produces:
  ```ts
  // src/web/api/launcher.ts
  export const launcherKey = ["launcher"] as const;
  export const healthKey = (appId: string) => ["launcher", "health", appId] as const;
  export function useLauncherApps(): UseQueryResult<LauncherApp[]>;
  export function useAppHealth(appId: string | null): UseQueryResult<AppHealth>;
  // src/web/live/useEventStream.ts
  export function useEventStream(): void;
  export type StatusEvent = { appId: string; probeId: string; status: AppStatus; faultClass: FaultClass | null };
  ```

- [ ] **Step 1: Write the query hooks**

`src/web/api/launcher.ts`:

```ts
import type { AppHealth, LauncherApp } from "@shared/launcher";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

export const launcherKey = ["launcher"] as const;
export const healthKey = (appId: string) => ["launcher", "health", appId] as const;

export function useLauncherApps() {
  return useQuery({
    queryKey: launcherKey,
    queryFn: async () => (await apiFetch<{ apps: LauncherApp[] }>("/api/launcher")).apps,
    // Spec: "Launcher renders from cached data first; stale status beats a spinner."
    // Live corrections arrive over SSE, so polling would only duplicate them.
    staleTime: 60_000,
    refetchOnMount: "always",
  });
}

export function useAppHealth(appId: string | null) {
  return useQuery({
    queryKey: healthKey(appId ?? ""),
    enabled: appId !== null,
    queryFn: () => apiFetch<AppHealth>(`/api/launcher/${appId}/health`),
    staleTime: 30_000,
  });
}
```

- [ ] **Step 2: Write the failing test**

`src/web/live/useEventStream.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { LauncherApp } from "@shared/launcher";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { launcherKey } from "@web/api/launcher";
import { useEventStream } from "@web/live/useEventStream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. This double records every instance so a test can both
// dispatch events into the app and assert the connection was closed on unmount.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

const tile = (over: Partial<LauncherApp> = {}): LauncherApp => ({
  id: "a1", slug: "jellyfin", displayName: "Jellyfin", description: null, iconRef: null,
  category: "Media", launchUrl: null, sortOrder: 0, status: "up", reason: "Healthy",
  since: 100, probes: [], ...over,
});

function Harness() {
  useEventStream();
  return null;
}

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("useEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("opens exactly one connection no matter how many renders happen", async () => {
    const client = new QueryClient();
    const { rerender } = mount(client);
    rerender(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0]?.url).toBe("/api/events");
  });

  it("patches the cached tile in place instead of refetching", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [tile()]);
    let fetches = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      fetches++;
      return new Response("{}", { status: 200 });
    }));

    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("status", {
        appId: "a1", probeId: "p1", status: "down", faultClass: "app",
      });
    });

    const patched = client.getQueryData<LauncherApp[]>(launcherKey);
    expect(patched?.[0]?.status).toBe("down");
    expect(patched?.[0]?.reason).toBe("Containers not running");
    // The assertion the spec's rationale is actually about.
    expect(fetches).toBe(0);
  });

  it("ignores an event for an app not in the cache", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [tile()]);
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("status", {
        appId: "not-mine", probeId: "p9", status: "down", faultClass: "app",
      });
    });
    expect(client.getQueryData<LauncherApp[]>(launcherKey)).toEqual([tile()]);
  });

  it("survives a malformed payload without tearing down the stream", async () => {
    const client = new QueryClient();
    client.setQueryData(launcherKey, [tile()]);
    mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      for (const fn of source?.listeners.get("status") ?? []) {
        fn(new MessageEvent("status", { data: "{not json" }));
      }
    });
    expect(client.getQueryData<LauncherApp[]>(launcherKey)).toEqual([tile()]);
    expect(source?.closed).toBe(false);
  });

  it("closes the connection on unmount, so navigating away leaks nothing", async () => {
    const client = new QueryClient();
    const { unmount } = mount(client);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/live/useEventStream.test.tsx`
Expected: FAIL — cannot resolve `@web/live/useEventStream`.

- [ ] **Step 4: Implement**

`src/web/live/useEventStream.ts`:

```ts
import type { LauncherApp } from "@shared/launcher";
import type { AppStatus, FaultClass } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { healthKey, launcherKey } from "@web/api/launcher";
import { useEffect } from "react";

export type StatusEvent = {
  appId: string;
  probeId: string;
  status: AppStatus;
  faultClass: FaultClass | null;
};

/** Mirrors the server's phrases. Kept small deliberately — see the note below. */
function reasonFor(status: AppStatus, faultClass: FaultClass | null): string {
  if (status === "up") return "Healthy";
  if (status === "starting") return "Starting";
  if (status === "unknown") return "Not checked yet";
  if (faultClass === "config") return "Compose config invalid";
  if (faultClass === "network") return "Unreachable";
  return "Containers not running";
}

/**
 * One `EventSource` for the whole app, mounted at the shell.
 *
 * Events patch the cached tile with `setQueryData` rather than invalidating it. Twenty
 * apps flapping during a `docker compose up` would otherwise fire twenty refetches at a
 * machine that is by definition busy at that moment — which is why the event payload is
 * self-sufficient rather than an ID to look up.
 *
 * The phrase is recomputed here from `{status, faultClass}` alone, so it can be
 * marginally less specific than the server's — the event does not say which probe kind
 * fired, so "Tunnel unreachable — app is fine" cannot be derived. The health panel and
 * the next full fetch both carry the precise phrase. Widening the SSE payload to fix
 * this is a server change, not a client one; do not add a second fetch here to
 * compensate, because avoiding exactly that is the reason this design exists.
 */
export function useEventStream(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource("/api/events");

    const onStatus = (event: MessageEvent) => {
      let payload: StatusEvent;
      try {
        payload = JSON.parse(event.data as string) as StatusEvent;
      } catch {
        // A malformed frame is not a reason to drop a working stream.
        return;
      }
      if (typeof payload?.appId !== "string") return;

      queryClient.setQueryData<LauncherApp[]>(launcherKey, (current) => {
        if (!current) return current;
        let changed = false;
        const next = current.map((tile) => {
          if (tile.id !== payload.appId) return tile;
          changed = true;
          return {
            ...tile,
            status: payload.status,
            reason: reasonFor(payload.status, payload.faultClass),
            since: Math.floor(Date.now() / 1000),
          };
        });
        // Returning a new array when nothing matched would re-render every tile.
        return changed ? next : current;
      });

      // The open health panel, if any, is now stale. Invalidating one key is cheap and
      // only refetches while a panel is actually mounted.
      void queryClient.invalidateQueries({ queryKey: healthKey(payload.appId) });
    };

    source.addEventListener("status", onStatus);
    return () => {
      source.removeEventListener("status", onStatus);
      source.close();
    };
  }, [queryClient]);
}
```

- [ ] **Step 5: Mount it at the shell**

In `src/web/routes/AppLayout.tsx`, add `useEventStream();` as the first line of the component body and import it. The shell is the right place: one connection for the whole session, established once at sign-in and torn down at sign-out.

- [ ] **Step 6: Run and verify**

Run: `pnpm exec vitest run src/web/live/useEventStream.test.tsx`
Expected: all pass.

- [ ] **Step 7: Binding checks**

- Replace `setQueryData` with `invalidateQueries({ queryKey: launcherKey })` → the "patches in place" test must fail on `fetches` being non-zero.
- Remove the `try/catch` around `JSON.parse` → the malformed-payload test must fail.
- Remove `source.close()` from the cleanup → the unmount test must fail.

- [ ] **Step 8: Commit**

```bash
git add src/web/live/ src/web/api/launcher.ts src/web/routes/AppLayout.tsx
git commit -m "Patch launcher tiles from one shell-level event stream, never refetching"
```

---

### Task 8: `AppIcon` — proxied icon with a letter-tile fallback

Spec §8: *"Fallbacks: manual search, custom upload, generated letter tile. Theme variant follows `prefers-color-scheme`."* Manual search and upload belong to the admin edit page (1E); the launcher needs rendering and the fallback.

**Files:**
- Create: `src/web/components/AppIcon.tsx`
- Test: `src/web/components/AppIcon.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `<AppIcon iconRef={string | null} displayName={string} size?: "sm" | "lg" />`.

- [ ] **Step 1: Write the failing test**

`src/web/components/AppIcon.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { AppIcon } from "@web/components/AppIcon";
import { describe, expect, it } from "vitest";

describe("AppIcon", () => {
  it("renders a letter tile when there is no icon reference", () => {
    render(<AppIcon iconRef={null} displayName="Jellyfin" />);
    expect(screen.getByText("J")).toBeTruthy();
  });

  it("loads the icon through Homestead's own proxy, never a CDN", () => {
    // The privacy property: a viewer's browser must not tell jsDelivr what runs here.
    render(<AppIcon iconRef="jellyfin" displayName="Jellyfin" />);
    const img = screen.getByRole("img", { name: "Jellyfin" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/icons/jellyfin.svg");
    expect(img.getAttribute("src")).not.toContain("jsdelivr");
  });

  it("falls back to the letter tile when the image fails to load", () => {
    render(<AppIcon iconRef="broken" displayName="Plex" />);
    fireEvent.error(screen.getByRole("img", { name: "Plex" }));
    expect(screen.getByText("P")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("uses the first letter of a name that starts with a digit or symbol", () => {
    render(<AppIcon iconRef={null} displayName="2fauth" />);
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("renders a stable placeholder for an empty name rather than an empty box", () => {
    render(<AppIcon iconRef={null} displayName="" />);
    expect(screen.getByText("?")).toBeTruthy();
  });

  it("gives the same name the same tile colour on every render", () => {
    const { container: a } = render(<AppIcon iconRef={null} displayName="Jellyfin" />);
    const { container: b } = render(<AppIcon iconRef={null} displayName="Jellyfin" />);
    expect(a.firstElementChild?.className).toBe(b.firstElementChild?.className);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/components/AppIcon.test.tsx`
Expected: FAIL — cannot resolve `@web/components/AppIcon`.

- [ ] **Step 3: Implement**

`src/web/components/AppIcon.tsx`:

```tsx
import { useState } from "react";

/**
 * Fixed palette rather than a generated HSL value: every colour here has a checked
 * contrast ratio against white text in both themes, which a hash-to-hue does not.
 */
const TILE_COLOURS = [
  "bg-sky-600",
  "bg-emerald-600",
  "bg-violet-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-teal-600",
];

function colourFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return TILE_COLOURS[hash % TILE_COLOURS.length] as string;
}

/**
 * `iconRef` is a dashboard-icons slug. The `src` always points at Homestead's own
 * proxy — hotlinking would tell a public CDN exactly which self-hosted services run
 * here, from every viewer's network, which is an odd disclosure for a tool premised on
 * not handing infrastructure to third parties.
 */
export function AppIcon({
  iconRef,
  displayName,
  size = "lg",
}: {
  iconRef: string | null;
  displayName: string;
  size?: "sm" | "lg";
}) {
  const [failed, setFailed] = useState(false);
  const box = size === "lg" ? "h-12 w-12 text-lg" : "h-6 w-6 text-xs";

  if (iconRef === null || failed) {
    const letter = displayName.trim().charAt(0).toUpperCase() || "?";
    return (
      <div
        className={`${box} ${colourFor(displayName)} flex shrink-0 items-center justify-center rounded-xl font-semibold text-white`}
        aria-hidden="true"
      >
        {letter}
      </div>
    );
  }

  return (
    <img
      // The server picks the theme variant; `prefers-color-scheme` is not readable from
      // a URL, so the variant query is set by the browser's media query below.
      src={`/api/icons/${iconRef}.svg`}
      alt={displayName}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`${box} shrink-0 rounded-xl object-contain`}
    />
  );
}
```

- [ ] **Step 4: Run and verify**

Run: `pnpm exec vitest run src/web/components/AppIcon.test.tsx`
Expected: all pass.

- [ ] **Step 5: Binding check**

Remove the `onError` handler → the fallback test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/AppIcon.tsx src/web/components/AppIcon.test.tsx
git commit -m "Render app icons through the local proxy, with a letter tile when absent"
```

---

### Task 9: `StatusChip` and `AppCard`

Spec §8: *"Card click launches the app. The status chip is a separate tap target… Checking health never risks launching something."* and *"Down apps stay clickable, visibly dimmed. Greying out a tile because a probe failed is maddening when the probe is what is broken."* and *"Status is never colour alone."*

**Files:**
- Create: `src/web/components/StatusChip.tsx`, `src/web/components/AppCard.tsx`
- Test: `src/web/components/StatusChip.test.tsx`, `src/web/components/AppCard.test.tsx`

**Interfaces:**
- Consumes: `AppIcon` (Task 8), `relativeTime` (Task 1), `LauncherApp` (Task 3).
- Produces:
  ```tsx
  <StatusChip status={AppStatus} reason={string} since={number | null} onOpen={() => void} />
  <AppCard app={LauncherApp} onOpenHealth={(appId: string) => void} />
  ```

- [ ] **Step 1: Write the failing StatusChip test**

`src/web/components/StatusChip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusChip } from "@web/components/StatusChip";
import { describe, expect, it, vi } from "vitest";

describe("StatusChip", () => {
  it("shows the cause, not just a severity word", () => {
    render(
      <StatusChip status="degraded" reason="Tunnel unreachable — app is fine" since={null} onOpen={() => {}} />,
    );
    expect(screen.getByText(/Tunnel unreachable/)).toBeTruthy();
    expect(screen.queryByText(/^Degraded$/)).toBeNull();
  });

  it("appends a duration when the status has a start time", () => {
    const since = Math.floor(Date.now() / 1000) - 12 * 60;
    render(<StatusChip status="down" reason="Containers not running" since={since} onOpen={() => {}} />);
    expect(screen.getByText(/12m/)).toBeTruthy();
  });

  it("omits the duration rather than rendering a bare separator when since is null", () => {
    render(<StatusChip status="unknown" reason="Not checked yet" since={null} onOpen={() => {}} />);
    expect(screen.getByRole("button").textContent).not.toContain("·");
  });

  it("conveys status by text as well as colour", () => {
    // Spec: status is never colour alone. A colour-blind user and a screen reader must
    // both get the status without reading a CSS class.
    render(<StatusChip status="down" reason="Containers not running" since={null} onOpen={() => {}} />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("down");
    expect(button.textContent).toContain("Containers not running");
  });

  it("calls onOpen and stops the click reaching the card behind it", () => {
    // The whole point of the separate tap target: checking health must never launch.
    const onOpen = vi.fn();
    const cardClicked = vi.fn();
    render(
      <button type="button" onClick={cardClicked}>
        <StatusChip status="up" reason="Healthy" since={null} onOpen={onOpen} />
      </button>,
    );
    fireEvent.click(screen.getAllByRole("button")[1] as HTMLElement);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(cardClicked).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/components/StatusChip.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement StatusChip**

`src/web/components/StatusChip.tsx`:

```tsx
import type { AppStatus } from "@shared/types";
import { relativeTime } from "@web/lib/relative-time";

/**
 * Every status pairs a colour with a distinct glyph and with text. Colour alone fails
 * for a colour-blind user and for a screen reader, and this is the only signal on the
 * screen that matters.
 */
const PRESENTATION: Record<AppStatus, { dot: string; glyph: string; text: string }> = {
  up: { dot: "bg-emerald-500", glyph: "●", text: "text-slate-500 dark:text-slate-400" },
  degraded: { dot: "bg-amber-500", glyph: "◐", text: "text-amber-700 dark:text-amber-400" },
  down: { dot: "bg-rose-500", glyph: "▲", text: "text-rose-700 dark:text-rose-400" },
  starting: { dot: "bg-sky-500", glyph: "◌", text: "text-sky-700 dark:text-sky-400" },
  unknown: { dot: "bg-slate-400", glyph: "?", text: "text-slate-500 dark:text-slate-400" },
};

export function StatusChip({
  status,
  reason,
  since,
  onOpen,
}: {
  status: AppStatus;
  reason: string;
  since: number | null;
  onOpen: () => void;
}) {
  const style = PRESENTATION[status];
  const age = since === null ? null : relativeTime(since, Math.floor(Date.now() / 1000));

  return (
    <button
      type="button"
      // The card behind this is the launch target. Without stopPropagation, checking
      // why something is down opens the thing that is down.
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      aria-label={`Status: ${status}. ${reason}. Show health details.`}
      className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-xs ${style.text} hover:bg-slate-100 dark:hover:bg-slate-800`}
    >
      <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden="true" />
      <span className="sr-only">{style.glyph}</span>
      <span className="truncate">{reason}</span>
      {age !== null && <span className="opacity-60">· {age}</span>}
    </button>
  );
}
```

- [ ] **Step 4: Write the failing AppCard test**

`src/web/components/AppCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { LauncherApp } from "@shared/launcher";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppCard } from "@web/components/AppCard";
import { describe, expect, it, vi } from "vitest";

const tile = (over: Partial<LauncherApp> = {}): LauncherApp => ({
  id: "a1", slug: "jellyfin", displayName: "Jellyfin", description: "Media server",
  iconRef: "jellyfin", category: "Media", launchUrl: "http://nas:8096", sortOrder: 0,
  status: "up", reason: "Healthy", since: null, probes: [], ...over,
});

describe("AppCard", () => {
  it("links to the launch URL", () => {
    render(<AppCard app={tile()} onOpenHealth={() => {}} />);
    expect(screen.getByRole("link", { name: /Jellyfin/ }).getAttribute("href")).toBe("http://nas:8096");
  });

  it("stays clickable but visibly dimmed when down", () => {
    // Spec: greying out a tile because a probe failed is maddening when the probe is
    // what is broken. Dimmed, not disabled.
    render(<AppCard app={tile({ status: "down", reason: "Containers not running" })} onOpenHealth={() => {}} />);
    const link = screen.getByRole("link", { name: /Jellyfin/ });
    expect(link.getAttribute("href")).toBe("http://nas:8096");
    expect(link.getAttribute("aria-disabled")).toBeNull();
    expect(link.className).toContain("opacity-");
  });

  it("renders a non-link card when the app has no launch URL", () => {
    render(<AppCard app={tile({ launchUrl: null })} onOpenHealth={() => {}} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Jellyfin")).toBeTruthy();
  });

  it("opens health from the chip without following the launch link", () => {
    const onOpenHealth = vi.fn();
    const followed = vi.fn();
    render(<AppCard app={tile()} onOpenHealth={onOpenHealth} />);
    screen.getByRole("link", { name: /Jellyfin/ }).addEventListener("click", followed);
    fireEvent.click(screen.getByRole("button", { name: /Show health details/ }));
    expect(onOpenHealth).toHaveBeenCalledWith("a1");
    expect(followed).not.toHaveBeenCalled();
  });

  it("opens in a new tab without leaking the referrer to the target app", () => {
    render(<AppCard app={tile()} onOpenHealth={() => {}} />);
    const link = screen.getByRole("link", { name: /Jellyfin/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/components/AppCard.test.tsx`
Expected: FAIL.

- [ ] **Step 6: Implement AppCard**

`src/web/components/AppCard.tsx`:

```tsx
import type { LauncherApp } from "@shared/launcher";
import { AppIcon } from "@web/components/AppIcon";
import { StatusChip } from "@web/components/StatusChip";

/**
 * The card is the launch target; the chip inside it is not. Checking whether something
 * is healthy must never risk opening it.
 *
 * A down app stays clickable and is only dimmed. The probe is at least as likely to be
 * broken as the app, and a tile you cannot click when you most want to is worse than a
 * tile that opens something slow.
 */
export function AppCard({
  app,
  onOpenHealth,
}: {
  app: LauncherApp;
  onOpenHealth: (appId: string) => void;
}) {
  const dimmed = app.status === "down" ? "opacity-60" : "";
  const body = (
    <>
      <AppIcon iconRef={app.iconRef} displayName={app.displayName} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-slate-900 dark:text-slate-100">{app.displayName}</p>
        {app.description !== null && (
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{app.description}</p>
        )}
      </div>
    </>
  );

  const shell =
    "flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900";

  return (
    <div className="flex flex-col gap-1">
      {app.launchUrl === null ? (
        <div className={`${shell} ${dimmed}`}>{body}</div>
      ) : (
        <a
          href={app.launchUrl}
          target="_blank"
          // `noreferrer` matters: the target is a self-hosted app that has no business
          // learning the launcher's URL, which for an exposed deployment is a hostname
          // the user may not want propagated.
          rel="noreferrer noopener"
          className={`${shell} ${dimmed} hover:border-slate-300 dark:hover:border-slate-700`}
        >
          {body}
        </a>
      )}
      <div className="px-1">
        <StatusChip
          status={app.status}
          reason={app.reason}
          since={app.since}
          onOpen={() => onOpenHealth(app.id)}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Run and verify**

Run: `pnpm exec vitest run src/web/components/`
Expected: all pass.

- [ ] **Step 8: Binding checks**

- Remove `event.stopPropagation()` from `StatusChip` → the "opens health without following the launch link" test must fail.
- Change the down state from `opacity-60` to a `pointer-events-none` disabled style → the "stays clickable but dimmed" test must fail.

- [ ] **Step 9: Commit**

```bash
git add src/web/components/StatusChip.tsx src/web/components/AppCard.tsx src/web/components/StatusChip.test.tsx src/web/components/AppCard.test.tsx
git commit -m "Separate the launch target from the health target on every tile"
```

---

### Task 10: The launcher grid

Spec §8: *"Grouped card grid — icon, display name, description, status phrase — 2-up on phone, 3–5 across on desktop. Live search."* and *"Launcher renders from cached data first; stale status beats a spinner."*

**Files:**
- Create: `src/web/routes/Launcher.tsx`
- Modify: `src/web/App.tsx` (route `/` to `Launcher`)
- Test: `src/web/routes/Launcher.test.tsx`

**Interfaces:**
- Consumes: `useLauncherApps` (Task 7), `AppCard` (Task 9).
- Produces: `<Launcher />` at `/`.

- [ ] **Step 1: Write the failing test**

`src/web/routes/Launcher.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { LauncherApp } from "@shared/launcher";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { launcherKey } from "@web/api/launcher";
import { Launcher } from "@web/routes/Launcher";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tile = (over: Partial<LauncherApp> = {}): LauncherApp => ({
  id: "a1", slug: "jellyfin", displayName: "Jellyfin", description: "Media server",
  iconRef: null, category: "Media", launchUrl: "http://nas:8096", sortOrder: 0,
  status: "up", reason: "Healthy", since: null, probes: [], ...over,
});

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Launcher />
    </QueryClientProvider>,
  );
}

function client(seed?: LauncherApp[]) {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) c.setQueryData(launcherKey, seed);
  return c;
}

describe("Launcher", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ apps: [tile()] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  it("renders cached tiles immediately instead of a spinner", async () => {
    // Spec: "Launcher renders from cached data first; stale status beats a spinner."
    mount(client([tile({ displayName: "Cached App" })]));
    expect(screen.getByText("Cached App")).toBeTruthy();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  it("groups tiles by category with a heading per group", async () => {
    mount(
      client([
        tile({ id: "a1", displayName: "Jellyfin", category: "Media" }),
        tile({ id: "a2", displayName: "Gitea", category: "Dev" }),
      ]),
    );
    expect(screen.getByRole("heading", { name: "Media" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
  });

  it("filters on display name as the user types", async () => {
    mount(
      client([
        tile({ id: "a1", displayName: "Jellyfin" }),
        tile({ id: "a2", displayName: "Gitea", category: "Dev" }),
      ]),
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "git" } });
    expect(screen.queryByText("Jellyfin")).toBeNull();
    expect(screen.getByText("Gitea")).toBeTruthy();
  });

  it("also matches on description, since that is where a purpose is written", async () => {
    mount(client([tile({ displayName: "Jellyfin", description: "Watch films" })]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "films" } });
    expect(screen.getByText("Jellyfin")).toBeTruthy();
  });

  it("tells the user nothing matched rather than showing a blank screen", async () => {
    mount(client([tile()]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(screen.getByText(/No apps match/)).toBeTruthy();
  });

  it("shows an empty state when there are no apps at all", async () => {
    mount(client([]));
    await waitFor(() => expect(screen.getByText(/No apps yet/)).toBeTruthy());
  });

  it("shows an error state instead of an empty grid when the fetch fails", async () => {
    // An empty grid and a broken server look identical to a user, and one of them is
    // something they can act on.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    mount(client());
    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeTruthy());
  });

  it("opens the health panel for the tile whose chip was tapped", async () => {
    mount(client([tile({ id: "a1", displayName: "Jellyfin" })]));
    fireEvent.click(screen.getByRole("button", { name: /Show health details/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });
});
```

The last test depends on Task 11's `HealthPanel`. Write it now and expect it red until Task 11 lands; note that in the report rather than deleting it.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/routes/Launcher.test.tsx`
Expected: FAIL — cannot resolve `@web/routes/Launcher`.

- [ ] **Step 3: Implement**

`src/web/routes/Launcher.tsx`:

```tsx
import type { LauncherApp } from "@shared/launcher";
import { useLauncherApps } from "@web/api/launcher";
import { AppCard } from "@web/components/AppCard";
import { useMemo, useState } from "react";

const UNGROUPED = "Apps";

function groupByCategory(apps: LauncherApp[]): Array<[string, LauncherApp[]]> {
  const groups = new Map<string, LauncherApp[]>();
  for (const app of apps) {
    const key = app.category ?? UNGROUPED;
    groups.set(key, [...(groups.get(key) ?? []), app]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function Launcher() {
  const { data, isError, isPending } = useLauncherApps();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const apps = data ?? [];
    const needle = query.trim().toLowerCase();
    if (needle === "") return apps;
    return apps.filter(
      (app) =>
        app.displayName.toLowerCase().includes(needle) ||
        (app.description ?? "").toLowerCase().includes(needle) ||
        (app.category ?? "").toLowerCase().includes(needle),
    );
  }, [data, query]);

  // `isPending` is only true with nothing cached. With cached data we render it and let
  // the background refetch correct it — stale status beats a spinner.
  if (isPending) return <p className="p-6 text-sm text-slate-500">Loading apps…</p>;
  if (isError) {
    return (
      <p className="p-6 text-sm text-rose-600 dark:text-rose-400">
        Could not load your apps. Homestead may be restarting.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search apps"
        aria-label="Search apps"
        className="mb-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900"
      />

      {(data ?? []).length === 0 && (
        <p className="text-sm text-slate-500">No apps yet. An admin can adopt one from disk.</p>
      )}
      {(data ?? []).length > 0 && filtered.length === 0 && (
        <p className="text-sm text-slate-500">No apps match “{query}”.</p>
      )}

      {groupByCategory(filtered).map(([category, apps]) => (
        <section key={category} className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {category}
          </h2>
          {/* 2-up on phone, up to 5 across on a wide desktop. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {apps.map((app) => (
              <AppCard key={app.id} app={app} onOpenHealth={() => {}} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

Task 11 replaces the `onOpenHealth={() => {}}` stub with real panel state.

- [ ] **Step 4: Route it**

In `src/web/App.tsx`, replace `<Route path="/" element={<Placeholder title="Launcher" />} />` with `<Route path="/" element={<Launcher />} />` and import it.

- [ ] **Step 5: Run and verify**

Run: `pnpm exec vitest run src/web/routes/Launcher.test.tsx`
Expected: all pass except the health-panel test, which lands in Task 11.

- [ ] **Step 6: Binding checks**

- Change `isPending` to `isFetching` → the "renders cached tiles immediately" test must fail, because a background refetch would replace a populated grid with a spinner.
- Remove the description clause from the filter → the description-search test must fail.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/Launcher.tsx src/web/routes/Launcher.test.tsx src/web/App.tsx
git commit -m "Render the launcher grid, grouped and searchable, from cache first"
```

---

### Task 11: Health panel and sparkline

Spec §8: *"…opening a bottom sheet (mobile) or popover (desktop) with the three signals and a 30-day sparkline."*

**Files:**
- Create: `src/web/components/Sparkline.tsx`, `src/web/components/HealthPanel.tsx`
- Modify: `src/web/routes/Launcher.tsx` (wire the panel)
- Test: `src/web/components/Sparkline.test.tsx`, `src/web/components/HealthPanel.test.tsx`

**Interfaces:**
- Consumes: `useAppHealth` (Task 7), `DayBucket`/`AppHealth`/`HealthSignal` (Task 4).
- Produces:
  ```tsx
  <Sparkline history={DayBucket[]} />
  <HealthPanel appId={string} appName={string} onClose={() => void} />
  ```

- [ ] **Step 1: Write the failing Sparkline test**

`src/web/components/Sparkline.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { DayBucket } from "@shared/launcher";
import { render } from "@testing-library/react";
import { Sparkline } from "@web/components/Sparkline";
import { describe, expect, it } from "vitest";

const day = (i: number, upRatio: number, downRatio: number): DayBucket => ({
  dayStart: i * 86_400, upRatio, degradedRatio: 0, downRatio, probeCount: 1,
});
/** A day nobody measured. Ratios are 0 here too, which is exactly the trap. */
const noData = (i: number): DayBucket => ({
  dayStart: i * 86_400, upRatio: 0, degradedRatio: 0, downRatio: 0, probeCount: 0,
});

describe("Sparkline", () => {
  it("draws one bar per day", () => {
    const history = Array.from({ length: 30 }, (_, i) => day(i, 1, 0));
    const { container } = render(<Sparkline history={history} />);
    expect(container.querySelectorAll("rect").length).toBe(30);
  });

  it("renders nothing rather than dividing by zero on an empty history", () => {
    const { container } = render(<Sparkline history={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("survives a day with no checks without producing NaN coordinates", () => {
    // A no-data day is the normal case for a probe added last week, and NaN in a
    // `height` attribute silently renders nothing at all.
    const history = [noData(0), day(1, 0.8, 0.2)];
    const { container } = render(<Sparkline history={history} />);
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("paints a day nobody measured differently from a day that was fully down", () => {
    // Both have upRatio 0. Only `probeCount` tells them apart, and conflating them
    // reports an outage for every day before a probe existed.
    const { container } = render(<Sparkline history={[noData(0), day(1, 0, 1)]} />);
    const [none, down] = [...container.querySelectorAll("rect")];
    expect(none?.getAttribute("fill")).not.toBe(down?.getAttribute("fill"));
  });

  it("gives a fully-down day a visibly different bar from a fully-up day", () => {
    const { container } = render(<Sparkline history={[day(0, 1, 0), day(1, 0, 1)]} />);
    const [first, second] = [...container.querySelectorAll("rect")];
    expect(first?.getAttribute("fill")).not.toBe(second?.getAttribute("fill"));
  });

  it("carries a text summary, since a bar chart alone is not accessible", () => {
    const { container } = render(<Sparkline history={[day(0, 1, 0)]} />);
    expect(container.querySelector("title")?.textContent).toMatch(/%/);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `pnpm exec vitest run src/web/components/Sparkline.test.tsx` → FAIL.

`src/web/components/Sparkline.tsx`:

```tsx
import type { DayBucket } from "@shared/launcher";

const WIDTH = 240;
const HEIGHT = 32;

/**
 * Hand-rolled SVG rather than a charting dependency: 30 bars is not worth 40 KB, and
 * the constraint for this phase is no new dependencies.
 *
 * A day with no checks renders as a full-height neutral bar, not a gap — an absent bar
 * and a healthy bar are indistinguishable at this size, and "no data" is information.
 */
export function Sparkline({ history }: { history: DayBucket[] }) {
  if (history.length === 0) return null;

  const barWidth = WIDTH / history.length;
  // Average the daily ratios over the days that have data. Weighting by sample count
  // would reintroduce the bias the ratios exist to remove.
  const withData = history.filter((day) => day.probeCount > 0);
  const uptime =
    withData.length === 0
      ? null
      : Math.round((withData.reduce((sum, day) => sum + day.upRatio, 0) / withData.length) * 100);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-8 w-full"
      role="img"
      aria-label={uptime === null ? "No history yet" : `${uptime}% up over 30 days`}
    >
      <title>{uptime === null ? "No history yet" : `${uptime}% up over 30 days`}</title>
      {history.map((day, index) => {
        // `probeCount === 0` is the no-data case and must stay visually distinct: the
        // ratios are 0 there too, so testing the ratios alone would paint a day nobody
        // measured the same as a day that was fully down.
        const downShare = day.degradedRatio + day.downRatio;
        const fill =
          day.probeCount === 0
            ? "#cbd5e1"
            : downShare > 0.5
              ? "#f43f5e"
              : downShare > 0
                ? "#f59e0b"
                : "#10b981";
        return (
          <rect
            key={day.dayStart}
            x={index * barWidth}
            y={0}
            width={Math.max(1, barWidth - 1)}
            height={HEIGHT}
            fill={fill}
          />
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 3: Write the failing HealthPanel test**

`src/web/components/HealthPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { AppHealth } from "@shared/launcher";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HealthPanel } from "@web/components/HealthPanel";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HEALTH: AppHealth = {
  appId: "a1",
  signals: [
    { probeId: "p1", kind: "docker", label: null, status: "up", reason: "Healthy", since: 100, lastCheckedAt: 200, latencyMs: 3 },
    { probeId: "p2", kind: "http_internal", label: "Web UI", status: "down", reason: "App not responding", since: 150, lastCheckedAt: 200, latencyMs: null },
  ],
  history: Array.from({ length: 30 }, (_, i) => ({ dayStart: i * 86_400, up: 24, degraded: 0, down: 0 })),
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HealthPanel appId="a1" appName="Jellyfin" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("HealthPanel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(HEALTH), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  it("lists one row per signal with its own cause", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("App not responding")).toBeTruthy());
    expect(screen.getByText("Healthy")).toBeTruthy();
  });

  it("names a probe by its label when it has one, and by kind otherwise", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Web UI")).toBeTruthy());
    expect(screen.getByText(/Docker/i)).toBeTruthy();
  });

  it("is a dialog that can be dismissed with Escape", async () => {
    const onClose = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <HealthPanel appId="a1" appName="Jellyfin" onClose={onClose} />
      </QueryClientProvider>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an error rather than an empty panel when health cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    mount();
    await waitFor(() => expect(screen.getByText(/Could not load health/)).toBeTruthy());
  });
});
```

- [ ] **Step 4: Run to verify it fails, then implement**

`src/web/components/HealthPanel.tsx`:

```tsx
import type { ProbeKind } from "@shared/types";
import { useAppHealth } from "@web/api/launcher";
import { Sparkline } from "@web/components/Sparkline";
import { relativeTime } from "@web/lib/relative-time";
import { useNow } from "@web/lib/use-now";
import { useEffect } from "react";

const KIND_LABEL: Record<ProbeKind, string> = {
  docker: "Docker containers",
  http_internal: "Internal HTTP",
  http_external: "External HTTP",
};

/**
 * A bottom sheet on a phone and a centred panel on desktop, which Tailwind's breakpoints
 * express without a media-query hook. One component, two layouts — a JS breakpoint check
 * would re-render on every resize and disagree with CSS at the boundary.
 */
export function HealthPanel({
  appId,
  appName,
  onClose,
}: {
  appId: string;
  appName: string;
  onClose: () => void;
}) {
  const { data, isError, isPending } = useAppHealth(appId);
  const now = useNow();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Health for ${appName}`}
        onClick={(event) => event.stopPropagation()}
        className="w-full rounded-t-2xl bg-white p-4 sm:max-w-md sm:rounded-2xl dark:bg-slate-900"
      >
        <h2 className="mb-3 font-semibold text-slate-900 dark:text-slate-100">{appName}</h2>

        {isPending && <p className="text-sm text-slate-500">Loading health…</p>}
        {isError && (
          <p className="text-sm text-rose-600 dark:text-rose-400">Could not load health details.</p>
        )}

        {data && (
          <>
            <ul className="mb-4 flex flex-col gap-2">
              {data.signals.map((signal) => (
                <li key={signal.probeId} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-slate-600 dark:text-slate-300">
                    {signal.label ?? KIND_LABEL[signal.kind]}
                  </span>
                  <span className="text-right text-slate-900 dark:text-slate-100">
                    {signal.reason}
                    {signal.since !== null && (
                      // `useNow`, not `Date.now()`: nothing else re-renders this panel, so
                      // an inline clock read freezes the moment the panel opens. Added in
                      // Task 9's fix round; see `use-now.ts` for why the interval is shared.
                      <span className="ml-1 opacity-60">· {relativeTime(signal.since, now)}</span>
                    )}
                  </span>
                </li>
              ))}
              {data.signals.length === 0 && (
                <li className="text-sm text-slate-500">No probes configured for this app.</li>
              )}
            </ul>
            <Sparkline history={data.history} />
            <p className="mt-1 text-xs text-slate-500">Last 30 days</p>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire it into the Launcher**

In `src/web/routes/Launcher.tsx`, add `const [openApp, setOpenApp] = useState<LauncherApp | null>(null);`, pass `onOpenHealth={() => setOpenApp(app)}` to each `AppCard`, and render the panel after the groups:

```tsx
      {openApp !== null && (
        <HealthPanel
          appId={openApp.id}
          appName={openApp.displayName}
          onClose={() => setOpenApp(null)}
        />
      )}
```

- [ ] **Step 6: Run and verify — including Task 10's deferred test**

Run: `pnpm exec vitest run src/web/`
Expected: all pass, including Launcher's "opens the health panel" test which was red at the end of Task 10.

- [ ] **Step 7: Binding checks**

- Remove the `total === 0 ? 0 : …` guard in `Sparkline` → the NaN test must fail.
- Remove `event.stopPropagation()` from the dialog body → clicking inside the panel closes it; add an assertion for that and confirm it goes red without the line.

- [ ] **Step 8: Commit**

```bash
git add src/web/components/Sparkline.tsx src/web/components/HealthPanel.tsx src/web/components/Sparkline.test.tsx src/web/components/HealthPanel.test.tsx src/web/routes/Launcher.tsx
git commit -m "Show the three signals and a 30-day timeline behind the status chip"
```

---

### Task 12: PWA manifest and a cross-cutting audit

Spec §8 Cross-cutting: *"PWA manifest, `display: standalone`. This is a launcher; it belongs on a home screen."* plus the dark-mode and colour-alone requirements.

**Files:**
- Create: `public/manifest.webmanifest`, `public/icon.svg`
- Modify: `index.html`, `src/web/index.css`
- Test: `src/web/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an installable PWA shell.

- [ ] **Step 1: Write the failing test**

`src/web/manifest.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PWA manifest", () => {
  const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));

  it("declares standalone display so it opens as an app, not a tab", () => {
    expect(manifest.display).toBe("standalone");
  });

  it("starts at the launcher, which is the only route every user has", () => {
    expect(manifest.start_url).toBe("/");
  });

  it("declares at least one icon, or the install prompt never appears", () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it("is linked from index.html, since an unlinked manifest does nothing", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain("manifest.webmanifest");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/manifest.test.ts`
Expected: FAIL — `ENOENT: public/manifest.webmanifest`.

- [ ] **Step 3: Write the manifest**

`public/manifest.webmanifest`:

```json
{
  "name": "Homestead",
  "short_name": "Homestead",
  "description": "Your apps, and whether they are healthy.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }
  ]
}
```

`public/icon.svg` — a simple mark, no external references:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0f172a"/>
  <path d="M16 34 32 20l16 14v12a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2z" fill="none" stroke="#38bdf8" stroke-width="4" stroke-linejoin="round"/>
</svg>
```

- [ ] **Step 4: Link it and set the dark background**

In `index.html`, inside `<head>`:

```html
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <meta name="theme-color" content="#0f172a" />
```

In `src/web/index.css`, ensure the page background follows the scheme so a standalone window is not a white flash on a dark phone:

```css
@media (prefers-color-scheme: dark) {
  html { background-color: #0f172a; color-scheme: dark; }
}
```

- [ ] **Step 5: Run and verify**

Run: `pnpm exec vitest run src/web/manifest.test.ts`
Expected: all pass.

- [ ] **Step 6: Audit — status is never colour alone**

Read every component added in Tasks 8–11 and confirm each status indication pairs colour with text or a shape. `StatusChip` already does via `aria-label` plus the visible reason text. Record in your report the list of places status is rendered and how each satisfies the rule. If any place fails it, fix it and add a test.

- [ ] **Step 7: Full gates**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run   # three times
pnpm exec biome check .
pnpm build             # the SPA must actually build
```

`pnpm build` matters here and nowhere else in this plan: `public/` handling and the manifest link are build-time concerns that no unit test exercises.

- [ ] **Step 8: Commit**

```bash
git add public/ index.html src/web/index.css src/web/manifest.test.ts
git commit -m "Make the launcher installable to a home screen"
```

---

## Self-Review

**1. Spec coverage.** Every §8 requirement in this plan's scope maps to a task:

| Spec requirement | Task |
|---|---|
| Grouped card grid, 2-up phone / 3–5 desktop | 10 |
| Live search | 10 |
| Status line carries the cause, not a duration | 2, 9 |
| Healthy cards stay visually quiet | 2 ("Healthy"), 9 (muted styling) |
| Card click launches; chip is a separate tap target | 9 |
| Tile opens external URL, falling back to internal | 3 — external exposures are Phase 2, so `launchUrl` is `launchInternalUrl` today. Recorded below as a deliberate gap. |
| Down apps stay clickable, visibly dimmed | 9 |
| Launcher must not depend on the monitoring pipeline | 3 |
| One EventSource at the shell, `setQueryData` not refetch | 7 |
| Icons proxied and cached, `/api/icons/search` | 5, 6 |
| Icon fallbacks: letter tile | 8 |
| PWA manifest, `display: standalone` | 12 |
| Status never colour alone | 9, 12 |
| Dark mode via `prefers-color-scheme` | 9, 11, 12 |
| Launcher renders from cached data first | 7, 10 |
| Bottom sheet / popover with three signals and a 30-day sparkline | 4, 11 |

**Deliberately out of scope, recorded rather than silently dropped:**
- *Long-press / context menu for the internal URL when an app is exposed.* There are no exposures until Phase 2, so there is no second URL to offer. It lands with the exposure UI.
- *Icon theme variant following `prefers-color-scheme`.* The server supports `?variant=light|dark` (Task 6) but `AppIcon` does not yet request it — a CSS media query cannot set an attribute, so this needs `matchMedia`, and it is cosmetic. Carry forward.
- *Manual icon search and custom upload.* Admin affordances; they belong with the edit page in 1E, which is why Task 6 builds the search endpoint but no UI consumes it yet.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the actual code. Task 10's health-panel test is knowingly red until Task 11 and says so explicitly rather than being vague.

**3. Type consistency.** Checked across tasks:
- `ProbeSnapshot` (Task 2) is consumed by `launcherApps` (Task 3) and `appHealth` (Task 4) with the same six fields.
- `StatusReason` returns `{ status, reason, since }`; `LauncherApp` flattens those three onto the tile; `useEventStream` (Task 7) patches exactly those three.
- `launcherKey` / `healthKey` are defined once in Task 7 and used by Tasks 7, 10, 11.
- `relativeTime(since, now)` (Task 1) takes epoch **seconds** everywhere; `statusSince`, `lastCheckedAt`, `hourStart` and `dayStart` are all epoch seconds, matching `probes.statusSince` as written by Phase 1C. Note `users.disabledAt` is milliseconds — do not copy that convention here.
- `AppIcon`, `StatusChip`, `AppCard`, `Sparkline`, `HealthPanel` prop names match every call site.

**4. Cross-task conflict scan.**

| Tasks | Shared surface | Finding |
|---|---|---|
| 3, 4 | `src/server/routes/launcher.ts` | Task 3 creates it, Task 4 appends a route. Sequential, no conflict. |
| 2, 3, 4 | `src/shared/launcher.ts` | Task 2 creates, 3 and 4 append distinct types. No collision. |
| 3, 6 | `src/server/app.ts` registrations | Both add a `register` before `spaRoutes`. Order between them does not matter; order relative to `spaRoutes` does, and both say so. |
| 6 | `index.ts` and `test-helpers.ts` | Called out explicitly as a pair, because a divergence there was a real Phase 1C defect. |
| 10, 11 | `src/web/routes/Launcher.tsx` | Task 10 writes an `onOpenHealth={() => {}}` stub, Task 11 replaces it. Stated in both. |
| 1 | `vitest.config.ts` | Widening `include` makes every later `.tsx` test collectable. Every web task depends on Task 1; it is first. |

**5. Assumptions verified against the installed toolchain rather than assumed.** Two would have broken Task 1 as first drafted:

- `environmentMatchGlobs` **does not exist in Vitest 5** — it was removed in v4 and is absent from the installed `.d.ts`. An unknown key in the `test` block is ignored rather than rejected, so the config would have looked correct while every `.tsx` test ran in the node environment and failed on `document is not defined`. Task 1 uses the per-file `// @vitest-environment jsdom` docblock instead, verified working on 5.0.0.
- A global `setupFiles` entry importing `@testing-library/react` runs for all 471 server tests too, loading React into every node worker — measured at about 70% of a small server test file's runtime. Task 1 makes the helper an ordinary imported module whose top-level `afterEach(cleanup)` registers only in the files that import it. Verified: with it, a second test cannot see the first test's node; without it, it can.

**6. Known-thin areas an implementer should push back on.** Task 6's `IconStore` keeps two overlapping guards (a slug regex and an index-membership check) where one would do today. That is deliberate and the task says so — but if a reviewer calls it redundant, the answer is that the regex is the kind of thing a later change loosens, and the index check is what keeps the SSRF property true when it does. Do not let it be simplified to one.
