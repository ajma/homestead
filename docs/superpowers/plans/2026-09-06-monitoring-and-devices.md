# Homestead Monitoring and Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A monitoring subsystem — a check scheduler, an observation log, and uptime arithmetic — with devices as its first target type and a `/devices` screen to see them.

**Architecture:** Five monitor types (`tailscale`, `tcp`, `http`, `dns`, `push`) run on one interval loop that writes `checks` rows. A nightly job rolls raw checks into hourly buckets and prunes. Uptime figures, the history bar, and each target's status dot are queries over that log — never stored state. Devices are records Homestead owns, reconciled against a Tailscale sync that runs separately from the runner.

**Tech Stack:** Fastify, Drizzle + SQLite (drizzle-kit for migrations), React 19, TanStack Query 5, Vitest, Playwright, Biome. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-06-monitoring-and-devices-design.md`

## Global Constraints

- **`src/server/auth/permissions.ts` is modified by exactly one task (Task 2) and by no other.** Homestead holds the Docker socket, so an admin is root-equivalent on the host; this file is the one place a mistake hands over the box. `device` and `monitor` statements are **admin-only**; `viewerRole` keeps only `app:read`.
- `src/web/**` and `e2e/**` must never import from `src/server/**`. `src/shared/**` is the browser-safe boundary and imports nothing.
- **Tokens only.** `src/web/design-system.test.ts` bans palette utilities and raw hex and compiles the stylesheet to check every colour utility emits a real rule. It cannot catch an *inert* one: `border-border` sets colour and Tailwind 4 preflight zeroes `border-width`, so a bordered element needs `border border-border`.
- Touch targets at least **44px in both dimensions**; accessible names on every control; desktop and mobile parity (the e2e suite runs every spec at 1440×900 and 390×844).
- Import `test` from `e2e/support/fixtures.js`, never `@playwright/test` — a Biome rule makes that an error, and the fixture carries the guard that keeps lifecycle POSTs off the real Docker daemon.
- **No test may start a Docker container, and no test may open a socket or a real timer.** `docker ps -a` and `docker volume ls` must be unchanged either side of a full `pnpm e2e`.
- Biome treats `noNonNullAssertion` and `noNonNullAssertedOptionalChain` as errors, in test code too. Restructure rather than silence.
- No `Co-Authored-By` trailers and no AI-attribution lines in commit messages.
- Four gates green before any task is reported done: `pnpm typecheck`, `pnpm test`, `pnpm lint` (5 pre-existing warnings are the accepted baseline, **0 errors**), `pnpm e2e`.
- **Commit incrementally.** Two agents died mid-task during Plan 4 and lost everything uncommitted. A task with separable deliverables commits each as its tests pass.

## Verified facts you may rely on

Probed against this repo and the Tailscale API while writing the plan. Do not re-derive; do report if any turns out false.

- **`buildApp` does not receive the secret key.** `AppDeps` is `{ db, auth, logger?, projectsDir, projectsHostDir, dataDir, docker? }`. The key is created in `src/server/index.ts:30` via `ensureSecretKey(config.dataDir, config.secretKey)` and passed only to `createAuth`. Task 7 adds it to `AppDeps`.
  **Trap:** a route could call `ensureSecretKey(dataDir, undefined)` itself, but that drops the `HOMESTEAD_SECRET_KEY` env override and would derive a *different* key, so anything encrypted under the real key fails to decrypt. Plumb it; do not re-derive it.
- `src/server/crypto/secrets.ts` exports `ensureSecretKey(dataDir, envKey): Promise<Buffer>`, `encrypt(plaintext, key): string`, `decrypt(payload, key): string`. **It has no consumers yet** — Task 7 is its first.
- `src/server/db/settings.ts` exports `getSetting` and `setSetting`.
- Migrations live in `drizzle/`, are generated with `npx drizzle-kit generate` (config at `drizzle.config.ts`, `drizzle-kit ^0.31.10`), and are applied by `runMigrations(db)` which reads `./drizzle`. One migration (`0004_add_operations_project_started_index.sql`) was hand-written with a matching `meta/_journal.json` entry and snapshot — generating is safer.
- `src/server/docker/fake.ts` exports `createFakeDocker(options)` — the precedent for injecting a fake through `AppDeps`. The runner follows it.
- **Tailscale `GET /api/v2/tailnet/{tailnet}/devices?fields=all`:** `lastSeen` is **omitted while a device is online** (the schema states it is absent if the device has never been online *or* if `connectedToControl` is true), so online-ness comes from `connectedToControl`. `nodeId` is the preferred identifier; `id` is legacy. `clientConnectivity.latency` is a map of DERP relay latencies, not device round-trip.

## File Structure

**Shared**

| File | Responsibility |
|---|---|
| `src/shared/monitoring.ts` (create) | Browser-safe types: `MonitorType`, `MonitorSummary`, `TargetStatus`, `UptimeWindow`, `HistoryBucket`, `DeviceSummary`. Imports nothing. |

**Server**

| File | Responsibility |
|---|---|
| `src/server/db/schema.ts` (modify) | The four new tables. |
| `src/server/monitoring/uptime.ts` (create) | Pure arithmetic over check rows: uptime ratio, history buckets. No database. |
| `src/server/monitoring/rollup.ts` (create) | Hourly aggregation and raw pruning. |
| `src/server/monitoring/checks.ts` (create) | The check executors: `tcp`, `http`, `dns`, `push`. One `CheckExecutor` interface. |
| `src/server/monitoring/runner.ts` (create) | The interval loop: due selection, retries, backoff, lifecycle. |
| `src/server/monitoring/status.ts` (create) | Rollup of a target's monitors into a dot plus a reason. |
| `src/server/tailscale/client.ts` (create) | The API client and its response types. |
| `src/server/tailscale/sync.ts` (create) | Reconciles `devices` against the tailnet. |
| `src/server/routes/devices.ts` (create) | Device and monitor CRUD, status, history. |
| `src/server/auth/permissions.ts` (modify, Task 2 only) | `device` and `monitor` statements. |
| `src/server/app.ts` (modify) | Register the new routes; `secretKey` in `AppDeps`. |
| `src/server/index.ts` (modify) | Pass the key; start and stop the runner. |

**Web**

| File | Responsibility |
|---|---|
| `src/web/lib/queries.ts` (modify) | `useDevices`, `useDevice`, `useMonitors`, mutations. |
| `src/web/routes/Devices.tsx` (create) | The list. |
| `src/web/routes/DeviceDetail.tsx` (create) | Monitors, history bar, uptime figures. |
| `src/web/components/HistoryBar.tsx` (create) | Hand-rolled SVG. |
| `src/web/components/MonitorEditor.tsx` (create) | Add/edit a monitor. |
| `src/web/App.tsx` (modify) | `/devices` and `/devices/:id`. |

---

### Task 1: Schema and migration

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: `src/shared/monitoring.ts`
- Test: `src/server/db/schema.test.ts` (create)

**Interfaces:**
- Produces: tables `monitors`, `checks`, `checkRollups`, `devices`; shared types `MonitorType`, `TargetType`.

- [ ] **Step 1: Write the failing test**

`src/server/db/schema.test.ts`:

```typescript
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "./client.js";
import { checks, devices, monitors } from "./schema.js";

async function db() {
  const d = createDb(":memory:");
  await runMigrations(d);
  return d;
}

describe("monitoring schema", () => {
  it("stores a monitor against a device target", async () => {
    const d = await db();
    await d.insert(devices).values({ id: "dev1", name: "nas", kind: "nas" });
    await d.insert(monitors).values({
      id: "m1",
      targetType: "device",
      targetId: "dev1",
      type: "tcp",
      config: JSON.stringify({ host: "10.0.0.2", port: 22 }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      retries: 2,
      required: true,
      enabled: true,
      nextDueAt: 0,
    });
    const rows = await d.select().from(monitors).where(eq(monitors.id, "m1"));
    expect(rows[0]?.targetId).toBe("dev1");
  });

  it("keeps a device whose tailscaleNodeId is null — manual devices have none", async () => {
    const d = await db();
    await d.insert(devices).values({ id: "dev2", name: "printer", kind: "other" });
    const rows = await d.select().from(devices).where(eq(devices.id, "dev2"));
    expect(rows[0]?.tailscaleNodeId).toBeNull();
  });

  it("records a check with a duration even though nothing reads it yet", async () => {
    const d = await db();
    await d.insert(devices).values({ id: "dev3", name: "vm", kind: "vm" });
    await d.insert(monitors).values({
      id: "m3", targetType: "device", targetId: "dev3", type: "dns",
      config: JSON.stringify({ hostname: "example.test" }),
      intervalSeconds: 60, timeoutMs: 5000, retries: 0,
      required: true, enabled: true, nextDueAt: 0,
    });
    await d.insert(checks).values({
      id: "c1", monitorId: "m3", at: 1000, up: false, durationMs: 42,
      error: "ENOTFOUND",
    });
    const rows = await d.select().from(checks).where(eq(checks.monitorId, "m3"));
    expect(rows[0]).toMatchObject({ up: false, durationMs: 42, error: "ENOTFOUND" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/server/db/schema.test.ts`
Expected: FAIL — `monitors`, `checks` and `devices` are not exported from `schema.ts`.

- [ ] **Step 3: Add the tables**

Append to `src/server/db/schema.ts`, following the existing style (snake_case columns, epoch-millisecond integers, indexes declared in the third argument with a comment saying which query they serve):

```typescript
export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  /** Null for a manually added device — a printer, a switch, an old NAS. */
  tailscaleNodeId: text("tailscale_node_id"),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  notes: text("notes"),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  lastSyncedAt: integer("last_synced_at"),
  // Synced Tailscale fields. `lastSeen` is null while the device is online —
  // Tailscale omits it when `connectedToControl` is true — so online-ness is
  // read from `connectedToControl`, never from the age of `lastSeen`.
  hostname: text("hostname"),
  os: text("os"),
  addresses: text("addresses"),
  user: text("user"),
  clientVersion: text("client_version"),
  updateAvailable: integer("update_available", { mode: "boolean" }),
  tags: text("tags"),
  isEphemeral: integer("is_ephemeral", { mode: "boolean" }),
  isExternal: integer("is_external", { mode: "boolean" }),
  blocksIncomingConnections: integer("blocks_incoming_connections", { mode: "boolean" }),
  connectedToControl: integer("connected_to_control", { mode: "boolean" }),
  lastSeen: integer("last_seen"),
});

export const monitors = sqliteTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type").notNull(),
    /**
     * Text, not a foreign key. A device is a uuid, but an app is keyed by its
     * published host port (product design §9.2), so one column holds both
     * without a migration or a nullable column per target kind.
     */
    targetId: text("target_id").notNull(),
    type: text("type").notNull(),
    config: text("config").notNull(),
    intervalSeconds: integer("interval_seconds").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    retries: integer("retries").notNull().default(0),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextDueAt: integer("next_due_at").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  },
  // The runner's hot query is `WHERE enabled = 1 AND next_due_at <= ?`, and the
  // status rollup is `WHERE target_type = ? AND target_id = ?`.
  (t) => [
    index("monitors_due_idx").on(t.enabled, t.nextDueAt),
    index("monitors_target_idx").on(t.targetType, t.targetId),
  ],
);

export const checks = sqliteTable(
  "checks",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id").notNull(),
    at: integer("at").notNull(),
    up: integer("up", { mode: "boolean" }).notNull(),
    /** Measured to enforce the timeout; stored because discarding it would be
     *  a choice, not a saving. Nothing reads it yet (spec §1). */
    durationMs: integer("duration_ms"),
    error: text("error"),
  },
  // Every read is `WHERE monitor_id = ? AND at >= ? ORDER BY at`, and the prune
  // is `WHERE at < ?`.
  (t) => [index("checks_monitor_at_idx").on(t.monitorId, t.at)],
);

export const checkRollups = sqliteTable(
  "check_rollups",
  {
    monitorId: text("monitor_id").notNull(),
    hourStartedAt: integer("hour_started_at").notNull(),
    upCount: integer("up_count").notNull(),
    downCount: integer("down_count").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.monitorId, t.hourStartedAt] }),
  ],
);
```

Extend the import at the top of the file to include `primaryKey`:

```typescript
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
```

- [ ] **Step 4: Create the shared types**

`src/shared/monitoring.ts` — browser-safe, imports nothing:

```typescript
export type TargetType = "device" | "app";
export type MonitorType = "tailscale" | "tcp" | "http" | "dns" | "push";
export type DeviceKind = "phone" | "laptop" | "nas" | "vm" | "other";

/** A monitor's current state, derived from its most recent check. */
export type MonitorState = "up" | "down" | "unknown";

export type MonitorSummary = {
  id: string;
  type: MonitorType;
  required: boolean;
  enabled: boolean;
  state: MonitorState;
  lastCheckedAt: number | null;
  error: string | null;
};

/**
 * A target's dot. `reason` names the monitor that failed, because "container
 * exited" and "callback timed out" send you to different places.
 */
export type TargetStatus = {
  state: MonitorState;
  reason: string | null;
};

export type UptimeWindow = { windowMs: number; ratio: number | null };

/** One segment of the history bar. `ratio` is null for a bucket with no data. */
export type HistoryBucket = { startedAt: number; ratio: number | null };

export type DeviceSummary = {
  id: string;
  name: string;
  kind: DeviceKind;
  hidden: boolean;
  tailscaleNodeId: string | null;
  connectedToControl: boolean | null;
  lastSeen: number | null;
  os: string | null;
  status: TargetStatus;
};
```

- [ ] **Step 5: Generate the migration**

```bash
npx drizzle-kit generate
```

Inspect the generated SQL before committing: it must contain four `CREATE TABLE` statements and the three indexes, and **must not** alter or drop `settings` or `operations`. If it proposes anything against an existing table, stop and report — that means the snapshot and the schema had already diverged.

- [ ] **Step 6: Run and watch them pass**

Run: `pnpm vitest run src/server/db/schema.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/schema.ts src/server/db/schema.test.ts src/shared/monitoring.ts drizzle/
git commit -m "feat(db): add monitoring and device tables"
```

---

### Task 2: Permissions

**Files:**
- Modify: `src/shared/permissions.ts`
- Modify: `src/server/auth/permissions.ts`
- Test: `src/server/auth/permissions.test.ts` (create)

**Interfaces:**
- Produces: `device: ["read","create","update","delete"]` and `monitor: ["read","create","update","delete"]` on `adminRole` only.

**This is the only task in the plan that touches `permissions.ts`, and it is its own commit.** Homestead holds the Docker socket; a mistake here hands over the host. It is deliberately small so a reviewer can read the whole diff.

- [ ] **Step 1: Write the failing test**

`src/server/auth/permissions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { adminRole, roles, viewerRole } from "./permissions.js";

describe("roles", () => {
  it("grants an admin the new device and monitor verbs", () => {
    for (const verb of ["read", "create", "update", "delete"] as const) {
      expect(adminRole.authorize({ device: [verb] }).success, `device:${verb}`).toBe(true);
      expect(adminRole.authorize({ monitor: [verb] }).success, `monitor:${verb}`).toBe(true);
    }
  });

  it("grants a viewer neither, and still only app:read", () => {
    expect(viewerRole.authorize({ device: ["read"] }).success).toBe(false);
    expect(viewerRole.authorize({ monitor: ["read"] }).success).toBe(false);
    // A device list showing when each phone was last connected is a presence
    // signal. Keeping it admin-only is the decision, not an oversight.
    expect(viewerRole.authorize({ app: ["read"] }).success).toBe(true);
    expect(viewerRole.authorize({ project: ["read"] }).success).toBe(false);
  });

  it("exposes exactly the two roles", () => {
    expect(Object.keys(roles).sort()).toEqual(["admin", "viewer"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/server/auth/permissions.test.ts`
Expected: FAIL — `device` is not a known resource.

- [ ] **Step 3: Add the statements**

In `src/shared/permissions.ts`, add two entries to `homesteadStatement`:

```typescript
  device: ["read", "create", "update", "delete"],
  monitor: ["read", "create", "update", "delete"],
```

In `src/server/auth/permissions.ts`, add the same two lines to `adminRole` only. **Do not touch `viewerRole`.**

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Confirm the viewer is unchanged**

```bash
git diff -- src/server/auth/permissions.ts
```

The diff must show two added lines inside `adminRole` and nothing else. Any change inside `viewerRole` is a defect — report it rather than committing.

- [ ] **Step 6: Commit**

```bash
git add src/shared/permissions.ts src/server/auth/permissions.ts src/server/auth/permissions.test.ts
git commit -m "feat(auth): add admin-only device and monitor permissions"
```

---

### Task 3: Uptime arithmetic

**Files:**
- Create: `src/server/monitoring/uptime.ts`
- Test: `src/server/monitoring/uptime.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type CheckRow = { at: number; up: boolean };
  export type RollupRow = { hourStartedAt: number; upCount: number; downCount: number };
  export function uptimeRatio(checks: CheckRow[], rollups: RollupRow[], from: number, to: number): number | null;
  export function historyBuckets(checks: CheckRow[], from: number, to: number, bucketCount: number): HistoryBucket[];
  ```

**This task carries the sharpest tests in the plan.** "98.2% over 30 days" is easy to compute wrongly in ways nobody notices, and it is the number that will actually be read. It is pure arithmetic over arrays, so it can be tested exhaustively with no database and no clock.

- [ ] **Step 1: Write the failing tests**

`src/server/monitoring/uptime.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { historyBuckets, uptimeRatio } from "./uptime.js";

const HOUR = 3_600_000;

describe("uptimeRatio", () => {
  it("is null when nothing was observed — not zero", () => {
    // Zero would render as "0% uptime", which claims an outage that was never
    // observed. Absence of data is not evidence of downtime.
    expect(uptimeRatio([], [], 0, HOUR)).toBeNull();
  });

  it("counts only checks inside the window", () => {
    const rows = [
      { at: -10, up: false },   // before
      { at: 10, up: true },
      { at: 20, up: true },
      { at: HOUR + 10, up: false }, // after
    ];
    expect(uptimeRatio(rows, [], 0, HOUR)).toBe(1);
  });

  it("treats the window as half-open [from, to)", () => {
    expect(uptimeRatio([{ at: 0, up: true }], [], 0, HOUR)).toBe(1);
    expect(uptimeRatio([{ at: HOUR, up: false }], [], 0, HOUR)).toBeNull();
  });

  it("combines raw checks with rollups without double counting the seam", () => {
    // The raw window starts at HOUR; the rollup covers the hour before it.
    const rollups = [{ hourStartedAt: 0, upCount: 9, downCount: 1 }];
    const raw = [{ at: HOUR, up: true }, { at: HOUR + 1, up: true }];
    // 9 up + 1 down + 2 up = 11/12
    expect(uptimeRatio(raw, rollups, 0, 2 * HOUR)).toBeCloseTo(11 / 12, 10);
  });

  it("ignores a rollup bucket that starts outside the window", () => {
    const rollups = [
      { hourStartedAt: -HOUR, upCount: 100, downCount: 0 },
      { hourStartedAt: 0, upCount: 1, downCount: 1 },
    ];
    expect(uptimeRatio([], rollups, 0, HOUR)).toBe(0.5);
  });

  it("returns 0 when every observation is down", () => {
    expect(uptimeRatio([{ at: 1, up: false }], [], 0, HOUR)).toBe(0);
  });
});

describe("historyBuckets", () => {
  it("returns the requested number of buckets, oldest first", () => {
    const b = historyBuckets([], 0, 4 * HOUR, 4);
    expect(b).toHaveLength(4);
    expect(b.map((x) => x.startedAt)).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR]);
  });

  it("gives a bucket with no checks a null ratio, not zero", () => {
    // A gap where the runner was stopped must render as "no data", not as an
    // outage. This is the bar's most common wrong answer.
    const b = historyBuckets([{ at: 10, up: true }], 0, 2 * HOUR, 2);
    expect(b[0]?.ratio).toBe(1);
    expect(b[1]?.ratio).toBeNull();
  });

  it("places a check in the bucket containing its timestamp", () => {
    const rows = [
      { at: 0, up: true },
      { at: HOUR - 1, up: false },
      { at: HOUR, up: false },
    ];
    const b = historyBuckets(rows, 0, 2 * HOUR, 2);
    expect(b[0]?.ratio).toBe(0.5);
    expect(b[1]?.ratio).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/monitoring/uptime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/monitoring/uptime.ts`:

```typescript
import type { HistoryBucket } from "@shared/monitoring.js";

export type CheckRow = { at: number; up: boolean };
export type RollupRow = { hourStartedAt: number; upCount: number; downCount: number };

/**
 * Uptime over `[from, to)`, or null when nothing was observed.
 *
 * Null rather than zero on purpose: zero renders as "0% uptime", which asserts
 * an outage that was never seen. A window with no checks — the runner was
 * stopped, or the monitor was created later — has no answer, and saying so is
 * more useful than inventing one.
 */
export function uptimeRatio(
  checks: CheckRow[],
  rollups: RollupRow[],
  from: number,
  to: number,
): number | null {
  let up = 0;
  let total = 0;

  for (const r of rollups) {
    if (r.hourStartedAt < from || r.hourStartedAt >= to) continue;
    up += r.upCount;
    total += r.upCount + r.downCount;
  }
  for (const c of checks) {
    if (c.at < from || c.at >= to) continue;
    if (c.up) up += 1;
    total += 1;
  }

  return total === 0 ? null : up / total;
}

export function historyBuckets(
  checks: CheckRow[],
  from: number,
  to: number,
  bucketCount: number,
): HistoryBucket[] {
  const span = (to - from) / bucketCount;
  const up = new Array<number>(bucketCount).fill(0);
  const total = new Array<number>(bucketCount).fill(0);

  for (const c of checks) {
    if (c.at < from || c.at >= to) continue;
    const i = Math.min(bucketCount - 1, Math.floor((c.at - from) / span));
    if (c.up) up[i] = (up[i] ?? 0) + 1;
    total[i] = (total[i] ?? 0) + 1;
  }

  return Array.from({ length: bucketCount }, (_, i) => ({
    startedAt: from + i * span,
    ratio: (total[i] ?? 0) === 0 ? null : (up[i] ?? 0) / (total[i] ?? 1),
  }));
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/monitoring/uptime.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the null-versus-zero tests discriminate**

Change both `null` returns to `0` and re-run. The two tests named for it must go red. Restore. Report the failure messages — this is the distinction the whole screen rests on, and a suite that cannot tell 0% from "no data" will let a stopped runner look like a total outage.

- [ ] **Step 6: Commit**

```bash
git add src/server/monitoring/uptime.ts src/server/monitoring/uptime.test.ts
git commit -m "feat(monitoring): add uptime and history-bucket arithmetic"
```

---

### Task 4: Rollup and retention

**Files:**
- Create: `src/server/monitoring/rollup.ts`
- Test: `src/server/monitoring/rollup.test.ts`

**Interfaces:**
- Consumes: the tables from Task 1.
- Produces:
  ```typescript
  export const RAW_RETENTION_MS: number;   // 7 days
  export async function rollUpAndPrune(db: Db, now: number): Promise<{ rolled: number; pruned: number }>;
  ```

- [ ] **Step 1: Write the failing tests**

`src/server/monitoring/rollup.test.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { checkRollups, checks, devices, monitors } from "../db/schema.js";
import { RAW_RETENTION_MS, rollUpAndPrune } from "./rollup.js";

const HOUR = 3_600_000;

async function seed(): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db);
  await db.insert(devices).values({ id: "d", name: "nas", kind: "nas" });
  await db.insert(monitors).values({
    id: "m", targetType: "device", targetId: "d", type: "tcp",
    config: "{}", intervalSeconds: 60, timeoutMs: 1000, retries: 0,
    required: true, enabled: true, nextDueAt: 0,
  });
  return db;
}

const check = (id: string, at: number, up: boolean) => ({ id, monitorId: "m", at, up });

describe("rollUpAndPrune", () => {
  it("aggregates old raw checks into hourly buckets", async () => {
    const db = await seed();
    const old = 0;
    await db.insert(checks).values([
      check("a", old + 1, true),
      check("b", old + 2, true),
      check("c", old + 3, false),
    ]);
    const now = RAW_RETENTION_MS + 10 * HOUR;
    await rollUpAndPrune(db, now);
    const rows = await db.select().from(checkRollups)
      .where(and(eq(checkRollups.monitorId, "m"), eq(checkRollups.hourStartedAt, 0)));
    expect(rows[0]).toMatchObject({ upCount: 2, downCount: 1 });
  });

  it("prunes the raw rows it rolled up, and keeps the recent ones", async () => {
    const db = await seed();
    const now = RAW_RETENTION_MS + 10 * HOUR;
    await db.insert(checks).values([
      check("old", 1, true),
      check("fresh", now - 1000, true),
    ]);
    const { pruned } = await rollUpAndPrune(db, now);
    expect(pruned).toBe(1);
    const left = await db.select().from(checks);
    expect(left.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("is idempotent — running twice does not double-count", async () => {
    // The nightly job may run twice after a restart. If a second pass re-adds
    // the same hour, every historical uptime figure silently inflates.
    const db = await seed();
    await db.insert(checks).values([check("a", 1, true), check("b", 2, false)]);
    const now = RAW_RETENTION_MS + 10 * HOUR;
    await rollUpAndPrune(db, now);
    await rollUpAndPrune(db, now);
    const rows = await db.select().from(checkRollups);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ upCount: 1, downCount: 1 });
  });

  it("leaves everything alone when nothing is old enough", async () => {
    const db = await seed();
    const now = 10 * HOUR;
    await db.insert(checks).values([check("fresh", now - 1000, true)]);
    const result = await rollUpAndPrune(db, now);
    expect(result).toEqual({ rolled: 0, pruned: 0 });
    expect(await db.select().from(checks)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/monitoring/rollup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/monitoring/rollup.ts`. Group rows older than the cutoff by `(monitorId, hour)`, upsert each bucket, then delete the raw rows below the cutoff. Use `onConflictDoUpdate` on the composite primary key so a second pass replaces rather than adds — the idempotency test is what pins that, and getting it wrong inflates every historical figure without any error.

```typescript
import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkRollups, checks } from "../db/schema.js";

const HOUR_MS = 3_600_000;
/** Raw checks are kept 7 days; hourly rollups are kept indefinitely. */
export const RAW_RETENTION_MS = 7 * 24 * HOUR_MS;

export async function rollUpAndPrune(
  db: Db,
  now: number,
): Promise<{ rolled: number; pruned: number }> {
  const cutoff = now - RAW_RETENTION_MS;
  const old = await db.select().from(checks).where(lt(checks.at, cutoff));
  if (old.length === 0) return { rolled: 0, pruned: 0 };

  const buckets = new Map<string, { monitorId: string; hourStartedAt: number; upCount: number; downCount: number }>();
  for (const row of old) {
    const hour = Math.floor(row.at / HOUR_MS) * HOUR_MS;
    const key = `${row.monitorId}:${hour}`;
    const b = buckets.get(key) ?? { monitorId: row.monitorId, hourStartedAt: hour, upCount: 0, downCount: 0 };
    if (row.up) b.upCount += 1;
    else b.downCount += 1;
    buckets.set(key, b);
  }

  for (const b of buckets.values()) {
    await db
      .insert(checkRollups)
      .values(b)
      // Replace, never add: the nightly job can run twice after a restart, and
      // an additive upsert would inflate every historical uptime figure with no
      // error anywhere.
      .onConflictDoUpdate({
        target: [checkRollups.monitorId, checkRollups.hourStartedAt],
        set: { upCount: sql`excluded.up_count`, downCount: sql`excluded.down_count` },
      });
  }

  await db.delete(checks).where(lt(checks.at, cutoff));
  return { rolled: buckets.size, pruned: old.length };
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/monitoring/rollup.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the idempotency test discriminates**

Change `onConflictDoUpdate` to add rather than replace (`upCount: sql`up_count + excluded.up_count``). The idempotency test must go red. Restore and report the message.

- [ ] **Step 6: Commit**

```bash
git add src/server/monitoring/rollup.ts src/server/monitoring/rollup.test.ts
git commit -m "feat(monitoring): roll raw checks into hourly buckets and prune"
```

---

### Task 5: Check executors

**Files:**
- Create: `src/server/monitoring/checks.ts`
- Test: `src/server/monitoring/checks.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type CheckResult = { up: boolean; durationMs: number; error: string | null };
  export type CheckContext = {
    now: () => number;
    /** Epoch ms of the last push for this monitor, or null if none has arrived. */
    lastPushAt: (monitorId: string) => number | null;
    /** The synced `connectedToControl` for a device, or null if unknown.
     *  The `tailscale` executor reads state the sync already fetched; it must
     *  not call the API itself, or one tick would issue a request per device. */
    deviceConnected: (deviceId: string) => boolean | null;
  };
  export type CheckExecutor = (config: unknown, timeoutMs: number, ctx: CheckContext) => Promise<CheckResult>;
  export const executors: Record<MonitorType, CheckExecutor>;
  ```

**Not every check is a network call.** `push` examines a timestamp and `tailscale` reads synced state. The engine must not assume otherwise — the dashboard plan adds a `docker` type that reads container state, making three of six non-network.

- [ ] **Step 1: Write the failing tests**

`src/server/monitoring/checks.test.ts` — every test uses an injected context; **none opens a socket**:

```typescript
import { describe, expect, it, vi } from "vitest";
import { executors } from "./checks.js";

const ctx = (over: Partial<Parameters<typeof executors.push>[2]> = {}) => ({
  now: () => 10_000,
  lastPushAt: () => null,
  deviceConnected: () => null,
  ...over,
});

describe("push executor", () => {
  it("is down when no call has ever arrived", async () => {
    const r = await executors.push({ graceSeconds: 30 }, 1000, ctx());
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/never/i);
  });

  it("is up when a call arrived inside the window", async () => {
    const r = await executors.push(
      { graceSeconds: 30, intervalSeconds: 60 },
      1000,
      ctx({ lastPushAt: () => 10_000 - 20_000 }),
    );
    expect(r.up).toBe(true);
  });

  it("is down once interval + grace has elapsed", async () => {
    const r = await executors.push(
      { graceSeconds: 30, intervalSeconds: 60 },
      1000,
      ctx({ lastPushAt: () => 10_000 - 95_000 }),
    );
    expect(r.up).toBe(false);
  });
});

describe("tailscale executor", () => {
  it("is up when the sync last saw the device connected", async () => {
    const r = await executors.tailscale({ deviceId: "d" }, 1000, ctx({ deviceConnected: () => true }));
    expect(r.up).toBe(true);
  });

  it("is down when the sync last saw it disconnected", async () => {
    const r = await executors.tailscale({ deviceId: "d" }, 1000, ctx({ deviceConnected: () => false }));
    expect(r.up).toBe(false);
  });

  it("is down with a clear error when the device has never synced", async () => {
    const r = await executors.tailscale({ deviceId: "d" }, 1000, ctx({ deviceConnected: () => null }));
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/sync/i);
  });

  it("opens no connection — it reads state the sync already fetched", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await executors.tailscale({ deviceId: "d" }, 1000, ctx({ deviceConnected: () => true }));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("config validation", () => {
  it("reports a bad config as a failed check, not a thrown error", async () => {
    // A malformed config must not kill the runner's tick. Every other monitor
    // in that pass would stop being checked.
    const r = await executors.tcp({ host: 123 }, 1000, ctx());
    expect(r.up).toBe(false);
    expect(r.error).toMatch(/config/i);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/monitoring/checks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/monitoring/checks.ts`. Each executor parses its config with Zod, returning a failed `CheckResult` rather than throwing when the config is wrong. `tcp` uses `node:net` with the timeout applied to connect; `http` uses `fetch` with an `AbortSignal.timeout`; `dns` uses `node:dns/promises` `resolve`; `push` and `tailscale` read state through `CheckContext` and open nothing.

Every executor measures elapsed time with a monotonic source and returns it as `durationMs`, even though nothing reads it yet (spec §1) — the measurement exists to enforce the timeout regardless.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/monitoring/checks.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Confirm no test opened a socket**

Run the suite with the network stubbed: temporarily replace `globalThis.fetch` with a function that throws, and confirm `pnpm vitest run src/server/monitoring` still passes. Any failure means a test is reaching the network and must be given a fake instead. Report what you found.

- [ ] **Step 6: Commit**

```bash
git add src/server/monitoring/checks.ts src/server/monitoring/checks.test.ts
git commit -m "feat(monitoring): add the tcp, http, dns and push check executors"
```

---

### Task 6: The runner

**Files:**
- Create: `src/server/monitoring/runner.ts`
- Test: `src/server/monitoring/runner.test.ts`

**Interfaces:**
- Consumes: `executors` (Task 5), `rollUpAndPrune` (Task 4).
- Produces:
  ```typescript
  export type RunnerDeps = {
    db: Db;
    now: () => number;
    setTimer: (fn: () => void, ms: number) => { cancel: () => void };
    executors?: Partial<Record<MonitorType, CheckExecutor>>;
    /** Defaults to `rollUpAndPrune`; injected so tests spy without touching rows. */
    maintain?: (db: Db, now: number) => Promise<{ rolled: number; pruned: number }>;
  };
  export function createRunner(deps: RunnerDeps): { start(): void; stop(): void; tick(): Promise<void> };
  ```

**`tick()` is exported deliberately.** Tests drive it directly and never start the loop; the loop's only job is to call it. This is the codebase's first background lifecycle, and the injected `setTimer` is what keeps a real timer out of the test suite.

- [ ] **Step 1: Write the failing tests**

`src/server/monitoring/runner.test.ts`. The critical pair is that a due monitor **is** checked and a not-due monitor **is not** — a test that only asserts the first passes even if due-time logic is missing entirely:

```typescript
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { checks, devices, monitors } from "../db/schema.js";
import { createRunner } from "./runner.js";

async function seed(nextDueAt: number, over: Record<string, unknown> = {}): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db);
  await db.insert(devices).values({ id: "d", name: "nas", kind: "nas" });
  await db.insert(monitors).values({
    id: "m", targetType: "device", targetId: "d", type: "tcp",
    config: JSON.stringify({ host: "h", port: 1 }),
    intervalSeconds: 60, timeoutMs: 1000, retries: 0,
    required: true, enabled: true, nextDueAt, ...over,
  });
  return db;
}

const noTimer = () => ({ cancel: () => {} });

describe("runner tick", () => {
  it("checks a monitor that is due", async () => {
    const db = await seed(0);
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({ db, now: () => 1000, setTimer: noTimer, executors: { tcp } }).tick();
    expect(tcp).toHaveBeenCalledTimes(1);
    expect(await db.select().from(checks)).toHaveLength(1);
  });

  it("does NOT check a monitor that is not yet due", async () => {
    const db = await seed(9_999_999);
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({ db, now: () => 1000, setTimer: noTimer, executors: { tcp } }).tick();
    expect(tcp).not.toHaveBeenCalled();
    expect(await db.select().from(checks)).toHaveLength(0);
  });

  it("skips a disabled monitor even when due", async () => {
    const db = await seed(0, { enabled: false });
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({ db, now: () => 1000, setTimer: noTimer, executors: { tcp } }).tick();
    expect(tcp).not.toHaveBeenCalled();
  });

  it("advances nextDueAt by the interval", async () => {
    const db = await seed(0);
    const tcp = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({ db, now: () => 1000, setTimer: noTimer, executors: { tcp } }).tick();
    const [m] = await db.select().from(monitors).where(eq(monitors.id, "m"));
    expect(m?.nextDueAt).toBe(1000 + 60_000);
  });

  it("retries before recording a down, and records one row not three", async () => {
    const db = await seed(0, { retries: 2 });
    const tcp = vi.fn(async () => ({ up: false, durationMs: 5, error: "refused" }));
    await createRunner({ db, now: () => 1000, setTimer: noTimer, executors: { tcp } }).tick();
    expect(tcp).toHaveBeenCalledTimes(3);
    const rows = await db.select().from(checks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.up).toBe(false);
  });

  it("does not let one failing executor stop the others in the same tick", async () => {
    const db = await seed(0);
    await db.insert(monitors).values({
      id: "m2", targetType: "device", targetId: "d", type: "dns",
      config: JSON.stringify({ hostname: "x" }), intervalSeconds: 60,
      timeoutMs: 1000, retries: 0, required: true, enabled: true, nextDueAt: 0,
    });
    const tcp = vi.fn(async () => { throw new Error("boom"); });
    const dns = vi.fn(async () => ({ up: true, durationMs: 5, error: null }));
    await createRunner({ db, now: () => 1000, setTimer: noTimer, executors: { tcp, dns } }).tick();
    expect(dns).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(checks);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.monitorId === "m")?.up).toBe(false);
  });
});

describe("runner lifecycle", () => {
  it("does nothing until started, and stops cleanly", () => {
    const cancel = vi.fn();
    const setTimer = vi.fn(() => ({ cancel }));
    const r = createRunner({ db: {} as Db, now: () => 0, setTimer });
    expect(setTimer).not.toHaveBeenCalled();
    r.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    r.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/monitoring/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/monitoring/runner.ts`. `tick()` selects `enabled = true AND nextDueAt <= now()`, runs each monitor's executor with retries, writes one `checks` row per monitor, and sets `nextDueAt = now() + intervalSeconds * 1000`. An executor that throws becomes a failed check for that monitor and nothing else — wrap each in its own `try`. Track `consecutiveFailures` and back off by multiplying the interval, capped, so a dead host is not checked every 60 seconds forever. `start()` schedules `tick()` every 10s through the injected `setTimer`; `stop()` cancels it.

**The maintenance job runs on this loop too.** `tick()` calls `rollUpAndPrune(db, now())` at most once an hour, tracked by a `lastRollupAt` field on the runner — the spec puts it here rather than in a second scheduler, and a `tick()` that never calls it means raw checks grow forever with no error anywhere. Add a test that a tick past the hour boundary calls it and a tick inside the hour does not, using an injected spy rather than the real function:

```typescript
it("runs maintenance at most once an hour", async () => {
  const db = await seed(9_999_999);
  const maintain = vi.fn(async () => ({ rolled: 0, pruned: 0 }));
  const r = createRunner({ db, now: () => 3_600_001, setTimer: noTimer, maintain });
  await r.tick();
  await r.tick();
  expect(maintain).toHaveBeenCalledTimes(1);
});
```

Add `maintain?: (db: Db, now: number) => Promise<{ rolled: number; pruned: number }>` to `RunnerDeps`, defaulting to `rollUpAndPrune`, so the test injects a spy and never touches the real tables.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/monitoring && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Prove the due-time logic is pinned**

Delete the `nextDueAt <= now` condition from the query so every monitor is always checked. The "does NOT check a monitor that is not yet due" test must go red. Restore. Then delete the `enabled` condition and confirm the disabled test goes red. Report both messages — a scheduler whose tests only assert that checks happen is the easiest thing in this plan to get wrong invisibly.

- [ ] **Step 6: Commit**

```bash
git add src/server/monitoring/runner.ts src/server/monitoring/runner.test.ts
git commit -m "feat(monitoring): add the check runner"
```

---

### Task 7: Tailscale client and sync

**Files:**
- Create: `src/server/tailscale/client.ts`, `src/server/tailscale/sync.ts`
- Modify: `src/server/app.ts` (add `secretKey` to `AppDeps`), `src/server/index.ts` (pass it)
- Test: `src/server/tailscale/sync.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type TailscaleDevice = {
    nodeId: string; name: string; hostname: string; os: string;
    addresses: string[]; user: string; clientVersion: string;
    updateAvailable: boolean; tags: string[]; isEphemeral: boolean;
    isExternal: boolean; blocksIncomingConnections: boolean;
    connectedToControl: boolean; lastSeen: string | undefined;
  };
  export type TailscaleClient = { listDevices(): Promise<TailscaleDevice[]> };
  export function createTailscaleClient(opts: { tailnet: string; token: string; fetch?: typeof fetch }): TailscaleClient;
  export async function syncDevices(db: Db, client: TailscaleClient, now: number): Promise<{ added: number; updated: number }>;
  ```

**The API detail that breaks a naive implementation:** `lastSeen` is **omitted while a device is online**. Online-ness comes from `connectedToControl`. Do not infer it from a recent `lastSeen`, and do not sort a device list by `lastSeen` without handling the undefined case — every connected device would sort to the end.

- [ ] **Step 1: Write the failing tests**

`src/server/tailscale/sync.test.ts` — a fake client, no network:

```typescript
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { devices } from "../db/schema.js";
import { syncDevices, type TailscaleDevice } from "./sync.js";

const node = (over: Partial<TailscaleDevice> = {}): TailscaleDevice => ({
  nodeId: "n1", name: "nas.tail.ts.net", hostname: "nas", os: "linux",
  addresses: ["100.1.1.1"], user: "a@b.co", clientVersion: "1.0",
  updateAvailable: false, tags: [], isEphemeral: false, isExternal: false,
  blocksIncomingConnections: false, connectedToControl: true,
  lastSeen: undefined, ...over,
});

const fake = (list: TailscaleDevice[]) => ({ listDevices: async () => list });

async function db(): Promise<Db> {
  const d = createDb(":memory:");
  await runMigrations(d);
  return d;
}

describe("syncDevices", () => {
  it("inserts a node it has not seen", async () => {
    const d = await db();
    const r = await syncDevices(d, fake([node()]), 1000);
    expect(r.added).toBe(1);
    const [row] = await d.select().from(devices);
    expect(row).toMatchObject({ tailscaleNodeId: "n1", hostname: "nas", connectedToControl: true });
  });

  it("stores lastSeen as null for an online device, because Tailscale omits it", async () => {
    const d = await db();
    await syncDevices(d, fake([node({ connectedToControl: true, lastSeen: undefined })]), 1000);
    const [row] = await d.select().from(devices);
    expect(row?.lastSeen).toBeNull();
    expect(row?.connectedToControl).toBe(true);
  });

  it("keeps the user's own fields when refreshing a known node", async () => {
    // Renaming a device in Homestead must survive every sync, or the feature is
    // pointless — the whole reason for owned records is calling it "Andrew's
    // phone" instead of "iphone-12".
    const d = await db();
    await syncDevices(d, fake([node()]), 1000);
    await d.update(devices).set({ name: "Andrew's NAS", kind: "nas", notes: "loud", hidden: true })
      .where(eq(devices.tailscaleNodeId, "n1"));
    await syncDevices(d, fake([node({ hostname: "nas2" })]), 2000);
    const [row] = await d.select().from(devices);
    expect(row).toMatchObject({ name: "Andrew's NAS", notes: "loud", hidden: true, hostname: "nas2" });
  });

  it("retains a device that has left the tailnet", async () => {
    // Its history is the point: a device that vanished is exactly when you want
    // to see when it was last connected.
    const d = await db();
    await syncDevices(d, fake([node()]), 1000);
    await syncDevices(d, fake([]), 2000);
    expect(await d.select().from(devices)).toHaveLength(1);
  });

  it("never touches a manual device", async () => {
    const d = await db();
    await d.insert(devices).values({ id: "manual", name: "printer", kind: "other" });
    await syncDevices(d, fake([node()]), 1000);
    const [row] = await d.select().from(devices).where(eq(devices.id, "manual"));
    expect(row).toMatchObject({ name: "printer", tailscaleNodeId: null });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/tailscale/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client and the sync**

`client.ts` calls `GET https://api.tailscale.com/api/v2/tailnet/{tailnet}/devices?fields=all` with `Authorization: Bearer <token>`, taking `fetch` as an injectable option so tests never reach the network. Map `lastSeen` from an ISO string to epoch milliseconds, or `null` when absent.

`sync.ts` upserts on `tailscaleNodeId`: insert unseen nodes with a generated uuid, and for known ones update **only** the Tailscale-owned columns listed in Task 1, never `name`, `kind`, `notes` or `hidden`. Departed nodes are left in place.

- [ ] **Step 4: Plumb the secret key**

Add `secretKey: Buffer` to `AppDeps` in `src/server/app.ts` and pass `key` from `src/server/index.ts:30`. Do **not** call `ensureSecretKey` from a route: it would drop the `HOMESTEAD_SECRET_KEY` override and derive a different key, so anything encrypted under the real one would fail to decrypt.

- [ ] **Step 5: Run and watch them pass**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. Existing route tests will need `secretKey` in their `buildApp` calls — a `Buffer.alloc(32)` is fine there.

- [ ] **Step 6: Commit**

```bash
git add src/server/tailscale src/server/app.ts src/server/index.ts
git commit -m "feat(tailscale): sync devices from the tailnet"
```

---

### Task 8: Status resolution

**Files:**
- Create: `src/server/monitoring/status.ts`
- Test: `src/server/monitoring/status.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type MonitorLatest = { id: string; type: MonitorType; required: boolean; enabled: boolean; up: boolean | null; error: string | null; at: number | null };
  export function resolveStatus(monitors: MonitorLatest[]): TargetStatus;
  ```

Pure over an array — no database, no clock.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { resolveStatus } from "./status.js";

const m = (over: Partial<Parameters<typeof resolveStatus>[0][number]> = {}) => ({
  id: "m", type: "tcp" as const, required: true, enabled: true,
  up: true, error: null, at: 1, ...over,
});

describe("resolveStatus", () => {
  it("is unknown when there are no monitors at all", () => {
    expect(resolveStatus([])).toEqual({ state: "unknown", reason: null });
  });

  it("is unknown when no monitor has reported yet", () => {
    expect(resolveStatus([m({ up: null, at: null })]).state).toBe("unknown");
  });

  it("is up when every required monitor is up", () => {
    expect(resolveStatus([m(), m({ id: "m2", type: "dns" })]).state).toBe("up");
  });

  it("is down when any required monitor is down, and names it", () => {
    const s = resolveStatus([m(), m({ id: "m2", type: "http", up: false, error: "timeout" })]);
    expect(s.state).toBe("down");
    // Red alone is not actionable: "container exited" and "callback timed out"
    // send you to different places.
    expect(s.reason).toContain("http");
  });

  it("is NOT pulled down by an advisory monitor", () => {
    const s = resolveStatus([m(), m({ id: "m2", required: false, up: false, error: "no ICMP" })]);
    expect(s.state).toBe("up");
  });

  it("ignores a disabled monitor entirely", () => {
    expect(resolveStatus([m({ enabled: false, up: false })]).state).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/monitoring/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Filter to enabled monitors; ignore advisory ones when deciding the state but keep them for display; return `down` with the first failing required monitor's type and error as the reason, `up` when all required ones are up, and `unknown` when none has reported.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/monitoring && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the advisory rule discriminates**

Make `required` ignored so every monitor gates the dot. The advisory test must go red. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/server/monitoring/status.ts src/server/monitoring/status.test.ts
git commit -m "feat(monitoring): resolve a target's monitors into one status"
```

---

### Task 9: Routes

**Files:**
- Create: `src/server/routes/devices.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/routes/devices.test.ts`

**Interfaces:**
- Produces, all admin-only:
  - `GET /api/devices` → `{ devices: DeviceSummary[] }`
  - `POST /api/devices` `[device:create]` → 201 `{ id }` (manual devices)
  - `PATCH /api/devices/:id` `[device:update]` → `{ ok: true }`
  - `DELETE /api/devices/:id` `[device:delete]` → `{ ok: true }`
  - `GET /api/devices/:id` → `{ device, monitors: MonitorSummary[], uptime: UptimeWindow[], history: HistoryBucket[] }`
  - `POST /api/devices/:id/monitors` `[monitor:create]`, `PATCH /api/monitors/:id`, `DELETE /api/monitors/:id`
  - `POST /api/monitors/:id/push/:token` — **unauthenticated by session**, authorised by the token itself
  - `POST /api/settings/tailscale` `[settings:write]` → stores the encrypted key, runs a sync, returns `{ deviceCount }`

- [ ] **Step 1: Write the failing tests**

Follow the harness in `src/server/routes/projects.test.ts`. Cover at minimum: a viewer is refused every device and monitor route; `GET /api/devices/:id` returns 404 for an unknown id; a manual device can be created, patched and deleted; a synced device's Tailscale fields cannot be patched; the push endpoint records a timestamp for a valid token and 404s for an unknown one; and `POST /api/settings/tailscale` stores an **encrypted** value — assert the stored setting does not contain the plaintext token.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/routes/devices.test.ts`
Expected: FAIL — routes unregistered.

- [ ] **Step 3: Implement**

Register in `src/server/app.ts` alongside the existing modules, passing `db`, `secretKey` and an injectable `tailscale` factory so tests never reach the network.

The push route is deliberately outside session auth — a cron line cannot log in. Its token is its credential, so it must be compared in constant time, must not be logged, and an unknown token returns 404 rather than 401 so the endpoint does not confirm which tokens exist.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Verify permissions.ts is untouched**

```bash
git diff --quiet HEAD -- src/server/auth/permissions.ts && echo UNCHANGED
```

Expected: `UNCHANGED`. If a test returns 403, the fix is in the test's user setup, never in that file.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/devices.ts src/server/routes/devices.test.ts src/server/app.ts
git commit -m "feat(api): add device, monitor and tailscale settings routes"
```

---

### Task 10: The devices list

**Files:**
- Modify: `src/web/lib/queries.ts`, `src/web/App.tsx`
- Create: `src/web/routes/Devices.tsx`, `src/web/routes/devices.test.tsx`

**Interfaces:**
- Produces: `useDevices()`, `useCreateDevice()`, `useUpdateDevice()`, `useDeleteDevice()`; the `/devices` route.

**Do not set `retry` or `refetchOnWindowFocus` on any hook.** They are client defaults applied in `main.tsx` via `createQueryDefaults()`; re-adding them per hook is a defect this project has already fixed twice. `isRefusal` is exported from `queries.ts` — reuse it.

- [ ] **Step 1: Write the failing tests**

Cover: the list renders a device with its status dot and Tailscale state; **an online device shows "connected" rather than a last-seen time**, because `lastSeen` is null while connected; hidden devices are behind a toggle; a 403 renders the clean refusal state used elsewhere; and the empty state explains that no Tailscale key is configured yet.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web/routes/devices.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Register `/devices` inside the existing protected layout route in `App.tsx`, keeping every current registration. Add a nav entry. Use the primitives from `src/web/components/ui/index.js` — **check the real signatures**: `EmptyState` takes `title`/`description`/`action` (not children), `SegmentedControl` takes `items: { id, label }[]`, `Input` already carries `border border-border` and `min-h-11`.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/queries.ts src/web/App.tsx src/web/routes/Devices.tsx src/web/routes/devices.test.tsx
git commit -m "feat(web): add the devices list"
```

---

### Task 11: Device detail, history bar, and wiring the runner

**Files:**
- Create: `src/web/routes/DeviceDetail.tsx`, `src/web/components/HistoryBar.tsx`, `src/web/components/MonitorEditor.tsx`, `e2e/devices.spec.ts`
- Modify: `src/web/App.tsx`, `src/server/index.ts`
- Test: `src/web/components/history-bar.test.tsx`, `src/web/routes/device-detail.test.tsx`

- [ ] **Step 1: Write the failing tests**

`history-bar.test.tsx` — the fixture must contain the state being asserted, or the test proves nothing:

```typescript
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HistoryBar } from "./HistoryBar.js";

describe("HistoryBar", () => {
  it("renders one segment per bucket", () => {
    const buckets = [
      { startedAt: 0, ratio: 1 },
      { startedAt: 1, ratio: 0 },
      { startedAt: 2, ratio: null },
    ];
    render(<HistoryBar buckets={buckets} />);
    expect(screen.getAllByRole("presentation", { hidden: true })).toHaveLength(3);
  });

  it("distinguishes up, down and no-data", () => {
    // A fixture with no outage cannot detect a bar that never renders red, and
    // one with no gap cannot detect "no data" being drawn as an outage.
    const { container } = render(
      <HistoryBar buckets={[{ startedAt: 0, ratio: 1 }, { startedAt: 1, ratio: 0 }, { startedAt: 2, ratio: null }]} />,
    );
    const classes = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("class") ?? "");
    expect(new Set(classes).size).toBe(3);
  });

  it("labels itself for screen readers rather than being a wall of rects", () => {
    render(<HistoryBar buckets={[{ startedAt: 0, ratio: 1 }]} />);
    expect(screen.getByRole("img")).toHaveAccessibleName(/history/i);
  });
});
```

`device-detail.test.tsx` covers: monitors listed with their state; uptime figures shown for 24h/30d/1y; **a null uptime rendering as "no data" and not "0%"**; adding and removing a monitor; and marking one advisory.

`e2e/devices.spec.ts` imports `test` from `./support/fixtures.js`, stubs the API, and asserts the list and detail render at both viewports. Run `expectTappable` and `expectNoHorizontalScroll` on both routes — no existing sweep visits them.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web && pnpm e2e`
Expected: FAIL.

- [ ] **Step 3: Implement the history bar**

Hand-rolled SVG: a `<rect>` per bucket, filled from a token class. No charting library — one would style through its own props, which `design-system.test.ts` cannot police, for a dozen rectangles. Give the `<svg>` `role="img"` and an accessible name summarising the window.

- [ ] **Step 4: Implement the detail view and the monitor editor**

Register `/devices/:id`. Every control at least 44px in both dimensions; any bordered element uses `border border-border`.

- [ ] **Step 5: Start the runner in the real server only**

In `src/server/index.ts`, after `buildApp`, create the runner with `now: () => Date.now()` and a `setTimer` wrapping `setInterval`, and `start()` it. Register `stop()` on shutdown. **`buildApp` must not start it** — that is what keeps a real timer out of every route test.

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm e2e`
Expected: PASS at both viewports.

- [ ] **Step 7: Confirm no host side effects**

```bash
docker ps -a --format '{{.ID}}' | sort > /tmp/before.txt
pnpm e2e
docker ps -a --format '{{.ID}}' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "no drift"
```

Also confirm the unit suite starts no real timer: `pnpm test` must not hang or exit late.

- [ ] **Step 8: Commit**

```bash
git add src/web e2e src/server/index.ts
git commit -m "feat(web): add device detail with the history bar, and start the runner"
```

---

## Definition of Done

- `pnpm typecheck`, `pnpm test`, `pnpm lint` clean; `pnpm e2e` green at **both** viewports.
- `src/server/auth/permissions.ts` changed in exactly one commit, adding two lines to `adminRole` and nothing to `viewerRole`.
- A viewer is refused every device and monitor route.
- The runner checks a due monitor, skips one that is not due, and is never started by `buildApp`.
- No test opens a socket, starts a container, or uses a real timer.
- Uptime with no observations renders as "no data", never "0%".
- A device renamed in Homestead keeps its name across a Tailscale sync.
- An online device shows as connected rather than showing a stale last-seen time.
- The Tailscale token is stored encrypted — the stored setting does not contain the plaintext.

## Handoff to the Dashboard plan

- `targetType`/`targetId` already accept `'app'`; no migration needed.
- Apps come from three sources (product design §9.1): managed projects, discovered containers carrying `homestead.*` labels, and manual rows. All three become targets.
- A project-backed app auto-provisions four monitors — container, internal port, internal URL, DNS — reconciled against `docker compose config` on every project change, or a monitor outlives the port it watches.
- That set needs a sixth monitor type, `docker`, reading container state and `HEALTHCHECK` through the existing wrapper. `push` and `tailscale` already establish that a check need not be a network call.
- `resolveStatus` and `HistoryBar` are target-agnostic and reused as-is.
- Still deferred: notifications; ICMP; latency and the response-time graph; inferring "at home".
