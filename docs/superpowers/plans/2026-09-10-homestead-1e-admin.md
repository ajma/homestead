# Homestead Phase 1E — Admin Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin a place to add, inspect, operate and configure every app — the dense inventory table, the two ways in (adopt from disk, create from scratch), and the tabbed edit page — so the APIs built across Phases 1B, 1C and 1D stop being reachable only by `curl`.

**Architecture:** Almost everything server-side already exists and is reviewed; 1E is predominantly React on top of it, plus one new endpoint (`POST /api/apps`) and one small fix to Phase 1C's probe routes. Tabs are routes, and each tab is the data-loading boundary — compose, container detail and the log stream load on navigation and tear down on leave, rather than being fetched because someone glanced at a status header.

**Tech Stack:** Fastify, Drizzle + libSQL, React 19, TanStack Query 5, react-router-dom 7, Tailwind 4, Vitest + @testing-library/react + jsdom. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — section 8 (Admin inventory, Edit page), with §4 for the lifecycle and log semantics the UI drives.

**Carry-forward this plan must respect:** `docs/superpowers/plans/2026-09-10-homestead-1d-carry-forward.md`, and through it 1B's and 1C's.

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess`; ESM with `.js` import specifiers on server relative imports; `moduleResolution: bundler`; no `baseUrl`; `target: ES2022` / `lib: ES2023`.
- **No new dependencies.**
- zod 4 for request validation. Vitest for tests. Biome for lint and format.
- Every non-2xx response body carries an `error` slug.
- `inScope` / `visibleAppsWhere` / `canForApp` in `src/server/auth/context.ts` are the **only** scope predicates. Do not write another.
- A hijacked reply is never returned from a handler.
- **Every `.tsx` test file starts with `// @vitest-environment jsdom`.** `environmentMatchGlobs` does not exist in Vitest 5; `src/web/test-environment.test.ts` enforces the docblock, and forgetting it is silent for any test that never renders.
- Check Biome by exit code, never by piping to `tail`: `pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"`.
- `pnpm exec tsc --noEmit` is a separate gate: **vitest does not typecheck.**
- Run the full suite at least **three times** before believing it green.
- Every admin route requires the right capability. A viewer must reach none of this: `/apps` and `/apps/:slug/*` redirect a viewer to `/`.

---

## Rulings made while writing this plan

**1. The admin inventory trusts the live `/api/apps` rollup, not the debounced probe status.** The 1D carry-forward requires this choice to be made deliberately. The launcher took the debounced status because it must never depend on the monitoring pipeline. The inventory is the opposite case: an admin looking at it is about to *act* — deploy, restart, pull — and wants ground truth about what Docker says right now, including "Docker is unreachable", which the debounced path smooths over. `/api/apps` already does exactly that, at the cost of one `listContainers` and up to four `docker compose config` spawns, which is acceptable on a screen an admin opens deliberately.

The consequence must be handled rather than hidden: during a grace window the inventory can read `down` while the launcher reads `starting` for the same app. Task 3 renders the inventory's status from the same `StatusChip` the launcher uses, so the two look consistent even when they legitimately differ, and Task 3's overview copy names the source.

**2. `POST /api/apps` scaffolds a minimal compose file, not a template gallery.** The spec says "new directory, scaffolded compose". A one-service starter that `docker compose config` accepts is the whole requirement; a library of stack templates is a product decision nobody has made.

**3. Probe mutations must publish, and that fix lands in this phase rather than being carried again.** `probes.ts` PATCH and DELETE currently publish nothing, so every open tab keeps a stale `ProbeSnapshot`. 1E is the phase that ships the probe-editing UI, so shipping it without the fix means shipping a screen whose changes do not appear. Task 11 does both.

**4. The log tab reuses the existing SSE endpoint and does not introduce a second event stream at the shell.** Spec §8: one `EventSource` for the whole app; "job output and log streams get their own short-lived SSE connections scoped to their route." Those are route-scoped and torn down on navigate.

**5. No exposure tab.** Cloudflare is Phase 2. The edit page ships `overview`, `containers`, `logs`, and — after 1F — `compose` and `env`. Task 6 builds the tab shell so 1F adds two routes and nothing else.

---

## File Structure

**Server — new:** `src/server/apps/scaffold.ts` (the starter compose file and its validation).

**Server — modified:** `src/server/routes/apps.ts` (`POST /api/apps`), `src/server/routes/probes.ts` (publish on mutation), `src/server/routes/events.ts` (an `app-changed` frame).

**Web — new, by responsibility:**

| File | Responsibility |
|---|---|
| `src/web/api/admin.ts` | Query hooks and keys for apps, jobs, containers, images, probes. |
| `src/web/routes/AdminApps.tsx` | The inventory table. Desktop dense, mobile compact. |
| `src/web/routes/AdoptDialog.tsx` | Scan + multi-select adopt. |
| `src/web/routes/CreateAppDialog.tsx` | New directory + scaffolded compose. |
| `src/web/routes/EditApp.tsx` | Shell: sticky header, tab routes, right rail / bottom bar. |
| `src/web/routes/edit/OverviewTab.tsx` | Metadata, icon picker, launcher settings. |
| `src/web/routes/edit/ContainersTab.tsx` | Container list and detail. |
| `src/web/routes/edit/LogsTab.tsx` | Route-scoped log stream. |
| `src/web/routes/edit/ProbesPanel.tsx` | Probe CRUD. |
| `src/web/components/IconPicker.tsx` | Consumes `/api/icons/search`. |
| `src/web/components/ActionBar.tsx` | up / down / restart / pull, with job output. |
| `src/web/components/JobOutput.tsx` | Route-scoped SSE consumer for one job. |
| `src/web/lib/use-sse-text.ts` | Shared: open an SSE stream, accumulate text, close on unmount. |

**Web — modified:** `src/web/App.tsx` (routes), `src/web/routes/AppLayout.tsx` (nav).

---

### Task 1: `POST /api/apps` — create an app with a scaffolded compose file

The spec's second entry point. Adoption handles directories that already exist; this makes one.

**Files:**
- Create: `src/server/apps/scaffold.ts`
- Modify: `src/server/routes/apps.ts`
- Test: `src/server/apps/scaffold.test.ts`, `src/server/routes/apps-create.test.ts`

**Interfaces:**
- Consumes: `Host` (`writeTextFile`, `readTextFile`, `listAppDirectories`), `ComposeConfigCache`, `uniqueSlug`, `audit`, `requireCapability(request, "app:config")`.
- Produces: `scaffoldCompose(displayName: string): string`; `POST /api/apps` accepting `{ displayName, directory, description?, iconRef?, category? }` and returning `201` with an `AdminApp`.

- [ ] **Step 1: Write the failing scaffold test**

`src/server/apps/scaffold.test.ts`:

```ts
import { scaffoldCompose } from "@server/apps/scaffold";
import { describe, expect, it } from "vitest";

describe("scaffoldCompose", () => {
  it("produces a compose file with one commented-out service", () => {
    const yaml = scaffoldCompose("Jellyfin");
    expect(yaml).toContain("services:");
    expect(yaml).toContain("Jellyfin");
  });

  it("is valid YAML that declares at least one service key", () => {
    // A scaffold that `docker compose config` rejects makes the app unusable the moment
    // it is created, and the user has no editor yet to fix it — that is Phase 1F.
    const yaml = scaffoldCompose("Jellyfin");
    expect(yaml).toMatch(/^services:$/m);
    expect(yaml.split("\n").some((l) => /^\s{2}\w[\w-]*:$/.test(l))).toBe(true);
  });

  it("does not interpolate the display name into a YAML key", () => {
    // "My App: v2" as a service key would produce a parse error at creation time.
    const yaml = scaffoldCompose('My App: v2 "quoted"');
    expect(yaml).toMatch(/^services:$/m);
    expect(yaml).not.toMatch(/^\s{2}My App: v2/m);
  });

  it("names the service after a slugified display name where it can", () => {
    expect(scaffoldCompose("Home Assistant")).toContain("home-assistant:");
  });

  it("falls back to a generic service name when nothing usable survives slugifying", () => {
    expect(scaffoldCompose("!!!")).toContain("app:");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/server/apps/scaffold.test.ts`
Expected: FAIL — cannot resolve `@server/apps/scaffold`.

- [ ] **Step 3: Implement the scaffold**

`src/server/apps/scaffold.ts`:

```ts
/**
 * The starter compose file for an app created from scratch.
 *
 * Deliberately minimal. The spec asks for "a scaffolded compose", not a template
 * gallery, and a library of stack templates is a product decision nobody has made.
 * What matters is that `docker compose config` accepts it: the user has no editor until
 * Phase 1F, so a scaffold that fails validation leaves them with an app they cannot fix
 * from inside Homestead.
 */
export function scaffoldCompose(displayName: string): string {
  // Never interpolate the raw name into a key. `My App: v2` would produce a YAML parse
  // error at creation time, on a file the user cannot yet edit.
  const service =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app";

  return `# ${displayName}
#
# Created by Homestead. Replace the image and ports below, then deploy.
services:
  ${service}:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run src/server/apps/scaffold.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Write the failing route test**

`src/server/routes/apps-create.test.ts`:

```ts
import { apps } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

async function ready() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: JSON.stringify({ name: "jellyfin", services: { jellyfin: {} } }),
    stderr: "",
  });
  return { app, cookie };
}

describe("POST /api/apps", () => {
  it("creates the directory, writes a compose file, and returns the app", async () => {
    const { app, cookie } = await ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ displayName: "Jellyfin", directory: "jellyfin" });
    expect(app.deps.host.files.get("jellyfin/compose.yaml")).toContain("services:");
  });

  it("refuses a directory that already exists rather than overwriting it", async () => {
    // Overwriting someone's compose file because they reused a name is unrecoverable
    // from inside Homestead — there is no undo and no editor until Phase 1F.
    const { app, cookie } = await ready();
    app.deps.host.files.set("jellyfin/compose.yaml", "services: { existing: {} }\n");
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("directory_exists");
    expect(app.deps.host.files.get("jellyfin/compose.yaml")).toContain("existing");
  });

  it("rejects a directory that escapes the compose root", async () => {
    const { app, cookie } = await ready();
    for (const directory of ["../etc", "a/../../etc", "/etc", "a/b"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/apps",
        headers: { cookie },
        payload: { displayName: "X", directory },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBeTruthy();
    }
  });

  it("leaves no half-created app when the compose write fails", async () => {
    const { app, cookie } = await ready();
    app.deps.host.writeTextFile = async () => {
      throw new Error("disk full");
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(await app.deps.db.select().from(apps).where(eq(apps.directory, "jellyfin"))).toEqual([]);
  });

  it("creates one enabled docker probe, like adoption does", async () => {
    // An app invisible to monitoring is the bug the probe exists to prevent, and a
    // created app is no different from an adopted one in that respect.
    const { app, cookie } = await ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    const probes = await app.inject({
      method: "GET",
      url: `/api/apps/${created.json().id}/probes`,
      headers: { cookie },
    });
    expect(probes.json()).toHaveLength(1);
    expect(probes.json()[0]).toMatchObject({ kind: "docker", enabled: true });
  });

  it("is forbidden to a viewer", async () => {
    const { app, cookie } = await ready();
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie: viewer.cookie },
      payload: { displayName: "X", directory: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run src/server/routes/apps-create.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 7: Implement the route**

In `src/server/routes/apps.ts`, beside the adopt route. Reuse the directory validation the compose routes already apply — find it rather than writing a second one; if it is not currently exported, export it rather than duplicating the rule.

```ts
const createBody = z.object({
  displayName: z.string().min(1).max(100),
  // A single path segment. Anything with a separator, a dot segment, or a leading slash
  // is refused here as well as by the host's confinement check — two layers, because the
  // regex is the kind of thing a later change loosens.
  directory: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "directory must be a single path segment"),
  description: z.string().max(500).nullable().optional(),
  iconRef: z.string().max(64).nullable().optional(),
  category: z.string().max(64).nullable().optional(),
});

app.post("/api/apps", async (request, reply) => {
  const ctx = requireCapability(request, "app:config");
  const body = createBody.parse(request.body);

  // Existence check before any write. Overwriting a compose file because someone reused
  // a directory name is unrecoverable from inside Homestead.
  const existing = await db
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.hostId, LOCAL_HOST_ID), eq(apps.directory, body.directory)));
  if (existing.length > 0) return reply.code(409).send({ error: "directory_exists" });
  try {
    await host.readTextFile(`${body.directory}/compose.yaml`);
    return reply.code(409).send({ error: "directory_exists" });
  } catch {
    // Not there, which is what we want.
  }

  // Write the file first. A row pointing at a directory that does not exist is worse
  // than a directory with no row: the row is visible in the UI and every action on it
  // fails, while a stray directory is picked up by the next scan as adoptable.
  await host.writeTextFile(`${body.directory}/compose.yaml`, scaffoldCompose(body.displayName));

  const id = ulid();
  const slug = await uniqueSlug(db, LOCAL_HOST_ID, body.displayName);
  await db.transaction(async (tx) => {
    await tx.insert(apps).values({
      id,
      hostId: LOCAL_HOST_ID,
      slug,
      displayName: body.displayName,
      description: body.description ?? null,
      iconRef: body.iconRef ?? null,
      category: body.category ?? null,
      directory: body.directory,
      composeFile: "compose.yaml",
      projectName: normaliseProjectName(body.directory),
    });
    await tx.insert(probes).values({ id: ulid(), appId: id, kind: "docker", enabled: true });
  });

  await audit(db, ctx, {
    action: "app.created",
    targetType: "app",
    targetId: id,
    detail: { directory: body.directory },
    ip: request.ip,
  });

  const [row] = await db.select().from(apps).where(eq(apps.id, id));
  if (!row) return reply.code(500).send({ error: "created_but_missing" });
  return reply.code(201).send(toAdminApp(row, await statusFor({ host, composeConfig }, row)));
});
```

- [ ] **Step 8: Run and verify**

Run: `pnpm exec vitest run src/server/routes/apps-create.test.ts src/server/apps/scaffold.test.ts`
Expected: all pass.

- [ ] **Step 9: Binding checks**

- Remove the existence check → the "refuses a directory that already exists" test must fail.
- Loosen the `directory` regex to `z.string()` → the escape test must fail.
- Move the compose write after the insert, then make the write throw → the "no half-created app" test must fail.

Report each as "broke X → test Y failed → restored → green".

- [ ] **Step 10: Commit**

```bash
git add src/server/apps/scaffold.ts src/server/apps/scaffold.test.ts src/server/routes/apps.ts src/server/routes/apps-create.test.ts
git commit -m "Create an app from scratch with a compose file it can actually deploy"
```

---

### Task 2: Admin query hooks

One module for every admin read, so the components below stay about presentation and the cache keys live in one place.

**Files:**
- Create: `src/web/api/admin.ts`
- Test: `src/web/api/admin.test.ts`

**Interfaces:**
- Consumes: `apiFetch` from `@web/api/client`; `AdminApp` from `@shared/dto`.
- Produces:
  ```ts
  export const adminAppsKey = ["admin", "apps"] as const;
  export const adminAppKey = (id: string) => ["admin", "apps", id] as const;
  export const containersKey = (id: string) => ["admin", "apps", id, "containers"] as const;
  export const jobsKey = (id: string) => ["admin", "apps", id, "jobs"] as const;
  export const imagesKey = (id: string) => ["admin", "apps", id, "images"] as const;
  export const probesKey = (id: string) => ["admin", "apps", id, "probes"] as const;
  export const scanKey = ["admin", "scan"] as const;
  export function useAdminApps(): UseQueryResult<AdminApp[]>;
  export function useAdminApp(id: string | null): UseQueryResult<AdminApp>;
  export function useContainers(id: string | null): UseQueryResult<ContainerSummary[]>;
  export function useJobs(id: string | null): UseQueryResult<JobRow[]>;
  export function useImages(id: string | null): UseQueryResult<ImageStatusRow[]>;
  export function useProbes(id: string | null): UseQueryResult<ProbeRow[]>;
  export function useScan(enabled: boolean): UseQueryResult<ScanResult>;
  ```

- [ ] **Step 1: Write the failing test**

`src/web/api/admin.test.ts`:

```ts
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { adminAppsKey, containersKey, useAdminApps, useContainers, useScan } from "@web/api/admin";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

describe("admin query hooks", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(JSON.stringify(url.includes("scan") ? { discovered: [], orphans: [] } : []), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  it("keys the app list distinctly from the launcher's list", () => {
    // Sharing a key would make an admin's expensive rollup overwrite the launcher's
    // cheap one, and the launcher would start depending on Docker by accident.
    expect(adminAppsKey).not.toEqual(["launcher"]);
  });

  it("keys per-app collections under that app's id", () => {
    expect(containersKey("a1")).not.toEqual(containersKey("a2"));
  });

  it("does not fetch a per-app collection while the id is null", async () => {
    const { Wrapper } = wrapper();
    renderHook(() => useContainers(null), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not scan until asked", async () => {
    // The scan walks the whole compose root and lists every container. Firing it on
    // mount would make opening the inventory pay for a dialog nobody opened.
    const { Wrapper } = wrapper();
    renderHook(() => useScan(false), { wrapper: Wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches the app list from /api/apps", async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useAdminApps(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/apps");
  });
});
```

Name the file `src/web/api/admin.test.tsx` (it renders) and start it with `// @vitest-environment jsdom`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/api/admin.test.tsx`
Expected: FAIL — cannot resolve `@web/api/admin`.

- [ ] **Step 3: Implement**

`src/web/api/admin.ts`:

```ts
import type { AdminApp } from "@shared/dto";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

/**
 * Keyed separately from the launcher's `["launcher"]`.
 *
 * `/api/apps` computes a live rollup — one `listContainers` plus up to four concurrent
 * `docker compose config` spawns — while `/api/launcher` deliberately touches neither.
 * Sharing a cache key would let the expensive answer overwrite the cheap one, and the
 * launcher would start depending on Docker by accident, which is the single thing its
 * design exists to prevent.
 */
export const adminAppsKey = ["admin", "apps"] as const;
export const adminAppKey = (id: string) => ["admin", "apps", id] as const;
export const containersKey = (id: string) => ["admin", "apps", id, "containers"] as const;
export const jobsKey = (id: string) => ["admin", "apps", id, "jobs"] as const;
export const imagesKey = (id: string) => ["admin", "apps", id, "images"] as const;
export const probesKey = (id: string) => ["admin", "apps", id, "probes"] as const;
export const scanKey = ["admin", "scan"] as const;

export function useAdminApps() {
  return useQuery({
    queryKey: adminAppsKey,
    queryFn: () => apiFetch<AdminApp[]>("/api/apps"),
    staleTime: 15_000,
  });
}

export function useAdminApp(id: string | null) {
  return useQuery({
    queryKey: adminAppKey(id ?? ""),
    enabled: id !== null,
    queryFn: () => apiFetch<AdminApp>(`/api/apps/${id}`),
    staleTime: 15_000,
  });
}

function perApp<T>(key: readonly unknown[], id: string | null, path: string, staleTime: number) {
  return { queryKey: key, enabled: id !== null, queryFn: () => apiFetch<T>(path), staleTime };
}

export function useContainers(id: string | null) {
  return useQuery(perApp<ContainerRow[]>(containersKey(id ?? ""), id, `/api/apps/${id}/containers`, 5_000));
}

export function useJobs(id: string | null) {
  return useQuery(perApp<JobRow[]>(jobsKey(id ?? ""), id, `/api/apps/${id}/jobs`, 5_000));
}

export function useImages(id: string | null) {
  return useQuery(perApp<ImageStatusRow[]>(imagesKey(id ?? ""), id, `/api/apps/${id}/images`, 60_000));
}

export function useProbes(id: string | null) {
  return useQuery(perApp<ProbeRow[]>(probesKey(id ?? ""), id, `/api/apps/${id}/probes`, 15_000));
}

export function useScan(enabled: boolean) {
  return useQuery({
    queryKey: scanKey,
    enabled,
    // The scan walks the whole compose root and lists every container on the host.
    // Gated so opening the inventory does not pay for a dialog nobody opened.
    queryFn: () => apiFetch<ScanResult>("/api/apps/scan"),
    staleTime: 0,
    gcTime: 0,
  });
}
```

The row types (`ContainerRow`, `JobRow`, `ImageStatusRow`, `ProbeRow`, `ScanResult`) are not currently exported to the web zone. **Add them to `src/shared/admin.ts` as a new file** rather than importing from `@server/*` — the web bundle must not pull in server code. Mirror the shapes from `src/server/db/schema.ts`, `src/server/host/types.ts` (`ContainerSummary`) and `src/server/apps/adoption.ts` (`ScanResult`, `DiscoveredApp`, `OrphanStack`), and make the server import them from shared so a drift becomes a type error rather than a runtime surprise.

- [ ] **Step 4: Run and verify**

Run: `pnpm exec vitest run src/web/api/admin.test.tsx`
Expected: all pass.

- [ ] **Step 5: Binding checks**

- Set `adminAppsKey` to `["launcher"]` → the distinct-key test must fail.
- Remove `enabled` from `useScan` → the does-not-scan test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/shared/admin.ts src/web/api/admin.ts src/web/api/admin.test.tsx src/server
git commit -m "Give the admin surfaces their own cache keys, separate from the launcher's"
```

---

### Task 3: The inventory table

Spec §8: *"Dense table on desktop — name, status, exposure hostname, image-update count, last deploy, row actions — collapsing to compact rows on mobile."* Exposure is Phase 2, so that column is omitted rather than stubbed.

**Files:**
- Create: `src/web/routes/AdminApps.tsx`
- Modify: `src/web/App.tsx`, `src/web/routes/AppLayout.tsx`
- Test: `src/web/routes/AdminApps.test.tsx`

**Interfaces:**
- Consumes: `useAdminApps` (Task 2), `StatusChip` and `AppIcon` from `@web/components/*`, `relativeTime`, `useNow`.
- Produces: `<AdminApps />` at `/apps`.

- [ ] **Step 1: Write the failing test**

`src/web/routes/AdminApps.test.tsx` — first line `// @vitest-environment jsdom`:

```tsx
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { adminAppsKey } from "@web/api/admin";
import { AdminApps } from "@web/routes/AdminApps";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const app = (over: Partial<AdminApp> = {}): AdminApp => ({
  id: "a1", slug: "jellyfin", displayName: "Jellyfin", description: null, iconRef: null,
  category: "Media", launchUrl: null, status: "up", statusDetail: null,
  hostId: "local", directory: "jellyfin", composeFile: "compose.yaml", projectName: "jellyfin",
  lastComposeHash: null, isSystem: false, showOnLauncher: true, sortOrder: 0,
  graceUntil: null, adoptedAt: 1_800_000_000, archivedAt: null, ...over,
});

function mount(seed?: AdminApp[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) client.setQueryData(adminAppsKey, seed);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminApps />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AdminApps", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([app()]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  it("lists each app with its status and directory", async () => {
    mount([app()]);
    expect(screen.getByText("Jellyfin")).toBeTruthy();
    expect(screen.getByText(/jellyfin/)).toBeTruthy();
  });

  it("links each row to that app's edit page by slug", async () => {
    mount([app({ slug: "jellyfin" })]);
    expect(screen.getByRole("link", { name: /Jellyfin/ }).getAttribute("href")).toBe(
      "/apps/jellyfin",
    );
  });

  it("renders cached rows immediately rather than a spinner", async () => {
    mount([app({ displayName: "Cached" })]);
    expect(screen.getByText("Cached")).toBeTruthy();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  it("keeps showing cached rows when a background refetch fails", async () => {
    // The same defect the launcher shipped and had to fix: `isError` alone throws away
    // rows that are still in hand.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(adminAppsKey, [app({ displayName: "Still here" })]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AdminApps />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await client.invalidateQueries({ queryKey: adminAppsKey }).catch(() => {});
    await waitFor(() => expect(screen.getByText("Still here")).toBeTruthy());
  });

  it("shows an error only when there is nothing cached to show", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    mount();
    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeTruthy());
  });

  it("shows an empty state with both entry points when there are no apps", async () => {
    mount([]);
    await waitFor(() => expect(screen.getByText(/No apps yet/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Adopt from disk/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create app/ })).toBeTruthy();
  });

  it("marks a system app so it cannot be mistaken for one of yours", async () => {
    mount([app({ isSystem: true, displayName: "cloudflared" })]);
    expect(screen.getByText(/System/)).toBeTruthy();
  });

  it("shows when an app is hidden from the launcher", async () => {
    mount([app({ showOnLauncher: false })]);
    expect(screen.getByText(/Hidden/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/routes/AdminApps.test.tsx`
Expected: FAIL — cannot resolve `@web/routes/AdminApps`.

- [ ] **Step 3: Implement**

`src/web/routes/AdminApps.tsx`. Render one `<Link to={`/apps/${app.slug}`}>` per row; use `StatusChip` with `status={app.status}`, `reason={app.statusDetail ?? "Healthy"}` and `since={null}`, so the inventory and the launcher look consistent even where they legitimately differ.

The error branch must be `isError && !data`, not `isError`:

```tsx
  // `isError` alone throws away rows that are still in hand. The launcher shipped
  // exactly that bug: a failed background refetch replaced a working grid, and whatever
  // the user was typing, with an error message. Keep the rows and say they may be stale.
  if (isError && !data) return <p className="p-6 text-sm text-rose-600">Could not load your apps.</p>;
```

Two buttons in the header and in the empty state — "Adopt from disk" and "Create app" — holding local `useState` for which dialog is open. Tasks 4 and 5 supply the dialogs; for now render `null` in their place and wire them in those tasks.

Desktop is a `<table>`; below `md:` render the same rows as stacked cards. Do not branch on a JS media query — one markup tree with Tailwind's responsive utilities, because a `matchMedia` hook re-renders on every resize and disagrees with CSS at the boundary.

- [ ] **Step 4: Route it and add nav**

In `src/web/App.tsx` replace the `/apps/*` placeholder with `<Route path="/apps" element={<AdminApps />} />`, keeping the existing viewer redirect. `AppLayout` already links to `/apps` for admins.

- [ ] **Step 5: Run and verify**

Run: `pnpm exec vitest run src/web/routes/AdminApps.test.tsx`
Expected: all pass.

- [ ] **Step 6: Binding checks**

- Change the error branch to `if (isError)` → the cached-rows-survive test must fail.
- Remove the `isSystem` badge → its test must fail.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/AdminApps.tsx src/web/routes/AdminApps.test.tsx src/web/App.tsx
git commit -m "List every app an admin can act on, with both ways to add one"
```

---

### Task 4: Adopt from disk

Spec §8: *"Adopt from disk (multi-select scan)."* The endpoint exists and is reviewed; this is the way in.

**Files:**
- Create: `src/web/routes/AdoptDialog.tsx`
- Modify: `src/web/routes/AdminApps.tsx`
- Test: `src/web/routes/AdoptDialog.test.tsx`

**Interfaces:**
- Consumes: `useScan` (Task 2), `apiFetch`, `adminAppsKey`.
- Produces: `<AdoptDialog onClose={() => void} />`.

- [ ] **Step 1: Write the failing test**

`src/web/routes/AdoptDialog.test.tsx` — first line `// @vitest-environment jsdom`:

```tsx
import type { ScanResult } from "@shared/admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdoptDialog } from "@web/routes/AdoptDialog";
import { describe, expect, it, vi } from "vitest";

const SCAN: ScanResult = {
  discovered: [
    { directory: "jellyfin", composeFile: "compose.yaml", projectName: "jellyfin", containerCount: 2, running: true, adopted: false },
    { directory: "gitea", composeFile: "compose.yaml", projectName: "gitea", containerCount: 1, running: false, adopted: false },
    { directory: "taken", composeFile: "compose.yaml", projectName: "taken", containerCount: 1, running: true, adopted: true },
  ],
  orphans: [{ projectName: "stray", containerCount: 3 }],
};

function mount(onClose = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AdoptDialog onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

function stubScan(adoptResponse: unknown = { adopted: [], failed: [] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "POST" ? adoptResponse : SCAN), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("AdoptDialog", () => {
  it("lists unadopted directories as selectable", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    expect(screen.getByLabelText(/gitea/)).toBeTruthy();
  });

  it("shows an already-adopted directory without a checkbox", async () => {
    // Offering to adopt something already adopted produces a confusing 409 the user
    // cannot act on.
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByText(/taken/)).toBeTruthy());
    expect(screen.queryByLabelText(/^taken/)).toBeNull();
  });

  it("surfaces orphan stacks, since they are why a directory is missing", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByText(/stray/)).toBeTruthy());
  });

  it("adopts only the checked directories", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 1/ }));
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST");
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        directories: ["jellyfin"],
      });
    });
  });

  it("disables the adopt button until something is selected", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Adopt/ }).hasAttribute("disabled")).toBe(true);
  });

  it("reports per-directory failures instead of claiming success", async () => {
    // The adopt endpoint returns partial results. Closing on a partial failure hides a
    // directory the user asked for and did not get.
    stubScan({ adopted: [{ id: "a1", directory: "jellyfin" }], failed: [{ directory: "gitea", error: "compose_invalid" }] });
    const onClose = vi.fn();
    mount(onClose);
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByLabelText(/gitea/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 2/ }));
    await waitFor(() => expect(screen.getByText(/gitea/)).toBeTruthy());
    expect(screen.getByText(/compose_invalid/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("invalidates the app list after a successful adopt", async () => {
    stubScan({ adopted: [{ id: "a1", directory: "jellyfin" }], failed: [] });
    const { client } = mount();
    const spy = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 1/ }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/routes/AdoptDialog.test.tsx`
Expected: FAIL — cannot resolve `@web/routes/AdoptDialog`.

- [ ] **Step 3: Implement**

`src/web/routes/AdoptDialog.tsx`. Mount it with `useScan(true)`. Render one checkbox per `discovered` entry where `adopted === false`, showing directory, project name, container count and whether it is running. Render adopted entries as plain text and orphans in their own section with a line explaining what an orphan is — a running compose project with no directory Homestead can see.

`POST /api/apps/adopt` with `{ directories: string[] }`. On response, if `failed` is non-empty, render the failures and keep the dialog open; if everything succeeded, `invalidateQueries({ queryKey: adminAppsKey })` and close.

Follow `HealthPanel`'s dialog pattern from Phase 1D — including its focus capture, initial focus, Tab trap and restore-on-close. Note the measured reason it is divs rather than a native `<dialog>`: jsdom 30.0.1 does not implement `HTMLDialogElement.showModal`.

- [ ] **Step 4: Wire it into the inventory**

In `AdminApps.tsx`, render `<AdoptDialog onClose={...} />` when its state flag is set.

- [ ] **Step 5: Run and verify**

Run: `pnpm exec vitest run src/web/routes/AdoptDialog.test.tsx src/web/routes/AdminApps.test.tsx`
Expected: all pass.

- [ ] **Step 6: Binding checks**

- Send every discovered directory rather than the checked ones → the "adopts only the checked" test must fail.
- Close unconditionally on response → the partial-failure test must fail.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/AdoptDialog.tsx src/web/routes/AdoptDialog.test.tsx src/web/routes/AdminApps.tsx
git commit -m "Adopt stacks already on disk, and say which ones failed"
```

---

### Task 5: Create app

**Files:**
- Create: `src/web/routes/CreateAppDialog.tsx`
- Modify: `src/web/routes/AdminApps.tsx`
- Test: `src/web/routes/CreateAppDialog.test.tsx`

**Interfaces:**
- Consumes: `POST /api/apps` (Task 1), `adminAppsKey`.
- Produces: `<CreateAppDialog onClose={() => void} />`.

- [ ] **Step 1: Write the failing test**

`src/web/routes/CreateAppDialog.test.tsx` — first line `// @vitest-environment jsdom`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateAppDialog } from "@web/routes/CreateAppDialog";
import { describe, expect, it, vi } from "vitest";

function mount(onClose = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateAppDialog onClose={onClose} />
    </QueryClientProvider>,
  );
}

function ok(body: unknown = { id: "a1", slug: "jellyfin" }, status = 201) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    ),
  );
}

describe("CreateAppDialog", () => {
  it("suggests a directory from the display name as you type", async () => {
    ok();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Home Assistant" } });
    expect((screen.getByLabelText(/Directory/) as HTMLInputElement).value).toBe("home-assistant");
  });

  it("stops suggesting once the directory has been edited by hand", async () => {
    // Overwriting a deliberate choice on the next keystroke is the classic version of
    // this bug, and it is infuriating precisely because it only bites careful users.
    ok();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Home Assistant" } });
    fireEvent.change(screen.getByLabelText(/Directory/), { target: { value: "hass" } });
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Home Assistant 2" } });
    expect((screen.getByLabelText(/Directory/) as HTMLInputElement).value).toBe("hass");
  });

  it("refuses to submit a directory with a path separator", async () => {
    ok();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/Directory/), { target: { value: "../etc" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/single folder name/i)).toBeTruthy();
  });

  it("shows the server's error rather than a generic failure", async () => {
    ok({ error: "directory_exists" }, 409);
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
  });

  it("closes and invalidates the list on success", async () => {
    ok();
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("disables submit while a create is in flight", async () => {
    // Two clicks would create two directories, and the second 409s having already
    // written a file.
    let resolve: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Creating|Create/ }).hasAttribute("disabled")).toBe(true),
    );
    resolve(new Response(JSON.stringify({ id: "a1" }), { status: 201, headers: { "content-type": "application/json" } }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/routes/CreateAppDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Two controlled inputs plus optional description and category. Track a `directoryTouched` boolean; while it is false, mirror a slugified display name into the directory field, and stop the moment the user edits it.

Validate the directory client-side against the same rule the server uses — `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` — and say "a single folder name" rather than showing the regex. This is a convenience, not the boundary; the server's check is the boundary.

Map the server's error slugs to sentences: `directory_exists` → "A folder with that name already exists." Anything unrecognised falls back to a generic line **plus** the slug, so an unmapped error is diagnosable rather than silent.

Reuse the same dialog shell as `AdoptDialog`, including focus handling.

- [ ] **Step 4: Wire it in, run, verify**

Run: `pnpm exec vitest run src/web/routes/`
Expected: all pass.

- [ ] **Step 5: Binding checks**

- Always mirror the display name into the directory → the "stops suggesting" test must fail.
- Remove the in-flight guard → the disabled-submit test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/CreateAppDialog.tsx src/web/routes/CreateAppDialog.test.tsx src/web/routes/AdminApps.tsx
git commit -m "Create an app from the inventory, without inventing a folder name twice"
```

---

### Task 6: The edit page shell

Spec §8: *"Sticky status header. Tabs are routes… Bottom action bar on mobile; persistent right rail on desktop… Tabs are the data-loading boundary."*

**Files:**
- Create: `src/web/routes/EditApp.tsx`
- Modify: `src/web/App.tsx`
- Test: `src/web/routes/EditApp.test.tsx`

**Interfaces:**
- Consumes: `useAdminApps` (to resolve slug → app), `useAdminApp`, `StatusChip`, `AppIcon`.
- Produces: `<EditApp />` at `/apps/:slug/*`, with `<Outlet />` for the tabs. Tab routes are `overview`, `containers`, `logs`; `/apps/:slug` redirects to `overview`.

- [ ] **Step 1: Write the failing test**

`src/web/routes/EditApp.test.tsx` — first line `// @vitest-environment jsdom`:

```tsx
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { adminAppsKey } from "@web/api/admin";
import { EditApp } from "@web/routes/EditApp";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const app: AdminApp = {
  id: "a1", slug: "jellyfin", displayName: "Jellyfin", description: null, iconRef: null,
  category: null, launchUrl: null, status: "up", statusDetail: null, hostId: "local",
  directory: "jellyfin", composeFile: "compose.yaml", projectName: "jellyfin",
  lastComposeHash: null, isSystem: false, showOnLauncher: true, sortOrder: 0,
  graceUntil: null, adoptedAt: 1_800_000_000, archivedAt: null,
};

function mount(path = "/apps/jellyfin/overview", seed: AdminApp[] = [app]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(adminAppsKey, seed);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/apps/:slug/*" element={<EditApp />}>
            <Route path="overview" element={<p>OVERVIEW</p>} />
            <Route path="containers" element={<p>CONTAINERS</p>} />
            <Route path="logs" element={<p>LOGS</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EditApp", () => {
  it("shows the app's name and status in a header", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(app), { status: 200, headers: { "content-type": "application/json" } })));
    mount();
    expect(screen.getByRole("heading", { name: /Jellyfin/ })).toBeTruthy();
  });

  it("renders only the active tab's content", () => {
    // Tabs are the data-loading boundary. If a hidden tab renders, its queries fire and
    // a log stream opens because someone glanced at the status header.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    mount("/apps/jellyfin/containers");
    expect(screen.getByText("CONTAINERS")).toBeTruthy();
    expect(screen.queryByText("LOGS")).toBeNull();
    expect(screen.queryByText("OVERVIEW")).toBeNull();
  });

  it("offers a tab link per route", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    mount();
    for (const name of ["Overview", "Containers", "Logs"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
  });

  it("has no exposure tab, since Cloudflare is Phase 2", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    mount();
    expect(screen.queryByRole("link", { name: /Exposure/ })).toBeNull();
  });

  it("says so plainly when the slug matches no app", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    mount("/apps/nope/overview", []);
    await waitFor(() => expect(screen.getByText(/No app called/)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/web/routes/EditApp.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Resolve `:slug` against `useAdminApps()`, since the inventory is usually already cached and the API keys apps by id rather than slug. When the list is loaded and no slug matches, render "No app called *slug*" with a link back — not a spinner, which would hang forever on a typo.

Header: `AppIcon`, name, `StatusChip`, directory. `sticky top-0` with a background, so it survives scrolling on a phone.

Tabs as `NavLink`s to `overview`, `containers`, `logs`, and `<Outlet />` below. On desktop (`lg:`) a right rail holding the action bar, image updates and metadata; below that breakpoint the action bar is fixed to the bottom. One markup tree, Tailwind responsive utilities, no JS media query.

- [ ] **Step 4: Route it**

In `App.tsx`:

```tsx
<Route path="/apps/:slug" element={<EditApp />}>
  <Route index element={<Navigate to="overview" replace />} />
  <Route path="overview" element={<OverviewTab />} />
  <Route path="containers" element={<ContainersTab />} />
  <Route path="logs" element={<LogsTab />} />
</Route>
```

Tasks 7, 8 and 9 supply those three. Until then point them at `<Placeholder />` so this task's tests pass on their own.

- [ ] **Step 5: Run, verify, binding-check**

- Render every tab's element rather than `<Outlet />` → the only-active-tab test must fail.
- Remove the no-match branch → the "No app called" test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/EditApp.tsx src/web/routes/EditApp.test.tsx src/web/App.tsx
git commit -m "Give each app an edit page whose tabs are routes, so hidden tabs load nothing"
```

---

### Task 7: Overview tab, with the icon picker

Closes the 1D carry-forward item: `GET /api/icons/search` was built and nothing consumed it.

**Files:**
- Create: `src/web/routes/edit/OverviewTab.tsx`, `src/web/components/IconPicker.tsx`
- Test: `src/web/routes/edit/OverviewTab.test.tsx`, `src/web/components/IconPicker.test.tsx`

**Interfaces:**
- Consumes: `useAdminApp`, `PATCH /api/apps/:id`, `GET /api/icons/search?q=`.
- Produces: `<OverviewTab />`; `<IconPicker value={string | null} onChange={(slug: string | null) => void} />`.

- [ ] **Step 1: Write the failing IconPicker test**

`src/web/components/IconPicker.test.tsx` — first line `// @vitest-environment jsdom`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IconPicker } from "@web/components/IconPicker";
import { describe, expect, it, vi } from "vitest";

function mount(value: string | null, onChange = (_: string | null) => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IconPicker value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
}

function stub(icons: Array<{ slug: string; aliases: string[] }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ icons }), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
}

describe("IconPicker", () => {
  it("does not search until the user types", async () => {
    // The catalogue is 3,238 entries. Fetching a default page on mount, for a control
    // most edits never touch, is one request per page view for nothing.
    stub([]);
    mount(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("searches through Homestead's proxy, never a CDN", async () => {
    stub([{ slug: "jellyfin", aliases: [] }]);
    mount(null);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jelly" } });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain("/api/icons/search");
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).not.toContain("jsdelivr");
  });

  it("reports the chosen slug", async () => {
    stub([{ slug: "jellyfin", aliases: [] }]);
    const onChange = vi.fn();
    mount(null, onChange);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jelly" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /jellyfin/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /jellyfin/ }));
    expect(onChange).toHaveBeenCalledWith("jellyfin");
  });

  it("can clear back to a letter tile", async () => {
    // Spec: the generated letter tile is a legitimate final answer, not just a
    // placeholder while an icon loads.
    stub([]);
    const onChange = vi.fn();
    mount("jellyfin", onChange);
    fireEvent.click(screen.getByRole("button", { name: /Use a letter tile/ }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("says nothing matched rather than showing an empty box", async () => {
    stub([]);
    mount(null);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText(/No icons match/)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run, verify it fails, implement**

`IconPicker` holds a query string in state, runs `useQuery` gated on `query.trim() !== ""`, and renders each result as a button showing `AppIcon` plus the slug. A "Use a letter tile" button calls `onChange(null)`.

Debounce the query by 250 ms so a typed word is one request rather than one per keystroke — the endpoint is capped at 50 results and rate-limited at 300/min, and a fast typist would otherwise spend a tenth of that budget on one word.

- [ ] **Step 3: Write the failing OverviewTab test**

Cover: renders the app's current values; `PATCH`es only changed fields; a failed save keeps the user's edits on screen rather than reverting them; toggling `showOnLauncher` persists; the delete control asks for confirmation naming the app and does not delete on cancel.

- [ ] **Step 4: Implement, run, verify**

`OverviewTab` reads the app resolved by `EditApp` (pass it through `<Outlet context>` — that is what `useOutletContext` is for, and it avoids each tab re-resolving the slug). A form over `displayName`, `description`, `category`, `iconRef` and `showOnLauncher`, plus read-only directory, compose file, project name and adoption date.

On save, `PATCH /api/apps/:id` with **only** the fields that changed, then invalidate `adminAppKey(id)` and `adminAppsKey`. Do **not** invalidate the launcher's key from here — the launcher has its own SSE path, and coupling the two makes an admin edit trigger a Docker-touching refetch on a viewer's screen.

Delete asks for confirmation naming the app, per the repo's convention for destructive actions.

- [ ] **Step 5: Binding checks**

- Fetch on mount rather than gating on a non-empty query → the does-not-search test must fail.
- `PATCH` every field rather than the changed ones → the only-changed-fields test must fail.
- Remove the confirmation → the cancel test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/edit/OverviewTab.tsx src/web/components/IconPicker.tsx src/web/routes/edit/OverviewTab.test.tsx src/web/components/IconPicker.test.tsx
git commit -m "Edit an app's identity, and finally let someone pick its icon"
```

---

### Task 8: Containers tab

**Files:**
- Create: `src/web/routes/edit/ContainersTab.tsx`
- Test: `src/web/routes/edit/ContainersTab.test.tsx`

**Interfaces:**
- Consumes: `useContainers` (Task 2), `GET /api/apps/:id/containers/:containerId`.
- Produces: `<ContainersTab />`.

- [ ] **Step 1: Write the failing test**

Cover: one row per container with name, image, state and status; an expanded row fetches detail **only when expanded** (the tab-as-boundary rule applies within the tab too); a stopped container is listed rather than hidden, because "why is this down" is the question the tab answers; an empty list says the stack is not running rather than showing a bare table; a Docker failure is distinguishable from an empty stack.

```tsx
  it("does not fetch detail until a row is expanded", async () => {
    // Fetching every container's inspect payload on mount is one Docker round-trip per
    // container for data nobody asked for.
    stubList([container({ id: "c1" }), container({ id: "c2" })]);
    mount();
    await waitFor(() => expect(screen.getByText(/c1/)).toBeTruthy());
    expect(vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes("/containers/"))).toHaveLength(0);
  });
```

- [ ] **Step 2: Run, verify it fails, implement**

Rows from `useContainers`. Each row is a `<button>` toggling an expanded panel; the panel mounts a child component whose `useQuery` is gated on being expanded, so the detail request happens on expansion and not before.

Distinguish "Docker is unreachable" from "no containers": the containers route surfaces the former, and conflating them tells the user their stack is stopped when Homestead simply cannot see it — the same distinction the docker probe runner makes deliberately.

- [ ] **Step 3: Binding check**

Remove the expansion gate → the does-not-fetch-detail test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/edit/ContainersTab.tsx src/web/routes/edit/ContainersTab.test.tsx
git commit -m "List a stack's containers, fetching detail only when asked"
```

---

### Task 9: Logs tab

Spec §8: *"log streams get their own short-lived SSE connections scoped to their route."* Phase 1B's log route already demultiplexes frames, handles UTF-8 across frame boundaries and aborts the upstream stream on disconnect — the 1B-ii carry-forward records that the abort was a real socket leak. This tab must honour that by closing on navigate.

**Files:**
- Create: `src/web/lib/use-sse-text.ts`, `src/web/routes/edit/LogsTab.tsx`
- Test: `src/web/lib/use-sse-text.test.tsx`, `src/web/routes/edit/LogsTab.test.tsx`

**Interfaces:**
- Consumes: `GET /api/apps/:id/containers/:containerId/logs`.
- Produces:
  ```ts
  export function useSseText(url: string | null): {
    text: string; done: boolean; error: string | null; reset: () => void;
  };
  ```

- [ ] **Step 1: Write the failing hook test**

`src/web/lib/use-sse-text.test.tsx` — first line `// @vitest-environment jsdom`. jsdom has no `EventSource`; reuse the `FakeEventSource` shape from `src/web/live/useEventStream.test.tsx`.

Cover: accumulates `chunk` events in order; sets `done` on the terminal event; sets `error` on an error event **and** still marks the stream finished, because a client that tears down only on `done` hangs when only `error` arrives — that exact bug is in the 1B-ii carry-forward; **closes the connection on unmount**; opens nothing while the url is `null`; opens a *new* connection when the url changes and closes the old one.

```tsx
  it("closes the stream when the component unmounts", () => {
    // Navigating away from the tab must end the upstream Docker stream. The server
    // aborts on disconnect, but only if the client actually disconnects.
    const { unmount } = renderHook(() => useSseText("/api/apps/a1/containers/c1/logs"));
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
```

- [ ] **Step 2: Run, verify it fails, implement the hook**

One `useEffect` keyed on `url`, opening an `EventSource`, listening for `chunk`, `done` and `error`, and closing in the cleanup. Accumulate into a ref plus a state counter rather than concatenating in state on every chunk — a busy `docker compose up` produces hundreds of frames a second, and one React commit per frame will drop them.

Cap retained text at a fixed number of characters, dropping from the front, and say so in a comment: an unbounded buffer on a `--follow` stream is a leak with no ceiling.

- [ ] **Step 3: Write the failing LogsTab test**

Cover: a container selector; the stream opens for the selected container and **switches** when the selection changes; a follow toggle; the pane scrolls to the newest line unless the user has scrolled up (do not fight a user reading history); the stream closes when the tab unmounts.

- [ ] **Step 4: Implement, run, verify, binding-check**

- Remove `close()` from the hook's cleanup → the unmount test must fail.
- Set `done` without setting it on `error` → the error-terminates test must fail.
- Remove the buffer cap → assert on length growth after many chunks and confirm it fails.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/use-sse-text.ts src/web/lib/use-sse-text.test.tsx src/web/routes/edit/LogsTab.tsx src/web/routes/edit/LogsTab.test.tsx
git commit -m "Stream container logs, and hang up when the tab goes away"
```

---

### Task 10: Lifecycle actions and job output

**Files:**
- Create: `src/web/components/ActionBar.tsx`, `src/web/components/JobOutput.tsx`
- Modify: `src/web/routes/EditApp.tsx`
- Test: `src/web/components/ActionBar.test.tsx`, `src/web/components/JobOutput.test.tsx`

**Interfaces:**
- Consumes: `POST /api/apps/:id/actions/:kind` where kind ∈ `up | down | restart | pull`; `GET /api/jobs/:jobId/stream`; `useSseText` (Task 9); `useJobs`, `useImages`.
- Produces: `<ActionBar app={AdminApp} />`, `<JobOutput jobId={string} onDone={() => void} />`.

- [ ] **Step 1: Write the failing ActionBar test**

Cover: four buttons; clicking posts to the right kind; **buttons disable while a job is running for that app**, because the server's mutex rejects a second job and a double-clicked Deploy should not produce an error the user caused by accident; a `409 job_running` response is reported as "already running" rather than as a failure; the destructive action (`down`) asks for confirmation and names the app; the job's output appears while it runs and the app list is invalidated when it finishes.

```tsx
  it("disables every action while one is running", async () => {
    // The runner takes its mutex slot before any await, so a double-click cannot start
    // two jobs — but it can produce a 409 the user did not mean to cause.
    stubStart({ jobId: "j1" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Deploy/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Pull/ }).hasAttribute("disabled")).toBe(true),
    );
  });
```

- [ ] **Step 2: Run, verify it fails, implement**

`ActionBar` posts, stores the returned `jobId`, and renders `<JobOutput jobId onDone={...} />`. `JobOutput` uses `useSseText` against `/api/jobs/:jobId/stream` and renders a monospace pane. On `done`, invalidate `adminAppsKey`, `adminAppKey(id)`, `containersKey(id)` and `jobsKey(id)`, and clear the job id.

Confirm before `down`, naming the app.

- [ ] **Step 3: Binding checks**

- Remove the in-flight disable → the disabled test must fail.
- Remove the `down` confirmation → its cancel test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/ActionBar.tsx src/web/components/JobOutput.tsx src/web/components/ActionBar.test.tsx src/web/components/JobOutput.test.tsx src/web/routes/EditApp.tsx
git commit -m "Deploy, stop, restart and pull, with the output as it happens"
```

---

### Task 11: Probe editing — and make probe changes actually appear

Closes the 1D carry-forward's first item. `probes.ts` PATCH and DELETE publish nothing, so every open tab keeps a stale `ProbeSnapshot`. Shipping the probe UI without this ships a screen whose changes do not show up.

**Files:**
- Modify: `src/server/routes/events.ts`, `src/server/routes/probes.ts`, `src/web/live/useEventStream.ts`
- Create: `src/web/routes/edit/ProbesPanel.tsx`
- Test: `src/server/routes/probes.test.ts` (extend), `src/web/live/useEventStream.test.tsx` (extend), `src/web/routes/edit/ProbesPanel.test.tsx`

**Interfaces:**
- Consumes: `useProbes`, probe CRUD routes, `GET /api/apps/:id/probes/suggestions`.
- Produces: `EventBus.publishAppChanged(appId: string): void`, emitting an `app-changed` SSE frame with `{ appId }`; `<ProbesPanel appId={string} />`.

- [ ] **Step 1: Write the failing server test**

In `src/server/routes/probes.test.ts`:

```ts
it("tells open tabs when a probe is disabled, or they keep showing its old status", async () => {
  // Measured in Phase 1D: docker up plus http down reads down/"Containers not running".
  // Disable the http probe and the server would now say up/"Healthy" while every open
  // tab stays wrong until its stream happens to reconnect.
  const { app, cookie, appId, probeId } = await withProbe();
  const seen: string[] = [];
  app.deps.events.subscribeAppChanged?.((id: string) => seen.push(id));
  await app.inject({
    method: "PATCH", url: `/api/probes/${probeId}`, headers: { cookie }, payload: { enabled: false },
  });
  expect(seen).toEqual([appId]);
});

it("tells open tabs when a probe is deleted", async () => {
  const { app, cookie, appId, probeId } = await withProbe();
  const seen: string[] = [];
  app.deps.events.subscribeAppChanged?.((id: string) => seen.push(id));
  await app.inject({ method: "DELETE", url: `/api/probes/${probeId}`, headers: { cookie } });
  expect(seen).toEqual([appId]);
});

it("does not announce a probe edit that changes nothing a tile shows", async () => {
  // A label change moves no status. Announcing it makes every open tab refetch the
  // launcher for a cosmetic edit.
  const { app, cookie, probeId } = await withProbe();
  const seen: string[] = [];
  app.deps.events.subscribeAppChanged?.((id: string) => seen.push(id));
  await app.inject({
    method: "PATCH", url: `/api/probes/${probeId}`, headers: { cookie }, payload: { label: "Renamed" },
  });
  expect(seen).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails, then implement the server side**

`EventBus` gains a separate `app-changed` channel, kept apart from the transition channel for the same reason `onClose` already is: pushing a sentinel through `subscribe` would make every subscriber type-check for something that is not a transition. Add `publishAppChanged(appId)`, and have the `/api/events` route emit an `app-changed` frame carrying `{ appId }` — filtered by `inScope`, exactly as the status frames are, so a scoped viewer does not learn an app exists.

Call `publishAppChanged` from `probes.ts` on **create**, on **delete**, and on a PATCH that changes `enabled`. Not on a label-only edit.

- [ ] **Step 3: Extend the client**

In `useEventStream`, listen for `app-changed` and invalidate `launcherKey` and `adminAppKey(appId)`. Invalidation rather than a patch is right here: the probe set changed, so the cached `ProbeSnapshot[]` is no longer a sound basis for a local roll-up — which is the whole reason the stale array was a bug.

Test that an `app-changed` frame invalidates, and that a malformed one does not tear the stream down.

- [ ] **Step 4: Write the failing ProbesPanel test**

Cover: lists each probe with kind, target and current status; the suggestions endpoint offers published ports; adding an HTTP probe posts the right body; an invalid URL is refused client-side; deleting asks for confirmation; toggling `enabled` persists; a second docker probe is refused with the server's `probe_exists` rendered as a sentence.

- [ ] **Step 5: Implement, run, verify**

- [ ] **Step 6: Binding checks**

- Remove the `publishAppChanged` call from PATCH → the disable test must fail.
- Announce on every PATCH → the label-only test must fail.
- Remove the `app-changed` listener from the client → its invalidation test must fail.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/events.ts src/server/routes/probes.ts src/web/live/useEventStream.ts src/web/routes/edit/ProbesPanel.tsx
git commit -m "Edit an app's probes, and let every open tab hear about it"
```

---

### Task 12: Image updates, and the admin route guard

**Files:**
- Create: `src/web/components/ImageUpdates.tsx`
- Modify: `src/web/routes/EditApp.tsx`, `src/web/routes/AdminApps.tsx`, `src/web/App.tsx`
- Test: `src/web/components/ImageUpdates.test.tsx`, `src/web/App.test.tsx`

**Interfaces:**
- Consumes: `useImages` (Task 2), `POST /api/apps/:id/images/check`.
- Produces: `<ImageUpdates appId={string} />`; a guard sending viewers away from every admin route.

- [ ] **Step 1: Write the failing ImageUpdates test**

Cover: one row per image with its current and available tag; the update count; **an image whose digests are unknown is not reported as having an update** — the 1B-ii carry-forward records that a badge which never clears teaches the user to ignore every badge; "Check now" posts and shows progress; a check failure is reported without clearing the last known state.

- [ ] **Step 2: Write the failing route-guard test**

`src/web/App.test.tsx` — first line `// @vitest-environment jsdom`:

```tsx
it("sends a viewer away from the inventory", async () => {
  // The whole viewer premise is a URL you can hand a housemate. Every admin route must
  // be unreachable by navigation, not merely absent from the nav bar.
  stubMe({ role: "viewer" });
  renderAt("/apps");
  await waitFor(() => expect(screen.queryByText(/Manage apps|Adopt from disk/)).toBeNull());
});

it("sends a viewer away from an edit page", async () => {
  stubMe({ role: "viewer" });
  renderAt("/apps/jellyfin/overview");
  await waitFor(() => expect(screen.queryByRole("link", { name: "Containers" })).toBeNull());
});

it("lets an admin reach both", async () => {
  stubMe({ role: "admin" });
  renderAt("/apps");
  await waitFor(() => expect(screen.getByRole("button", { name: /Create app/ })).toBeTruthy());
});
```

- [ ] **Step 3: Implement both, run, verify**

The guard already exists in shape for `/apps/*`; extend it to the new nested routes and prove it with the tests above. The client guard is convenience — the server enforces every capability — but a viewer who lands on an admin URL from a stale bookmark must get their launcher, not a broken page.

- [ ] **Step 4: Binding checks**

- Remove the viewer redirect → both viewer tests must fail.
- Report an unknown digest as an available update → its test must fail.

- [ ] **Step 5: Full gates**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run   # three times
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add src/web/components/ImageUpdates.tsx src/web/components/ImageUpdates.test.tsx src/web/App.tsx src/web/App.test.tsx src/web/routes/EditApp.tsx
git commit -m "Show which images have updates, and keep viewers out of the admin routes"
```

---

## Self-Review

**1. Spec coverage.** Every §8 requirement in this phase's scope maps to a task:

| Spec requirement | Task |
|---|---|
| Dense table on desktop, compact rows on mobile | 3 |
| Columns: name, status, image-update count, last deploy, row actions | 3, 12 |
| Exposure hostname column | **Omitted** — Phase 2 |
| Create app (new directory, scaffolded compose) | 1, 5 |
| Adopt from disk (multi-select scan) | 4 |
| Sticky status header | 6 |
| Tabs as routes | 6 |
| Bottom action bar mobile / right rail desktop | 6, 10 |
| Tabs are the data-loading boundary | 6, 8, 9 |
| `overview` tab | 7 |
| `containers` tab | 8 |
| `logs` tab | 9 |
| `compose`, `env` tabs | **Deferred to 1F** — Task 6 builds the shell so 1F adds two routes |
| `exposure` tab | **Deferred to Phase 2** |
| Manual icon search | 7 |
| Custom icon upload | **Deferred** — see below |
| Right rail carries actions, image updates, metadata | 6, 7, 10, 12 |

**Deliberately out of scope, recorded rather than dropped:**
- *Custom icon upload.* Search plus the letter tile covers the need; upload wants a storage location, a size and type policy, and a serving path, which is a task rather than a control. Carry forward.
- *Exposure hostname column and tab.* Phase 2.
- *Compose and env editors.* Phase 1F, which is why Task 6 makes tabs pluggable rather than hard-coding three.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Tasks 8 through 12 give representative test code and the reasoning for each assertion rather than every test body verbatim — deliberate, because those tasks are conventional React over interfaces Tasks 1–7 pin down, and the tests that matter are named individually with the defect each one guards.

**3. Type consistency.** `AdminApp` is used identically in Tasks 3, 6, 7 and 10. Cache keys are defined once in Task 2 and consumed by name everywhere. `useSseText` is defined in Task 9 and reused by Task 10. `publishAppChanged(appId)` is defined in Task 11 and used only there. `ScanResult`/`DiscoveredApp`/`OrphanStack` move to `src/shared/admin.ts` in Task 2 and are consumed by Task 4.

**4. Cross-task conflict scan.**

| Tasks | Shared surface | Finding |
|---|---|---|
| 3, 4, 5 | `AdminApps.tsx` | 3 creates it with dialog state and `null` placeholders; 4 and 5 fill them in. Sequential, declared in each. |
| 6, 7, 8, 9 | `App.tsx` routes | 6 adds all three child routes pointing at `Placeholder`; 7–9 replace them one at a time. Declared in 6. |
| 6, 7 | app resolution | 6 resolves slug→app once and passes it via `<Outlet context>`; 7–9 consume it rather than re-resolving. Stated in 7. |
| 9, 10 | `use-sse-text.ts` | 9 creates it, 10 consumes it. No overlap. |
| 11 | `events.ts`, `useEventStream.ts` | Both sides of one channel, in one task deliberately — splitting them would ship a publisher nothing listens to. |
| 2 | `src/shared/admin.ts` | New file; the server switches to importing its types so drift is a type error. Touches server files a later task does not. |
| 1, 11 | probe creation | 1 creates a docker probe on app create; 11 adds `publishAppChanged` on probe create. 1 lands first and inserts directly via `tx`, so it does not route through 11's publish path — correct, since nothing is subscribed at creation time. Noted so a reviewer does not read it as an inconsistency. |

**5. One risk worth naming.** Task 11 modifies `src/server/routes/events.ts`, which Phase 1C built and which carries measured invariants — the per-event `inScope` filter, the separate `onClose` channel, `closeForUser`, the five-stream cap and the 15-minute lifetime. The new channel must compose with all of them, and in particular the `app-changed` frame must be scope-filtered exactly as status frames are. An implementer should read the 1C and 1D carry-forwards on that file before touching it.
