# Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The screen that answers "is everything working?" — a grid of app tiles with status dots, backed by monitors Homestead provisions itself.

**Architecture:** Apps are targets in the existing monitoring engine. A project-backed app is *inferred* from any service with a published port; its monitor set is reconciled against `docker compose config` on project change and on a periodic sweep. `resolveStatus`, `HistoryBar` and `StatusDot` are reused unchanged.

**Tech Stack:** TypeScript ESM, Fastify, Drizzle + libSQL, Zod v4, React + TanStack Query v5, Vitest, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-09-07-dashboard-design.md`

## Global Constraints

- **`src/server/auth/permissions.ts` and `src/shared/permissions.ts` change in exactly one task (Task 1), by one line each.** Homestead holds the Docker socket, so an admin is root-equivalent on the host; this is the file where a mistake hands over the machine. Every later task verifies it is untouched.
- **A test that spans two modules must seed nothing by hand.** The previous plan's worst defect was a transposed settings key that thirteen task reviews missed, because each side's tests seeded the shared state with their own spelling. Where this plan crosses a seam — reconciliation feeding the monitor engine, app enumeration feeding the dashboard route — at least one test must drive the real producer and let its output reach the real consumer.
- **A test for a blocking or filtering rule must assert an absence.** "A viewer sees no devices" means asserting the payload contains none, not that the UI hides them. Five defects in the previous plan were tests asserting the presence of something correct rather than the impossibility of something wrong.
- **No test may start a container, open a socket, resolve a real name, reach the network, or use a real timer.** Container state and icon fetching are both injected.
- `src/web/**` and `e2e/**` must never import from `src/server/**`. `src/shared/**` is browser-safe and imports nothing.
- Import `test` from `e2e/support/fixtures.js`, never `@playwright/test` — Biome-enforced; a raw import bypasses the container guard.
- **Lint baseline is 0 errors and exactly 6 warnings.** Biome counts formatting violations as errors.
- **Never add a `Co-Authored-By` trailer or any AI-attribution line to a commit.**
- **Commit a fix before mutating the file it lives in.** `git checkout <file>` restores HEAD and silently discards uncommitted work there.
- **Read the target line out of the file before writing any mutation pattern**, compare a checksum before and after to prove it applied, and mutate a condition, operator or return value — never a string literal. A pattern written from memory matches nothing and yields a green run indistinguishable from a surviving mutation.
- Run each gate and read its **actual exit status**. Vitest does not typecheck.
- Never amend a commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/dashboard.ts` | Browser-safe types: `AppSummary`, `AppSource`, `ConfidenceTier`, `DashboardData`. Imports only from other `src/shared/*` files, which import nothing themselves. |
| `src/server/db/schema.ts` | `manualApps` table; correct the stale `targetId` comment (modify). |
| `src/server/auth/permissions.ts`, `src/shared/permissions.ts` | `app` gains create/update/delete (modify, Task 1 only). |
| `src/server/apps/enumerate.ts` | Pure: parsed compose → the app rows a project implies. |
| `src/server/apps/reconcile.ts` | Pure: desired monitors vs existing → add / remove / preserve. |
| `src/server/apps/tier.ts` | Pure: monitor states → confidence tier and reason. |
| `src/server/apps/sync.ts` | Wires enumeration and reconciliation to the database. |
| `src/server/apps/icons.ts` | Slug resolution, fetch with injectable `fetch`, disk cache. |
| `src/server/monitoring/checks.ts` | The `docker` executor (modify). |
| `src/server/routes/dashboard.ts` | `GET /api/dashboard`, manual app CRUD. |
| `src/web/routes/Dashboard.tsx` | The grid (replaces the current stub). |

---

## Task 1: Permissions

**Files:**
- Modify: `src/server/auth/permissions.ts`, `src/shared/permissions.ts`
- Test: `src/server/auth/permissions.test.ts`

**This is the only task that touches those two files.** The whole change is one line each.

- [ ] **Step 1: Write the failing tests**

```typescript
it("lets an admin manage manual apps", () => {
  for (const action of ["read", "create", "update", "delete"] as const) {
    expect(
      roles.admin.authorize({ app: [action] }).success,
      `admin should have app:${action}`,
    ).toBe(true);
  }
});

it("leaves a viewer with app:read and nothing more", () => {
  expect(roles.viewer.authorize({ app: ["read"] }).success).toBe(true);
  for (const action of ["create", "update", "delete"] as const) {
    expect(
      roles.viewer.authorize({ app: [action] }).success,
      `viewer must not have app:${action}`,
    ).toBe(false);
  }
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/auth/permissions.test.ts`
Expected: FAIL — `app` has only `read` in the statement.

- [ ] **Step 3: Make the change**

In `src/shared/permissions.ts`, change `app: ["read"]` to `app: ["read", "create", "update", "delete"]`. In `src/server/auth/permissions.ts`, change `adminRole`'s `app: ["read"]` to the same four. **Leave `viewerRole`'s `app: ["read"]` exactly as it is.**

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/auth && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Prove the viewer test discriminates**

Grant `app: ["create"]` to `viewerRole`, confirm the viewer test fails, revert. Read the target line first, compare a checksum before and after, and report the failure message.

- [ ] **Step 6: Commit**

```bash
git add src/server/auth/permissions.ts src/shared/permissions.ts src/server/auth/permissions.test.ts
git commit -m "feat(auth): let admins manage manual apps"
```

---

## Task 2: Schema and shared types

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: `src/shared/dashboard.ts`
- Test: `src/server/db/schema.test.ts`

**Interfaces:**
- Produces: the `manualApps` table; `AppSource`, `ConfidenceTier`, `AppSummary`, `DashboardData`.

- [ ] **Step 1: Write the failing test**

```typescript
it("stores a manual app with an optional icon", async () => {
  const db = createDb(":memory:");
  await runMigrations(db);
  await db.insert(manualApps).values({
    id: "a1",
    name: "Router",
    url: "https://192.168.1.1",
  });
  const [row] = await db.select().from(manualApps);
  expect(row).toMatchObject({
    name: "Router",
    url: "https://192.168.1.1",
    iconSlug: null,
    iconUrl: null,
    hidden: false,
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/server/db/schema.test.ts`
Expected: FAIL — `manualApps` is not exported.

- [ ] **Step 3: Add the table and correct the stale comment**

```typescript
export const manualApps = sqliteTable("manual_apps", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The only thing we know about a manual app, so it is also what we monitor. */
  url: text("url").notNull(),
  iconSlug: text("icon_slug"),
  iconUrl: text("icon_url"),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
});
```

Then replace the `targetId` comment in `monitors`. It currently claims an app is keyed by its published host port. Replace it with:

```typescript
  /**
   * Text, not a foreign key. A device is a uuid; an app is `project_slug:service`
   * or `manual:<id>`. Identity is deliberately NOT the published port — moving a
   * service to another port would otherwise discard its whole uptime history.
   * The port is the join key to exposures, which is a different job.
   */
```

- [ ] **Step 4: Create the shared types**

`src/shared/dashboard.ts` — zero imports:

```typescript
import type { TargetStatus } from "./monitoring.js";

export type AppSource = "project" | "manual";

export type ConfidenceTier =
  | "verified"
  | "responding"
  | "degraded"
  | "down"
  | "blocked"
  | "unknown";

export type AppSummary = {
  /** `project_slug:service` or `manual:<id>` */
  key: string;
  source: AppSource;
  name: string;
  projectSlug: string | null;
  service: string | null;
  hostPort: number | null;
  /** The exposure hostname, or null when the app is not published. */
  hostname: string | null;
  iconSlug: string | null;
  iconUrl: string | null;
  status: TargetStatus;
  tier: ConfidenceTier;
};
```

Note this imports a type from `./monitoring.js`, which is itself import-free and browser-safe; that keeps `src/shared/**` self-contained.

`DashboardData` is `{ apps: AppSummary[]; devices: DeviceSummary[] }`, with `devices` empty for a viewer.

- [ ] **Step 5: Generate and inspect the migration**

Run: `npx drizzle-kit generate`

Open the generated `drizzle/0008_*.sql` **before committing**. It must contain exactly one `CREATE TABLE manual_apps` and nothing else. If it contains `ALTER` or `DROP` against `monitors`, `checks`, `devices`, `exposures`, `settings`, `operations` or any auth table, **stop and report** — a comment change must not produce DDL, and if it has, the snapshot and journal have diverged.

- [ ] **Step 6: Run and commit**

Run: `pnpm vitest run src/server/db && pnpm typecheck && pnpm lint`

```bash
git add src/server/db/schema.ts src/shared/dashboard.ts src/server/db/schema.test.ts drizzle
git commit -m "feat(db): add manual apps and correct the app-identity comment"
```

---

## Task 3: App enumeration

**Files:**
- Create: `src/server/apps/enumerate.ts`
- Test: `src/server/apps/enumerate.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type EnumeratedApp = {
    key: string; projectSlug: string; service: string; hostPort: number;
  };
  export function enumerateApps(projectSlug: string, config: unknown): EnumeratedApp[];
  ```

Pure over a parsed `docker compose config` document. No database, no daemon.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { enumerateApps } from "./enumerate.js";

const cfg = (services: Record<string, unknown>) => ({ services });

describe("enumerateApps", () => {
  it("infers one app per service with a published port", () => {
    const apps = enumerateApps("media", cfg({
      jellyfin: { ports: [{ published: "8096", target: 8096 }] },
      sonarr: { ports: [{ published: "8989", target: 8989 }] },
    }));
    expect(apps).toEqual([
      { key: "media:jellyfin", projectSlug: "media", service: "jellyfin", hostPort: 8096 },
      { key: "media:sonarr", projectSlug: "media", service: "sonarr", hostPort: 8989 },
    ]);
  });

  it("ignores a service with no published port", () => {
    // A database is not an app. Nothing declares that; the absence of a
    // published port is the signal.
    const apps = enumerateApps("media", cfg({
      postgres: { image: "postgres:16" },
    }));
    expect(apps).toEqual([]);
  });

  it("suppresses a service that opts out", () => {
    const apps = enumerateApps("media", cfg({
      redis: {
        ports: [{ published: "6379", target: 6379 }],
        labels: { "homestead.app.enabled": "false" },
      },
    }));
    expect(apps).toEqual([]);
  });

  it("uses the lowest published port when a service publishes several", () => {
    // One tile per service, not per port.
    const apps = enumerateApps("media", cfg({
      app: { ports: [{ published: "9000", target: 9000 }, { published: "8080", target: 8080 }] },
    }));
    expect(apps).toHaveLength(1);
    expect(apps[0]?.hostPort).toBe(8080);
  });

  it("prefers an explicitly labelled port over the lowest", () => {
    const apps = enumerateApps("media", cfg({
      app: {
        ports: [{ published: "9000", target: 9000 }, { published: "8080", target: 8080 }],
        labels: { "homestead.app.port": "9000" },
      },
    }));
    expect(apps[0]?.hostPort).toBe(9000);
  });

  it("returns nothing for a config it cannot understand", () => {
    // An unparseable or unexpected document must not throw into the caller,
    // which reconciles many projects in one pass.
    expect(enumerateApps("media", null)).toEqual([]);
    expect(enumerateApps("media", { services: "not-an-object" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/apps/enumerate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Parse defensively with Zod, returning `[]` rather than throwing. Sort the output by service name so the result is stable — an unstable order would make reconciliation churn.

- [ ] **Step 4: Run, then commit**

Run: `pnpm vitest run src/server/apps && pnpm typecheck && pnpm lint`

```bash
git add src/server/apps/enumerate.ts src/server/apps/enumerate.test.ts
git commit -m "feat(apps): infer apps from a compose document"
```

---

## Task 4: Monitor reconciliation

**Files:**
- Create: `src/server/apps/reconcile.ts`
- Test: `src/server/apps/reconcile.test.ts`

**Interfaces:**
- Consumes: `EnumeratedApp` (Task 3).
- Produces:
  ```typescript
  export type DesiredMonitor = {
    targetId: string; type: MonitorType; config: Record<string, unknown>; required: boolean;
  };
  export type ExistingMonitor = { id: string; targetId: string; type: MonitorType; config: string };
  export type ReconcilePlan = {
    create: DesiredMonitor[]; remove: string[]; keep: string[];
  };
  export function desiredMonitors(app: EnumeratedApp, hostname: string | null): DesiredMonitor[];
  export function planReconcile(desired: DesiredMonitor[], existing: ExistingMonitor[]): ReconcilePlan;
  ```

Pure. No database.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("desiredMonitors", () => {
  const app = { key: "media:jellyfin", projectSlug: "media", service: "jellyfin", hostPort: 8096 };

  it("provisions three monitors for an unpublished app", () => {
    // DNS and reachability need a hostname to be about.
    const types = desiredMonitors(app, null).map((m) => m.type).sort();
    expect(types).toEqual(["docker", "http", "tcp"]);
  });

  it("adds dns and reachability once a hostname exists", () => {
    const types = desiredMonitors(app, "jf.example.com").map((m) => m.type).sort();
    expect(types).toEqual(["dns", "docker", "http", "reachability", "tcp"]);
  });

  it("marks reachability advisory and the rest required", () => {
    // A Cloudflare outage must not turn every published tile red.
    const monitors = desiredMonitors(app, "jf.example.com");
    const reach = monitors.find((m) => m.type === "reachability");
    expect(reach?.required).toBe(false);
    for (const m of monitors.filter((m) => m.type !== "reachability")) {
      expect(m.required, `${m.type} should be required`).toBe(true);
    }
  });

  it("points the local checks at the published port", () => {
    const monitors = desiredMonitors(app, null);
    expect(monitors.find((m) => m.type === "tcp")?.config).toMatchObject({ port: 8096 });
    expect(monitors.find((m) => m.type === "http")?.config).toMatchObject({
      url: "http://127.0.0.1:8096",
    });
  });
});

describe("planReconcile", () => {
  const d = (type: string, extra: Record<string, unknown> = {}) => ({
    targetId: "media:jellyfin", type, config: extra, required: true,
  });
  const e = (id: string, type: string) => ({
    id, targetId: "media:jellyfin", type, config: "{}",
  });

  it("creates what is missing", () => {
    const plan = planReconcile([d("docker")], []);
    expect(plan.create.map((m) => m.type)).toEqual(["docker"]);
    expect(plan.remove).toEqual([]);
  });

  it("removes a monitor whose service or port is gone", () => {
    // The failure this exists to prevent: a monitor outliving the port it watches.
    const plan = planReconcile([], [e("m1", "tcp")]);
    expect(plan.remove).toEqual(["m1"]);
  });

  it("keeps an existing monitor rather than recreating it", () => {
    // Recreating would discard its uptime history.
    const plan = planReconcile([d("docker")], [e("m1", "docker")]);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(["m1"]);
  });

  it("does not touch a monitor for a different target", () => {
    const plan = planReconcile([d("docker")], [
      { id: "other", targetId: "media:sonarr", type: "docker", config: "{}" },
    ]);
    expect(plan.remove).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/apps/reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Match existing to desired on `(targetId, type)`. Anything desired with no match is created; anything existing for that target with no match is removed; the rest are kept untouched, so a user's edited interval or advisory flag survives.

- [ ] **Step 4: Prove the preserve behaviour discriminates**

Make `planReconcile` return every existing id in `remove`, confirm the "keeps an existing monitor" test fails, and revert. Read the line first, checksum before and after, and report the message.

- [ ] **Step 5: Commit**

```bash
git add src/server/apps/reconcile.ts src/server/apps/reconcile.test.ts
git commit -m "feat(apps): plan the monitor set for an app"
```

---

## Task 5: The `docker` monitor type

**Files:**
- Modify: `src/server/monitoring/checks.ts`, `src/shared/monitoring.ts`
- Test: `src/server/monitoring/checks.test.ts`

**Interfaces:**
- `MonitorType` gains `"docker"`; `executors.docker` is registered.
- `CheckContext` gains `containerState: (projectSlug: string, service: string) => Promise<{ state: string; health: string | null; restarts: number } | null>`.

Adding to `MonitorType` will make `Record<MonitorType, CheckExecutor>` fail to compile until the executor is registered. That is the safety net, not an obstacle.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("docker executor", () => {
  const withState = (s: Awaited<ReturnType<CheckContext["containerState"]>>) =>
    ctx({ containerState: async () => s });

  it("is up when the container runs and has no healthcheck", async () => {
    const r = await executors.docker(
      { projectSlug: "media", service: "jellyfin" }, 1000,
      withState({ state: "running", health: null, restarts: 0 }),
    );
    expect(r.up).toBe(true);
  });

  it("is up when the container runs and reports healthy", async () => {
    const r = await executors.docker(
      { projectSlug: "media", service: "jellyfin" }, 1000,
      withState({ state: "running", health: "healthy", restarts: 0 }),
    );
    expect(r.up).toBe(true);
  });

  it("is down when the healthcheck says unhealthy, even though it is running", async () => {
    // A container can be running and broken. Plain state hides that.
    const r = await executors.docker(
      { projectSlug: "media", service: "jellyfin" }, 1000,
      withState({ state: "running", health: "unhealthy", restarts: 0 }),
    );
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/unhealthy/i);
  });

  it("is down when the container is absent", async () => {
    const r = await executors.docker(
      { projectSlug: "media", service: "jellyfin" }, 1000, withState(null),
    );
    expect(r.up).toBe(false);
  });

  it("is down when the container is restarting", async () => {
    const r = await executors.docker(
      { projectSlug: "media", service: "jellyfin" }, 1000,
      withState({ state: "restarting", health: null, restarts: 5 }),
    );
    expect(r.up).toBe(false);
  });

  it("opens no socket", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await executors.docker(
      { projectSlug: "media", service: "jellyfin" }, 1000,
      withState({ state: "running", health: null, restarts: 0 }),
    );
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports a bad config as a failed check, not a thrown error", async () => {
    const r = await executors.docker({ projectSlug: 123 }, 1000, ctx());
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/config/i);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/monitoring/checks.test.ts`
Expected: FAIL — `executors.docker` is undefined.

- [ ] **Step 3: Implement**

Add `"docker"` to `MonitorType`. Add `containerState` to `CheckContext` and to every place a context is constructed — the runner builds one per monitor; wire it to `composePs` there, not in the executor, so no test reaches a daemon. Measure `durationMs` with `performance.now()`.

- [ ] **Step 4: Prove the unhealthy case discriminates**

Remove the health check so only `state` is consulted, confirm the unhealthy test fails, revert. Read the line first, checksum, report the message.

- [ ] **Step 5: Commit**

```bash
git add src/server/monitoring/checks.ts src/server/monitoring/checks.test.ts src/shared/monitoring.ts src/server/monitoring/runner.ts
git commit -m "feat(monitoring): add the docker container check"
```

---

## Task 6: Confidence tier

**Files:**
- Create: `src/server/apps/tier.ts`
- Test: `src/server/apps/tier.test.ts`

**Interfaces:**
- Produces: `deriveTier(monitors: MonitorLatest[]): { tier: ConfidenceTier; reason: string | null }`

Pure. The tier is the dot's *detail text*; the dot's colour still comes from `resolveStatus`.

- [ ] **Step 1: Write the failing tests**

```typescript
const m = (over: Partial<MonitorLatest> = {}): MonitorLatest => ({
  id: "m", type: "http", required: true, enabled: true,
  up: true, error: null, at: 1, ...over,
});

describe("deriveTier", () => {
  it("is unknown when nothing has reported", () => {
    expect(deriveTier([m({ up: null, at: null })]).tier).toBe("unknown");
  });

  it("is verified when a healthcheck passes", () => {
    expect(deriveTier([m({ type: "docker", error: null })]).tier).toBe("verified");
  });

  it("is down when a required monitor is down", () => {
    expect(deriveTier([m({ up: false, error: "refused" })]).tier).toBe("down");
  });

  it("is blocked when a probe was rejected by Access", () => {
    const t = deriveTier([
      m({ type: "reachability", required: false, up: false, error: "Access authentication failed" }),
    ]);
    expect(t.tier).toBe("blocked");
  });

  it("is degraded when it is locally up but publicly unreachable", () => {
    // Two different outages. Conflating them sends you to the wrong place.
    const t = deriveTier([
      m({ type: "docker" }),
      m({ type: "reachability", required: false, up: false, error: "HTTP 502" }),
    ]);
    expect(t.tier).toBe("degraded");
    expect(t.reason).toMatch(/unreachable/i);
  });

  it("is responding when only an http check has answered", () => {
    expect(deriveTier([m({ type: "http" })]).tier).toBe("responding");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/apps/tier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Precedence, highest concern first: `down` → `blocked` → `degraded` → `verified` → `responding` → `unknown`.

- [ ] **Step 4: Commit**

```bash
git add src/server/apps/tier.ts src/server/apps/tier.test.ts
git commit -m "feat(apps): derive the confidence tier from a monitor set"
```

---

## Task 7: Reconciliation wiring

**Files:**
- Create: `src/server/apps/sync.ts`
- Modify: `src/server/routes/projects.ts`, `src/server/index.ts`, `src/server/monitoring/runner.ts`
- Test: `src/server/apps/sync.test.ts`

**Interfaces:**
- Produces: `syncAppMonitors(db, deps): Promise<{ created: number; removed: number }>`

- [ ] **Step 1: Write the failing tests**

**This is the seam test the global constraints require.** It must drive real enumeration and real reconciliation into a real database, seeding no monitors by hand:

```typescript
it("provisions monitors for a project's apps end to end", async () => {
  const db = createDb(":memory:");
  await runMigrations(db);
  const created = await syncAppMonitors(db, {
    listProjects: async () => ["media"],
    composeConfig: async () => ({
      services: { jellyfin: { ports: [{ published: "8096", target: 8096 }] } },
    }),
    hostnameFor: async () => null,
  });
  expect(created.created).toBe(3);
  const rows = await db.select().from(monitors);
  expect(rows.map((r) => r.type).sort()).toEqual(["docker", "http", "tcp"]);
  expect(rows.every((r) => r.targetType === "app")).toBe(true);
  expect(rows.every((r) => r.targetId === "media:jellyfin")).toBe(true);
});

it("removes a monitor when its service loses its port", async () => {
  const db = createDb(":memory:");
  await runMigrations(db);
  const withPort = {
    services: { jellyfin: { ports: [{ published: "8096", target: 8096 }] } },
  };
  const deps = (config: unknown) => ({
    listProjects: async () => ["media"],
    composeConfig: async () => config,
    hostnameFor: async () => null,
  });

  await syncAppMonitors(db, deps(withPort));
  expect(await db.select().from(monitors)).toHaveLength(3);

  // The port is gone from the compose file.
  const r = await syncAppMonitors(db, deps({ services: { jellyfin: {} } }));
  expect(r.removed).toBe(3);
  expect(await db.select().from(monitors)).toHaveLength(0);
});

it("leaves a user-edited monitor alone", async () => {
  // Changing an interval or marking a monitor advisory is a deliberate act.
  // A rewrite-everything implementation would silently undo it.
  const db = createDb(":memory:");
  await runMigrations(db);
  const deps = {
    listProjects: async () => ["media"],
    composeConfig: async () => ({
      services: { jellyfin: { ports: [{ published: "8096", target: 8096 }] } },
    }),
    hostnameFor: async () => null,
  };

  await syncAppMonitors(db, deps);
  const [tcp] = await db
    .select()
    .from(monitors)
    .where(eq(monitors.type, "tcp"));
  if (!tcp) throw new Error("expected a tcp monitor after the first sync");
  await db
    .update(monitors)
    .set({ intervalSeconds: 600, required: false })
    .where(eq(monitors.id, tcp.id));

  await syncAppMonitors(db, deps);

  const [after] = await db
    .select()
    .from(monitors)
    .where(eq(monitors.id, tcp.id));
  expect(after).toMatchObject({ intervalSeconds: 600, required: false });
});

it("does not delete monitors when the compose file will not parse", async () => {
  // A syntax error is not evidence that the apps are gone. Treating it as
  // "this project has no services" would delete every monitor and its history.
  const db = createDb(":memory:");
  await runMigrations(db);
  const good = {
    services: { jellyfin: { ports: [{ published: "8096", target: 8096 }] } },
  };
  await syncAppMonitors(db, {
    listProjects: async () => ["media"],
    composeConfig: async () => good,
    hostnameFor: async () => null,
  });
  expect(await db.select().from(monitors)).toHaveLength(3);

  const r = await syncAppMonitors(db, {
    listProjects: async () => ["media"],
    composeConfig: async () => {
      throw new Error("yaml: line 3: mapping values are not allowed here");
    },
    hostnameFor: async () => null,
  });

  expect(r.removed).toBe(0);
  expect(await db.select().from(monitors)).toHaveLength(3);
});
```

Every one of these drives `syncAppMonitors` rather than asserting on `planReconcile` directly. That is deliberate: the seam between enumeration, planning and the database is exactly where the previous plan's worst defect hid, and a test that calls the pure planner would not have caught it.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/apps/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`syncAppMonitors` enumerates each project, resolves its hostname from `exposures` by published port, plans, and applies. A project whose `composeConfig` throws is **skipped with its monitors intact** — a syntax error is not evidence that the apps are gone.

- [ ] **Step 4: Wire the triggers**

Call it after project create, compose save and delete in `src/server/routes/projects.ts`. Add a `syncApps` dependency to the runner on a **10-minute** interval, wired from `src/server/index.ts` — never from `buildApp`, which every route test constructs — in its own try/catch so a failure cannot stop the monitor tick. Follow how `syncUsers` is wired.

- [ ] **Step 5: Confirm the suite still exits promptly**

`pnpm test` must not hang. A late exit is how a stray timer or network call announces itself.

- [ ] **Step 6: Commit**

```bash
git add src/server/apps/sync.ts src/server/apps/sync.test.ts src/server/routes/projects.ts src/server/index.ts src/server/monitoring/runner.ts
git commit -m "feat(apps): reconcile app monitors on change and on a sweep"
```

---

## Task 8: Icons

**Files:**
- Create: `src/server/apps/icons.ts`
- Test: `src/server/apps/icons.test.ts`

**Interfaces:**
- Produces: `resolveIcon(opts: { slug?: string | null; url?: string | null; cacheDir: string; fetch?: typeof fetch }): Promise<{ path: string } | null>`

- [ ] **Step 1: Write the failing tests**

Cover: a cached icon is served without any fetch; a first fetch writes the cache and the second call does not fetch again; a failed fetch returns null rather than throwing; a non-image content type is rejected; and a slug containing `../` cannot escape the cache directory.

That last one matters — the slug reaches the filesystem, so path traversal is the risk this module actually carries.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/apps/icons.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Slugs resolve against the dashboard-icons CDN URL pattern. Sanitise the slug to `[a-z0-9-]` before it touches a path. Cache under `<cacheDir>/<slug>.<ext>`. A failed fetch returns null and the caller falls back to a generated glyph; do not retry.

- [ ] **Step 4: Prove the traversal guard discriminates**

Remove the sanitiser, confirm the traversal test fails, revert. Read the line first, checksum, report the message.

- [ ] **Step 5: Commit**

```bash
git add src/server/apps/icons.ts src/server/apps/icons.test.ts
git commit -m "feat(apps): resolve and cache app icons"
```

---

## Task 9: Dashboard routes

**Files:**
- Create: `src/server/routes/dashboard.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/routes/dashboard.test.ts`

**Interfaces:**
- `GET /api/dashboard` `[app:read]` → `{ apps: AppSummary[]; devices: DeviceSummary[] }`
- `POST /api/apps` `[app:create]` → 201 `{ id }`
- `PATCH /api/apps/:id` `[app:update]`, `DELETE /api/apps/:id` `[app:delete]`

- [ ] **Step 1: Write the failing tests**

Cover at minimum:

- **A viewer's payload contains no device data at all.** Assert `body.devices` is empty *and* that no device name, hostname or last-seen value appears anywhere in the serialised response — filtering happens before serialisation, not in the UI.
- A viewer can read the dashboard but is refused `POST`, `PATCH` and `DELETE` — one test per route.
- An admin sees both apps and devices.
- A manual app created through the route gets exactly one required `http` monitor pointed at its URL.
- An app's tile carries the exposure hostname when one exists and `null` when it does not.
- `PATCH` rejects an unknown field with 400 before writing anything.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/routes/dashboard.test.ts`
Expected: FAIL — routes unregistered.

- [ ] **Step 3: Implement**

Register in `src/server/app.ts`. Build each app's `AppSummary` by pooling its monitors' latest checks through `resolveStatus` and `deriveTier`. **Avoid the N+1** — fetch all monitors and all latest checks in a bounded number of queries and group in memory, as `GET /api/devices` does.

- [ ] **Step 4: Verify permissions.ts is untouched**

```bash
git diff --quiet HEAD -- src/server/auth/permissions.ts src/shared/permissions.ts && echo UNCHANGED
```

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/dashboard.ts src/server/routes/dashboard.test.ts src/server/app.ts
git commit -m "feat(api): add the dashboard and manual app routes"
```

---

## Task 10: The dashboard grid

**Files:**
- Modify: `src/web/routes/Dashboard.tsx`, `src/web/lib/queries.ts`
- Test: `src/web/routes/dashboard.test.tsx`

Replaces the current stub, which renders a heading and the signed-in email.

**Do not set `retry` or `refetchOnWindowFocus` on any hook** — client defaults, re-added per hook twice before in this project. Reuse `isRefusal` for the 403 state.

- [ ] **Step 1: Write the failing tests**

Cover: a tile renders its icon, name and dot; a non-green tile shows its tier as detail text; a tile with a hostname links to it and one without is not a link; a viewer sees no device section; the empty state distinguishes "no projects yet" from "projects exist but none publishes a port"; and a 403 renders the shared refusal state.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web/routes/dashboard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Reuse `StatusDot` and `HistoryBar` as they are. Every control at least 44px in both dimensions; any bordered element needs `border border-border`, because preflight zeroes `border-width`. Note the nav is icon-only below `sm:` and its links are `min-w-11 min-h-11` — if you add an entry, that budget still holds, but re-run the mobile sweep.

- [ ] **Step 4: Run and commit**

Run: `pnpm typecheck && pnpm test && pnpm lint`

```bash
git add src/web/routes/Dashboard.tsx src/web/routes/dashboard.test.tsx src/web/lib/queries.ts
git commit -m "feat(web): build the dashboard grid"
```

---

## Task 11: End-to-end sweep

**Files:**
- Create: `e2e/dashboard.spec.ts`

- [ ] **Step 1: Write the failing spec**

Import `test` from `./support/fixtures.js`. Stub the API with payloads **typed as `DashboardData`** so a contract change fails compilation rather than passing silently. Assert the grid renders at both viewports, and run `expectTappable` and `expectNoHorizontalScroll` on the route.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm e2e`

- [ ] **Step 3: Make it pass, then run everything**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm e2e`
Expected: PASS at both viewports.

- [ ] **Step 4: Confirm no host side effects**

```bash
docker ps -a --format '{{.ID}}' | sort > /tmp/before.txt
pnpm e2e
docker ps -a --format '{{.ID}}' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "no drift"
```

- [ ] **Step 5: Commit**

```bash
git add e2e/dashboard.spec.ts
git commit -m "test(e2e): sweep the dashboard at both viewports"
```

---

## Definition of Done

- `pnpm typecheck`, `pnpm test`, `pnpm lint` clean; `pnpm e2e` green at **both** viewports; no Docker drift.
- `permissions.ts` and `shared/permissions.ts` changed in exactly one commit, one line each, `viewerRole` untouched.
- A viewer's `/api/dashboard` payload contains **no device data at all**, asserted on the serialised response.
- A viewer is refused every manual-app mutation route.
- A user-edited monitor survives reconciliation.
- An unparseable compose file does not delete existing monitors.
- Reachability is advisory; a failing reachability check never turns a tile red.
- An unpublished app has three monitors; a published one has five.
- A slug containing `../` cannot write outside the icon cache directory.
- No test starts a container, opens a socket, reaches the network, or uses a real timer.

## Handoff to packaging

- `$HOMESTEAD_DATA/icons/` must be persisted by the container image.
- Icon fetching is the first outbound HTTP Homestead makes on its own behalf; note it for air-gapped installs.
- Deferred and still open: per-viewer app visibility, icon uploads, discovered containers as an app source, notifications, the response-time graph.
