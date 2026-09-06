# Homestacks Plan 2 — Projects & Docker Execution (server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-side API that discovers, adopts, edits, and runs Docker Compose projects that already exist on disk, with long-running lifecycle operations streamed to the client. Creating a project from blank/template/import is explicitly *not* in scope — see "Not in this plan".

**Architecture:** Everything talks to Docker through the `docker compose` CLI — the Engine API is not used in this plan (see Global Constraints). Project files on disk are the source of truth; SQLite stores only operation history. Compose's own `config --format json` output is the parsing substrate, so Homestacks never interprets compose syntax by hand. Long-running commands become tracked *operations* with an SSE output stream and a per-project mutex.

**Tech Stack:** TypeScript (ESM, strict), Fastify 5, Drizzle + `@libsql/client`, the `yaml` package's Document API, `node:child_process`, Vitest. No new runtime dependencies beyond `yaml`.

**Spec:** `docs/superpowers/specs/2026-09-05-homestacks-design.md` — §5 (project model), §7 (Docker execution), §17.1–§17.4 (verified behaviours this plan depends on).

**Predecessor:** Plan 1 (`docs/superpowers/plans/2026-09-05-foundation-and-access-control.md`), merged at `aee26d3`.

## Global Constraints

- Node current LTS, pnpm, ESM. TypeScript `strict: true`, `moduleResolution: "bundler"`, `target: "ES2022"`. **Installed TypeScript is 7.0.2** — `baseUrl` and other legacy options are removed. Do not modify `tsconfig.json`.
- **Run all four gates before every commit: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm e2e`.** Vitest transpiles through esbuild and never typechecks; a green suite does not prove your types are valid.
- A clean `tsc --noEmit` does **not** mean you avoided deprecated APIs — TypeScript reports those as editor hints only. Prefer current APIs.
- Newest stable major of every dependency. **No RCs or betas.**
- `better-auth` and `@better-auth/drizzle-adapter` are pinned to exactly `1.7.2`, and `src/server/db/auth-schema.ts` is hand-maintained. Do not bump either or regenerate that file.
- Biome is the only linter/formatter. Path alias `@shared/*` → `src/shared/*`.
- **Never add a `Co-Authored-By` trailer or any AI-attribution line to commit messages.**
- **Do not modify files outside your task's stated scope.** In Plan 1 a task silently edited another task's reviewed file and reintroduced a security hole. If you believe a file outside your scope must change, stop and report it.
- **The Docker Engine API is out of scope for this plan.** Container state comes from `docker compose ps --format json`. The event stream, resource stats, and image digests belong to Plan 4. Do not add `dockerode` or a unix-socket HTTP client.
- All mutating routes are guarded with `requirePermission(...)` from Plan 1. `compose:read` is an **admin** permission — the compose file and `.env` hold passwords.
- **In tests, sign in with server-side `auth.api.signInEmail(...)`, not HTTP.** Plan 1 rate-limits `/sign-in/email` to 5 per minute per file; the server-side call bypasses the limiter.
- `docker compose` invocations must never pass `-v` on `down`. Volume removal is always a separate, explicitly-requested action.

## Deferred from Plan 1 — do not fix here

Recorded so nobody re-discovers them: module-relative migration paths, tsup config / static SPA serving / build script, squashing migrations, an admin-recovery CLI, sign-out UI, a catch-all web route, error-body naming unification, Biome coverage of `e2e/`, Windows shell portability, and `HOMESTACKS_BASE_URL` documentation. All belong to Plan 5.

Two carry an **action for a later plan**, not this one: Plan 3 must trust `cf-connecting-ip` so rate limiting stops using one shared bucket; Plan 5 must add `it.skipIf(process.getuid?.() === 0)` to the two `chmod`-based preflight tests in the same task that introduces the Dockerfile.

**The `projects_path_parity` preflight check is deferred to Plan 5**, not forgotten. Verifying that `HOMESTACKS_PROJECTS_HOST` resolves to the same directory the daemon sees requires bind-mounting it into a throwaway container using the Homestacks image, which Plan 5 creates. Until then, translation correctness is covered by the pure unit tests in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/docker/preflight.ts` | Docker-reachable and Compose-v2 startup checks. |
| `src/server/docker/run.ts` | The single place that spawns `docker`. Buffered and streaming variants. |
| `src/server/docker/translate.ts` | Pure: canonical config → host-path override YAML. |
| `src/server/docker/compose.ts` | Compose verbs: `config`, `ps`, `up`, `down`, `restart`, `pull`, `logs`. |
| `src/server/projects/model.ts` | Pure: canonical JSON → `ProjectModel` (services, ports, labels, `x-homestacks`). |
| `src/server/projects/doc.ts` | Pure: comment-preserving YAML edits via `yaml`'s Document API. |
| `src/server/projects/store.ts` | Disk: scan, read, atomic write + snapshot, create, delete, rename. |
| `src/server/ops/registry.ts` | Operation lifecycle, SSE fan-out, per-project mutex, history persistence. |
| `src/server/routes/projects.ts` | Project CRUD + file read/write + validate. |
| `src/server/routes/operations.ts` | Lifecycle verbs, operation SSE, log SSE. |
| `src/shared/projects.ts` | Types shared with the web client in Plan 3. |
| `src/server/db/schema.ts` | *Modified:* add the `operations` table. |

---

### Task 1: Docker preflight checks

**Files:**
- Create: `src/server/docker/run.ts`, `src/server/docker/preflight.ts`
- Test: `src/server/docker/preflight.test.ts`
- Modify: `src/server/index.ts` (append checks to the existing `runChecks` call)

**Interfaces:**
- Consumes: `Check`, `runChecks` from `src/server/preflight.ts` (Plan 1).
- Produces:
  - `type Runner = (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }>`
  - `runDocker: Runner` — the real implementation, spawning `docker`.
  - `dockerChecks(run?: Runner): Check[]`

- [ ] **Step 1: Write the failing test**

`src/server/docker/preflight.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { Runner } from "./run.js";
import { dockerChecks } from "./preflight.js";
import { runChecks } from "../preflight.js";

const fake = (map: Record<string, { stdout?: string; code?: number; throws?: string }>): Runner =>
  async (args) => {
    const key = args.join(" ");
    const hit = map[key];
    if (!hit) throw new Error(`unexpected docker invocation: ${key}`);
    if (hit.throws) throw new Error(hit.throws);
    return { stdout: hit.stdout ?? "", stderr: "", code: hit.code ?? 0 };
  };

const VERSION = "version --format {{.Server.Version}}";
const COMPOSE = "compose version --short";

describe("dockerChecks", () => {
  it("passes when the daemon answers and Compose is v2", async () => {
    const results = await runChecks(
      dockerChecks(fake({ [VERSION]: { stdout: "29.7.2\n" }, [COMPOSE]: { stdout: "2.31.0\n" } })),
    );
    expect(results.find((r) => r.id === "docker_reachable")?.ok).toBe(true);
    expect(results.find((r) => r.id === "compose_v2")?.ok).toBe(true);
  });

  it("reports the daemon as a blocking failure when it cannot be reached", async () => {
    const results = await runChecks(
      dockerChecks(fake({
        [VERSION]: { throws: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" },
        [COMPOSE]: { stdout: "2.31.0\n" },
      })),
    );
    const check = results.find((r) => r.id === "docker_reachable");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("docker.sock");
  });

  it("rejects Compose v1", async () => {
    const results = await runChecks(
      dockerChecks(fake({ [VERSION]: { stdout: "29.7.2\n" }, [COMPOSE]: { stdout: "1.29.2\n" } })),
    );
    const check = results.find((r) => r.id === "compose_v2");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("1.29.2");
  });

  it("rejects a Compose version it cannot parse rather than assuming v2", async () => {
    const results = await runChecks(
      dockerChecks(fake({ [VERSION]: { stdout: "29.7.2\n" }, [COMPOSE]: { stdout: "wat\n" } })),
    );
    expect(results.find((r) => r.id === "compose_v2")?.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/docker/preflight.test.ts`
Expected: FAIL — cannot resolve `./preflight.js`.

- [ ] **Step 3: Write the runner**

`src/server/docker/run.ts`:

```typescript
import { execFile } from "node:child_process";

export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (args: string[], opts?: { cwd?: string }) => Promise<RunResult>;

/** Spawns `docker` directly — never through a shell, so no argument is ever interpreted. */
export const runDocker: Runner = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile("docker", args, { cwd: opts?.cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof (err as { code?: unknown }).code !== "number") return reject(err);
      resolve({ stdout, stderr, code: err ? ((err as { code: number }).code ?? 1) : 0 });
    });
  });
```

- [ ] **Step 4: Write the checks**

`src/server/docker/preflight.ts`:

```typescript
import type { Check } from "../preflight.js";
import { type Runner, runDocker } from "./run.js";

export function dockerChecks(run: Runner = runDocker): Check[] {
  return [
    {
      id: "docker_reachable",
      label: "Docker daemon is reachable",
      blocking: true,
      run: async () => {
        const { stdout, stderr, code } = await run(["version", "--format", "{{.Server.Version}}"]);
        if (code !== 0) return { ok: false, detail: stderr.trim() || `docker exited ${code}` };
        return { ok: true, detail: `Engine ${stdout.trim()}` };
      },
    },
    {
      id: "compose_v2",
      label: "Docker Compose v2 is available",
      blocking: true,
      run: async () => {
        const { stdout, stderr, code } = await run(["compose", "version", "--short"]);
        if (code !== 0) return { ok: false, detail: stderr.trim() || "docker compose not available" };
        const version = stdout.trim();
        const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
        if (!Number.isFinite(major) || major < 2) {
          return { ok: false, detail: `found "${version}", Homestacks requires Compose v2 or newer` };
        }
        return { ok: true, detail: `Compose ${version}` };
      },
    },
  ];
}
```

Note the `throws` path in the test: `runChecks` (Plan 1) catches a thrown error per check and turns it into `ok: false` with the message as `detail`, which is why the daemon-unreachable case works without explicit handling here.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/server/docker/preflight.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Register the checks at startup**

In `src/server/index.ts`, extend the existing checks array:

```typescript
import { dockerChecks } from "./docker/preflight.js";
// ...
const results = await runChecks([...dataDirChecks(config), ...dockerChecks()]);
```

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/server/docker src/server/index.ts
git commit -m "feat: add Docker and Compose preflight checks"
```

---

### Task 2: Parse canonical compose config

**Files:**
- Create: `src/shared/projects.ts`, `src/server/projects/model.ts`
- Test: `src/server/projects/model.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/shared/projects.ts`:
  - `type PublishedPort = { hostIp: string; hostPort: number; containerPort: number; protocol: string; loopbackOnly: boolean }`
  - `type AppMeta = { name: string; icon?: string; port?: number; path?: string; enabled: boolean }`
  - `type ServiceModel = { name: string; image?: string; ports: PublishedPort[]; labels: Record<string, string>; app: AppMeta | null }`
  - `type ProjectMeta = { schemaVersion: number; displayName?: string; description?: string; icon?: string; system: boolean }`
  - `type ProjectModel = { projectName: string; services: ServiceModel[]; meta: ProjectMeta }`
- From `src/server/projects/model.ts`: `parseCanonical(json: unknown): ProjectModel`

**Why this is pure:** `docker compose config --format json` normalises every legal port and volume syntax to long form and resolves `.env` interpolation (spec §17.2). Parsing its output means Homestacks never reimplements the Compose spec.

- [ ] **Step 1: Write the failing test**

`src/server/projects/model.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseCanonical } from "./model.js";

// Shape produced by `docker compose config --format json` on Compose v2.
const CANONICAL = {
  name: "media",
  services: {
    jellyfin: {
      image: "jellyfin/jellyfin",
      labels: {
        "homestacks.app.name": "Jellyfin",
        "homestacks.app.icon": "jellyfin",
        "homestacks.app.port": "8096",
        "homestacks.app.path": "/web",
      },
      ports: [
        { mode: "ingress", target: 8096, published: "8096", protocol: "tcp", host_ip: "127.0.0.1" },
        { mode: "ingress", target: 8920, published: "8920", protocol: "tcp" },
      ],
    },
    db: {
      image: "postgres:17",
      labels: { "homestacks.app.enabled": "false" },
      ports: [],
    },
    worker: { image: "busybox" },
  },
  "x-homestacks": { schemaVersion: 1, displayName: "Media Stack", icon: "jellyfin" },
};

describe("parseCanonical", () => {
  it("reads the compose project name rather than deriving one", () => {
    expect(parseCanonical(CANONICAL).projectName).toBe("media");
  });

  it("normalises published ports and coerces the string port to a number", () => {
    const svc = parseCanonical(CANONICAL).services.find((s) => s.name === "jellyfin");
    expect(svc?.ports[0]).toEqual({
      hostIp: "127.0.0.1", hostPort: 8096, containerPort: 8096, protocol: "tcp", loopbackOnly: true,
    });
  });

  it("defaults a missing host_ip to 0.0.0.0 and marks it LAN-reachable", () => {
    const svc = parseCanonical(CANONICAL).services.find((s) => s.name === "jellyfin");
    expect(svc?.ports[1]).toEqual({
      hostIp: "0.0.0.0", hostPort: 8920, containerPort: 8920, protocol: "tcp", loopbackOnly: false,
    });
  });

  it("infers an app for a service with a published port", () => {
    const svc = parseCanonical(CANONICAL).services.find((s) => s.name === "jellyfin");
    expect(svc?.app).toEqual({ name: "Jellyfin", icon: "jellyfin", port: 8096, path: "/web", enabled: true });
  });

  it("suppresses the app when the label says so, even with labels present", () => {
    expect(parseCanonical(CANONICAL).services.find((s) => s.name === "db")?.app).toBeNull();
  });

  it("infers no app for a service with no published ports", () => {
    expect(parseCanonical(CANONICAL).services.find((s) => s.name === "worker")?.app).toBeNull();
  });

  it("falls back to the service name when no app name label is set", () => {
    const json = { name: "p", services: { grafana: { ports: [{ target: 3000, published: "3000", protocol: "tcp" }] } } };
    expect(parseCanonical(json).services[0]?.app?.name).toBe("grafana");
  });

  it("reads x-homestacks project metadata", () => {
    expect(parseCanonical(CANONICAL).meta).toEqual({
      schemaVersion: 1, displayName: "Media Stack", icon: "jellyfin", system: false,
    });
  });

  it("supplies defaults when x-homestacks is absent", () => {
    const meta = parseCanonical({ name: "p", services: {} }).meta;
    expect(meta).toEqual({ schemaVersion: 1, system: false });
  });

  it("throws on input that is not a compose config", () => {
    expect(() => parseCanonical({ services: {} })).toThrow(/name/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/projects/model.test.ts`
Expected: FAIL — cannot resolve `./model.js`.

- [ ] **Step 3: Write the shared types**

`src/shared/projects.ts`:

```typescript
export type PublishedPort = {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
  /** True when bound to loopback only — reachable by the tunnel but not the LAN (spec §7.4). */
  loopbackOnly: boolean;
};

export type AppMeta = {
  name: string;
  icon?: string;
  port?: number;
  path?: string;
  enabled: boolean;
};

export type ServiceModel = {
  name: string;
  image?: string;
  ports: PublishedPort[];
  labels: Record<string, string>;
  app: AppMeta | null;
};

export type ProjectMeta = {
  schemaVersion: number;
  displayName?: string;
  description?: string;
  icon?: string;
  system: boolean;
};

export type ProjectModel = {
  projectName: string;
  services: ServiceModel[];
  meta: ProjectMeta;
};
```

- [ ] **Step 4: Write the parser**

`src/server/projects/model.ts`:

```typescript
import type { AppMeta, ProjectMeta, ProjectModel, PublishedPort, ServiceModel } from "@shared/projects.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parsePorts(raw: unknown): PublishedPort[] {
  if (!Array.isArray(raw)) return [];
  const ports: PublishedPort[] = [];
  for (const entry of raw) {
    const p = asRecord(entry);
    const hostPort = Number.parseInt(String(p.published ?? ""), 10);
    const containerPort = Number(p.target);
    if (!Number.isFinite(hostPort) || !Number.isFinite(containerPort)) continue;
    const hostIp = typeof p.host_ip === "string" && p.host_ip !== "" ? p.host_ip : "0.0.0.0";
    ports.push({
      hostIp,
      hostPort,
      containerPort,
      protocol: typeof p.protocol === "string" ? p.protocol : "tcp",
      loopbackOnly: LOOPBACK.has(hostIp),
    });
  }
  return ports;
}

function parseApp(name: string, labels: Record<string, string>, ports: PublishedPort[]): AppMeta | null {
  if (labels["homestacks.app.enabled"] === "false") return null;
  if (ports.length === 0) return null;
  const labelled = Number.parseInt(labels["homestacks.app.port"] ?? "", 10);
  const port = Number.isFinite(labelled)
    ? labelled
    : ports.reduce((lowest, p) => (p.containerPort < lowest ? p.containerPort : lowest), ports[0]!.containerPort);
  const app: AppMeta = { name: labels["homestacks.app.name"] ?? name, port, enabled: true };
  if (labels["homestacks.app.icon"]) app.icon = labels["homestacks.app.icon"];
  if (labels["homestacks.app.path"]) app.path = labels["homestacks.app.path"];
  return app;
}

function parseMeta(raw: unknown): ProjectMeta {
  const x = asRecord(raw);
  const meta: ProjectMeta = {
    schemaVersion: typeof x.schemaVersion === "number" ? x.schemaVersion : 1,
    system: x.system === true,
  };
  if (typeof x.displayName === "string") meta.displayName = x.displayName;
  if (typeof x.description === "string") meta.description = x.description;
  if (typeof x.icon === "string") meta.icon = x.icon;
  return meta;
}

export function parseCanonical(json: unknown): ProjectModel {
  const root = asRecord(json);
  if (typeof root.name !== "string" || root.name === "") {
    throw new Error("canonical compose config has no project name");
  }
  const services: ServiceModel[] = Object.entries(asRecord(root.services)).map(([name, value]) => {
    const svc = asRecord(value);
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(asRecord(svc.labels))) labels[k] = String(v);
    const ports = parsePorts(svc.ports);
    const model: ServiceModel = { name, ports, labels, app: parseApp(name, labels, ports) };
    if (typeof svc.image === "string") model.image = svc.image;
    return model;
  });
  return { projectName: root.name, services, meta: parseMeta(root["x-homestacks"]) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/server/projects/model.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint
git add src/shared/projects.ts src/server/projects
git commit -m "feat: parse canonical compose config into a project model"
```

---

### Task 3: Comment-preserving compose edits

**Files:**
- Create: `src/server/projects/doc.ts`
- Test: `src/server/projects/doc.test.ts`

**Interfaces:**
- Consumes: `ProjectMeta` from `@shared/projects.js`.
- Produces:
  - `parseComposeDoc(text: string): ComposeDoc` (an opaque wrapper around `yaml`'s `Document`)
  - `setProjectMeta(doc: ComposeDoc, patch: Partial<ProjectMeta>): void`
  - `setServiceLabel(doc: ComposeDoc, service: string, key: string, value: string | null): void`
  - `setProjectName(doc: ComposeDoc, name: string): void`
  - `composeDocToText(doc: ComposeDoc): string`

**Why the Document API:** the user hand-edits these files, and Homestacks writes them too. Round-tripping through `JSON.parse`/`stringify` would silently delete every comment. `yaml`'s `parseDocument` preserves them.

- [ ] **Step 1: Install the dependency**

```bash
pnpm add yaml
```

- [ ] **Step 2: Write the failing test**

`src/server/projects/doc.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { composeDocToText, parseComposeDoc, setProjectMeta, setProjectName, setServiceLabel } from "./doc.js";

const SRC = `# Managed by hand — do not clobber this comment
name: media

services:
  jellyfin:
    image: jellyfin/jellyfin # pinned deliberately
    ports:
      - "127.0.0.1:8096:8096"
`;

describe("compose document editing", () => {
  it("preserves comments through a round trip with no edits", () => {
    expect(composeDocToText(parseComposeDoc(SRC))).toBe(SRC);
  });

  it("preserves comments when metadata is added", () => {
    const doc = parseComposeDoc(SRC);
    setProjectMeta(doc, { displayName: "Media Stack" });
    const out = composeDocToText(doc);
    expect(out).toContain("# Managed by hand — do not clobber this comment");
    expect(out).toContain("# pinned deliberately");
    expect(out).toContain("displayName: Media Stack");
  });

  it("creates x-homestacks when absent and updates it when present", () => {
    const doc = parseComposeDoc(SRC);
    setProjectMeta(doc, { displayName: "First" });
    setProjectMeta(doc, { displayName: "Second", icon: "jellyfin" });
    const out = composeDocToText(doc);
    expect(out).toContain("displayName: Second");
    expect(out).toContain("icon: jellyfin");
    expect(out.match(/x-homestacks:/g)).toHaveLength(1);
  });

  it("adds a label to a service that has none", () => {
    const doc = parseComposeDoc(SRC);
    setServiceLabel(doc, "jellyfin", "homestacks.app.name", "Jellyfin");
    expect(composeDocToText(doc)).toContain("homestacks.app.name: Jellyfin");
  });

  it("removes a label when the value is null", () => {
    const doc = parseComposeDoc(SRC);
    setServiceLabel(doc, "jellyfin", "homestacks.app.icon", "jellyfin");
    setServiceLabel(doc, "jellyfin", "homestacks.app.icon", null);
    expect(composeDocToText(doc)).not.toContain("homestacks.app.icon");
  });

  it("throws when the service does not exist rather than creating one", () => {
    const doc = parseComposeDoc(SRC);
    expect(() => setServiceLabel(doc, "nope", "k", "v")).toThrow(/nope/);
  });

  it("sets the project name", () => {
    const doc = parseComposeDoc(SRC);
    setProjectName(doc, "media-v2");
    expect(composeDocToText(doc)).toContain("name: media-v2");
  });

  it("rejects malformed YAML with a useful message", () => {
    expect(() => parseComposeDoc("services:\n  - [unclosed\n")).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/server/projects/doc.test.ts`
Expected: FAIL — cannot resolve `./doc.js`.

- [ ] **Step 4: Write the implementation**

`src/server/projects/doc.ts`:

```typescript
import { type Document, isMap, parseDocument } from "yaml";
import type { ProjectMeta } from "@shared/projects.js";

export type ComposeDoc = Document.Parsed;

export function parseComposeDoc(text: string): ComposeDoc {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`invalid YAML: ${doc.errors.map((e) => e.message).join("; ")}`);
  }
  return doc;
}

export function composeDocToText(doc: ComposeDoc): string {
  return doc.toString();
}

export function setProjectName(doc: ComposeDoc, name: string): void {
  doc.set("name", name);
}

export function setProjectMeta(doc: ComposeDoc, patch: Partial<ProjectMeta>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    doc.setIn(["x-homestacks", key], value);
  }
}

export function setServiceLabel(
  doc: ComposeDoc,
  service: string,
  key: string,
  value: string | null,
): void {
  const services = doc.get("services");
  if (!isMap(services) || !services.has(service)) {
    throw new Error(`service "${service}" not found in compose file`);
  }
  if (value === null) {
    doc.deleteIn(["services", service, "labels", key]);
    return;
  }
  doc.setIn(["services", service, "labels", key], value);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/server/projects/doc.test.ts`
Expected: PASS (8 tests)

If the no-edit round-trip test fails on trailing whitespace or quote style, do **not** loosen the assertion — that test is the guarantee that hand-written files survive. Investigate `parseDocument` options instead, and report what you found.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint
git add src/server/projects/doc.ts src/server/projects/doc.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add comment-preserving compose document editing"
```

---

### Task 4: Project directory scan and read

**Files:**
- Create: `src/server/projects/store.ts`
- Test: `src/server/projects/store.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/server/config.ts`.
- Produces:
  - `type ScanEntry = { slug: string; path: string; hasCompose: boolean; hasEnv: boolean; composeFile: string | null }`
  - `scanProjects(projectsDir: string): Promise<ScanEntry[]>`
  - `readProjectFile(projectsDir: string, slug: string, file: "compose" | "env"): Promise<string | null>`
  - `isValidSlug(slug: string): boolean`
  - `projectPath(projectsDir: string, slug: string): string` — throws on a slug that escapes the root.
  - `findComposeFile(dir: string): Promise<string | null>` — **must be exported**, because Tasks 5 and 7 both need it. Exporting it here rather than having a later task reach back and change this file is deliberate: in Plan 1 a task quietly edited an earlier task's reviewed file and reintroduced a security hole.

**Two rules the spec pins down (§5.3):** the scan **ignores directories whose name begins with `.`**, because a common deployment puts `$HOMESTACKS_DATA` inside the projects root. And directories with no compose file are **listed as "not a project"** rather than hidden, so nothing silently disappears.

Compose accepts several filenames. Recognise `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`, in Compose's own precedence order.

- [ ] **Step 1: Write the failing test**

`src/server/projects/store.test.ts`:

```typescript
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isValidSlug, projectPath, readProjectFile, scanProjects } from "./store.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-store-"));
  await mkdir(join(root, "jellyfin"), { recursive: true });
  await writeFile(join(root, "jellyfin", "docker-compose.yml"), "services: {}\n");
  await writeFile(join(root, "jellyfin", ".env"), "TZ=UTC\n");
  await mkdir(join(root, "paperless"), { recursive: true });
  await writeFile(join(root, "paperless", "compose.yaml"), "services: {}\n");
  await mkdir(join(root, "notes"), { recursive: true });          // no compose file
  await mkdir(join(root, ".homestacks"), { recursive: true });     // data dir living inside
  await writeFile(join(root, ".homestacks", "compose.yaml"), "services: {}\n");
  await writeFile(join(root, "loose-file.txt"), "x");
});

describe("scanProjects", () => {
  it("finds projects and reports which files they have", async () => {
    const entries = await scanProjects(root);
    const jellyfin = entries.find((e) => e.slug === "jellyfin");
    expect(jellyfin).toMatchObject({ hasCompose: true, hasEnv: true, composeFile: "docker-compose.yml" });
  });

  it("recognises the compose.yaml filename too", async () => {
    const entries = await scanProjects(root);
    expect(entries.find((e) => e.slug === "paperless")?.composeFile).toBe("compose.yaml");
  });

  it("lists a directory with no compose file rather than hiding it", async () => {
    const entries = await scanProjects(root);
    expect(entries.find((e) => e.slug === "notes")).toMatchObject({ hasCompose: false, composeFile: null });
  });

  it("ignores dot-directories so a nested data dir is not adopted", async () => {
    const entries = await scanProjects(root);
    expect(entries.map((e) => e.slug)).not.toContain(".homestacks");
  });

  it("ignores plain files at the root", async () => {
    const entries = await scanProjects(root);
    expect(entries.map((e) => e.slug)).not.toContain("loose-file.txt");
  });

  it("returns entries sorted by slug", async () => {
    const slugs = (await scanProjects(root)).map((e) => e.slug);
    expect(slugs).toEqual([...slugs].sort());
  });

  it("returns an empty list when the root does not exist", async () => {
    expect(await scanProjects(join(root, "nope"))).toEqual([]);
  });
});

describe("readProjectFile", () => {
  it("reads the compose file", async () => {
    expect(await readProjectFile(root, "jellyfin", "compose")).toBe("services: {}\n");
  });

  it("returns null for a missing .env rather than throwing", async () => {
    expect(await readProjectFile(root, "paperless", "env")).toBeNull();
  });
});

describe("slug safety", () => {
  it("accepts ordinary slugs", () => {
    expect(isValidSlug("jellyfin")).toBe(true);
    expect(isValidSlug("media-stack_2")).toBe(true);
  });

  it("rejects traversal and separators", () => {
    for (const bad of ["..", "a/b", "/abs", ".hidden", "", "a b", "a\\b"]) {
      expect(isValidSlug(bad)).toBe(false);
    }
  });

  it("projectPath throws rather than escaping the root", () => {
    expect(() => projectPath(root, "../etc")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/projects/store.test.ts`
Expected: FAIL — cannot resolve `./store.js`.

- [ ] **Step 3: Write the implementation**

`src/server/projects/store.ts`:

```typescript
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Compose's own precedence order. */
const COMPOSE_FILENAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export type ScanEntry = {
  slug: string;
  path: string;
  hasCompose: boolean;
  hasEnv: boolean;
  composeFile: string | null;
};

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(slug) && !slug.startsWith(".") && !slug.includes("..");
}

export function projectPath(projectsDir: string, slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid project slug: ${JSON.stringify(slug)}`);
  const path = resolve(projectsDir, slug);
  if (path !== join(projectsDir, slug)) throw new Error(`slug escapes the projects root: ${slug}`);
  return path;
}

export async function findComposeFile(dir: string): Promise<string | null> {
  for (const name of COMPOSE_FILENAMES) {
    try {
      await stat(join(dir, name));
      return name;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export async function scanProjects(projectsDir: string): Promise<ScanEntry[]> {
  let dirents: Awaited<ReturnType<typeof readdir>>;
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: ScanEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (dirent.name.startsWith(".")) continue;
    const path = join(projectsDir, dirent.name);
    const composeFile = await findComposeFile(path);
    const hasEnv = await stat(join(path, ".env")).then(() => true, () => false);
    entries.push({ slug: dirent.name, path, hasCompose: composeFile !== null, hasEnv, composeFile });
  }
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readProjectFile(
  projectsDir: string,
  slug: string,
  file: "compose" | "env",
): Promise<string | null> {
  const dir = projectPath(projectsDir, slug);
  const name = file === "env" ? ".env" : await findComposeFile(dir);
  if (name === null) return null;
  return readFile(join(dir, name), "utf8").catch(() => null);
}
```

Note `readdir` is typed via `Awaited<ReturnType<...>>` rather than importing `Dirent`, to avoid a type-only import that TypeScript 7 may resolve differently; if importing `Dirent` from `node:fs` typechecks cleanly, prefer that and say so in your report.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/projects/store.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint
git add src/server/projects/store.ts src/server/projects/store.test.ts
git commit -m "feat: scan and read projects from disk"
```

---

### Task 5: Atomic writes with snapshots

**Files:**
- Modify: `src/server/projects/store.ts`
- Test: `src/server/projects/store.test.ts` (add a describe block)

**Interfaces:**
- Consumes: Task 4's `projectPath`.
- Produces:
  - `writeProjectFile(projectsDir, slug, file: "compose" | "env", content: string): Promise<void>`
  - `listSnapshots(projectsDir, slug): Promise<string[]>` — newest first.
  - `SNAPSHOT_RETENTION = 10`

**Why atomic:** a browser-based editor writing a compose file that a `docker compose up` may read concurrently must never expose a half-written file. Write to a temp file in the same directory, `fsync`, then `rename` — rename is atomic within a filesystem.

**Why snapshots:** the spec requires the previous content be preserved before every write (§5.2). A wrong edit to a stack holding family photos needs an undo.

- [ ] **Step 1: Write the failing test**

Append to `src/server/projects/store.test.ts`:

```typescript
import { readFile as read } from "node:fs/promises";
import { listSnapshots, SNAPSHOT_RETENTION, writeProjectFile } from "./store.js";

describe("writeProjectFile", () => {
  it("writes the new content", async () => {
    await writeProjectFile(root, "jellyfin", "compose", "services:\n  web: {}\n");
    expect(await read(join(root, "jellyfin", "docker-compose.yml"), "utf8")).toBe("services:\n  web: {}\n");
  });

  it("snapshots the previous content before overwriting", async () => {
    await writeProjectFile(root, "jellyfin", "compose", "v2\n");
    const snaps = await listSnapshots(root, "jellyfin");
    expect(snaps).toHaveLength(1);
    expect(await read(join(root, "jellyfin", ".snapshots", snaps[0]!), "utf8")).toBe("services: {}\n");
  });

  it("does not snapshot when there was no previous file", async () => {
    await writeProjectFile(root, "paperless", "env", "TZ=UTC\n");
    expect(await listSnapshots(root, "paperless")).toHaveLength(0);
  });

  it("writes into the existing compose filename rather than creating a second one", async () => {
    await writeProjectFile(root, "paperless", "compose", "services:\n  a: {}\n");
    const entries = await scanProjects(root);
    expect(entries.find((e) => e.slug === "paperless")?.composeFile).toBe("compose.yaml");
  });

  it("prunes snapshots beyond the retention limit, keeping the newest", async () => {
    for (let i = 0; i < SNAPSHOT_RETENTION + 5; i++) {
      await writeProjectFile(root, "jellyfin", "compose", `rev-${i}\n`);
    }
    const snaps = await listSnapshots(root, "jellyfin");
    expect(snaps).toHaveLength(SNAPSHOT_RETENTION);
    const newest = await read(join(root, "jellyfin", ".snapshots", snaps[0]!), "utf8");
    expect(newest).toBe(`rev-${SNAPSHOT_RETENTION + 3}\n`);
  });

  it("leaves no temp files behind", async () => {
    await writeProjectFile(root, "jellyfin", "compose", "x\n");
    const names = await readdir(join(root, "jellyfin"));
    expect(names.filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});
```

Add `readdir` to the `node:fs/promises` import at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/projects/store.test.ts`
Expected: FAIL — `writeProjectFile` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/server/projects/store.ts`. Task 4 already imports `readFile`, `readdir` and `stat` from `node:fs/promises` — **extend that existing import statement** rather than adding a second one with an alias:

```typescript
// existing import becomes:
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";

export const SNAPSHOT_RETENTION = 10;

/** Sortable, filesystem-safe, and monotonic within a process. */
let snapshotCounter = 0;
function snapshotName(base: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = String(snapshotCounter++).padStart(4, "0");
  return `${stamp}-${seq}-${base}`;
}

export async function listSnapshots(projectsDir: string, slug: string): Promise<string[]> {
  const dir = join(projectPath(projectsDir, slug), ".snapshots");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.sort().reverse();
}

export async function writeProjectFile(
  projectsDir: string,
  slug: string,
  file: "compose" | "env",
  content: string,
): Promise<void> {
  const dir = projectPath(projectsDir, slug);
  const name = file === "env" ? ".env" : ((await findComposeFile(dir)) ?? "docker-compose.yml");
  const target = join(dir, name);

  const existed = await stat(target).then(() => true, () => false);
  if (existed) {
    const snapDir = join(dir, ".snapshots");
    await mkdir(snapDir, { recursive: true });
    await copyFile(target, join(snapDir, snapshotName(name)));
    const snaps = await listSnapshots(projectsDir, slug);
    for (const stale of snaps.slice(SNAPSHOT_RETENTION)) {
      await rm(join(snapDir, stale), { force: true });
    }
  }

  const tmp = `${target}.tmp-${process.pid}-${snapshotCounter++}`;
  try {
    await writeFile(tmp, content, "utf8");
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/projects/store.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint
git add src/server/projects/store.ts src/server/projects/store.test.ts
git commit -m "feat: write project files atomically with snapshots"
```

---

### Task 6: Host-path translation

**Files:**
- Create: `src/server/docker/translate.ts`
- Test: `src/server/docker/translate.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `buildOverride(canonical: unknown, opts: { projectsDir: string; projectsHostDir: string; slug: string }): string | null`

**Read spec §7.2 and §17.3–§17.4 before writing this.** The short version: a bind-mount source is a string that crosses from Homestacks' filesystem namespace into the Docker daemon's, untranslated. When Homestacks runs in a container whose projects mount is at a different path than the host's, the daemon resolves the path in *host* space and mounts the wrong directory — or silently creates an empty root-owned one. There is no error.

`docker compose config` has already absolutised relative binds to `${projectsDir}/${slug}/...`, so translation is a **prefix swap** on exactly those sources. Everything else passes through: absolute binds outside the projects root are already host paths, named volumes involve no host path, and build contexts / `env_file` / `secrets: file:` are read client-side and streamed as content.

**Do not use `--project-directory` for this.** It redirects bind resolution but also relocates client-side reads: `.env` silently stops loading, so every variable interpolates to an empty string (§17.4). The override file moves only the value that crosses the boundary.

- [ ] **Step 1: Write the failing test**

`src/server/docker/translate.test.ts`:

```typescript
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { buildOverride } from "./translate.js";

const OPTS = { projectsDir: "/data/stacks", projectsHostDir: "/volume2/docker", slug: "media" };

const canonical = (volumes: unknown) => ({
  name: "media",
  services: { web: { image: "nginx", volumes } },
});

describe("buildOverride", () => {
  it("returns null when the two roots are identical", () => {
    expect(buildOverride(canonical([]), { ...OPTS, projectsHostDir: OPTS.projectsDir })).toBeNull();
  });

  it("rewrites a bind whose source is inside the project directory", () => {
    const out = buildOverride(
      canonical([{ type: "bind", source: "/data/stacks/media/config", target: "/config" }]),
      OPTS,
    );
    expect(parse(out!)).toEqual({
      services: { web: { volumes: [{ type: "bind", source: "/volume2/docker/media/config", target: "/config" }] } },
    });
  });

  it("preserves read_only and bind options on a rewritten mount", () => {
    const out = buildOverride(
      canonical([{ type: "bind", source: "/data/stacks/media/config", target: "/config", read_only: true }]),
      OPTS,
    );
    expect(parse(out!).services.web.volumes[0].read_only).toBe(true);
  });

  it("leaves an absolute bind outside the projects root untouched", () => {
    const out = buildOverride(
      canonical([{ type: "bind", source: "/mnt/media", target: "/media" }]),
      OPTS,
    );
    expect(out).toBeNull();
  });

  it("leaves named volumes untouched", () => {
    const out = buildOverride(
      canonical([{ type: "volume", source: "appdata", target: "/data" }]),
      OPTS,
    );
    expect(out).toBeNull();
  });

  it("rewrites only the qualifying mounts in a mixed service", () => {
    const out = buildOverride(
      canonical([
        { type: "volume", source: "appdata", target: "/data" },
        { type: "bind", source: "/data/stacks/media/config", target: "/config" },
        { type: "bind", source: "/mnt/media", target: "/media" },
      ]),
      OPTS,
    );
    const volumes = parse(out!).services.web.volumes;
    expect(volumes).toHaveLength(1);
    expect(volumes[0].source).toBe("/volume2/docker/media/config");
  });

  it("omits services that need no rewriting", () => {
    const json = {
      name: "media",
      services: {
        web: { volumes: [{ type: "bind", source: "/data/stacks/media/w", target: "/w" }] },
        db: { volumes: [{ type: "volume", source: "pg", target: "/var/lib/postgresql/data" }] },
      },
    };
    expect(Object.keys(parse(buildOverride(json, OPTS)!).services)).toEqual(["web"]);
  });

  it("does not rewrite a sibling directory that merely shares a prefix", () => {
    const out = buildOverride(
      canonical([{ type: "bind", source: "/data/stacks/media-archive/x", target: "/x" }]),
      OPTS,
    );
    expect(out).toBeNull();
  });

  it("rewrites the project directory itself, not only paths beneath it", () => {
    const out = buildOverride(
      canonical([{ type: "bind", source: "/data/stacks/media", target: "/srv" }]),
      OPTS,
    );
    expect(parse(out!).services.web.volumes[0].source).toBe("/volume2/docker/media");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/docker/translate.test.ts`
Expected: FAIL — cannot resolve `./translate.js`.

- [ ] **Step 3: Write the implementation**

`src/server/docker/translate.ts`:

```typescript
import { stringify } from "yaml";

type Mount = Record<string, unknown> & { type?: unknown; source?: unknown };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function buildOverride(
  canonical: unknown,
  opts: { projectsDir: string; projectsHostDir: string; slug: string },
): string | null {
  if (opts.projectsDir === opts.projectsHostDir) return null;

  const from = `${opts.projectsDir}/${opts.slug}`;
  const to = `${opts.projectsHostDir}/${opts.slug}`;
  const services: Record<string, { volumes: Mount[] }> = {};

  for (const [name, raw] of Object.entries(asRecord(asRecord(canonical).services))) {
    const volumes = asRecord(raw).volumes;
    if (!Array.isArray(volumes)) continue;

    const rewritten: Mount[] = [];
    for (const entry of volumes) {
      const mount = asRecord(entry) as Mount;
      if (mount.type !== "bind" || typeof mount.source !== "string") continue;
      // Exact match, or a path genuinely beneath the project directory. The
      // trailing-slash test stops `/data/stacks/media-archive` matching `media`.
      const isProjectDir = mount.source === from;
      const isBeneath = mount.source.startsWith(`${from}/`);
      if (!isProjectDir && !isBeneath) continue;
      rewritten.push({ ...mount, source: to + mount.source.slice(from.length) });
    }

    if (rewritten.length > 0) services[name] = { volumes: rewritten };
  }

  if (Object.keys(services).length === 0) return null;
  return stringify({ services });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/docker/translate.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint
git add src/server/docker/translate.ts src/server/docker/translate.test.ts
git commit -m "feat: translate bind mount sources to host paths"
```

---

### Task 7: Compose command wrapper

**Files:**
- Create: `src/server/docker/compose.ts`
- Test: `src/server/docker/compose.test.ts`, `src/server/docker/compose.integration.test.ts`

**Interfaces:**
- Consumes: `Runner`/`runDocker` (Task 1), `buildOverride` (Task 6), `projectPath`/`findComposeFile` (Task 4).
- Produces:
  - `type ComposeContext = { projectsDir: string; projectsHostDir: string; dataDir: string; slug: string }`
  - `composeArgs(ctx: ComposeContext, composeFile: string, overridePath: string | null, verb: string[]): string[]` — pure. It takes the already-resolved compose filename so that the function the tests exercise is the same one production calls; a separately-tested variant that nothing uses proves nothing.
  - `composeConfig(ctx, run?): Promise<unknown>` — canonical JSON.
  - `composePs(ctx, run?): Promise<ContainerState[]>` where `ContainerState = { service: string; name: string; state: string; health: string | null; exitCode: number }`
  - `composeExec(ctx, verb: string[], onOutput: (chunk: string) => void, run?): Promise<number>` — streams merged stdout/stderr, resolves with the exit code.

**Two rules encoded here.** `down` must never receive `-v`; volume removal is a separate explicit action (spec §5.5). And the override file is regenerated before every invocation, because the compose file may have changed since the last one.

- [ ] **Step 1: Write the failing unit test**

`src/server/docker/compose.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { composeArgs } from "./compose.js";

const CTX = {
  projectsDir: "/data/stacks",
  projectsHostDir: "/data/stacks",
  dataDir: "/var/lib/homestacks",
  slug: "media",
};

describe("composeArgs", () => {
  it("passes the compose file and no override when translation is inactive", () => {
    expect(composeArgs(CTX, "docker-compose.yml", null, ["up", "-d"])).toEqual([
      "compose", "-f", "/data/stacks/media/docker-compose.yml", "up", "-d",
    ]);
  });

  it("appends the override as a second -f, after the base file", () => {
    const args = composeArgs(
      CTX, "docker-compose.yml", "/var/lib/homestacks/run/media.override.yml", ["up", "-d"],
    );
    expect(args.slice(0, 5)).toEqual([
      "compose",
      "-f", "/data/stacks/media/docker-compose.yml",
      "-f", "/var/lib/homestacks/run/media.override.yml",
    ]);
  });

  it("honours a compose.yaml filename rather than assuming docker-compose.yml", () => {
    expect(composeArgs(CTX, "compose.yaml", null, ["ps"])).toContain("/data/stacks/media/compose.yaml");
  });

  it("never emits -v on down", () => {
    expect(composeArgs(CTX, "docker-compose.yml", null, ["down"])).not.toContain("-v");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/server/docker/compose.test.ts`
Expected: FAIL — cannot resolve `./compose.js`.

- [ ] **Step 3: Write the implementation**

`src/server/docker/compose.ts`:

```typescript
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findComposeFile, projectPath } from "../projects/store.js";
import { buildOverride } from "./translate.js";
import { type Runner, runDocker } from "./run.js";

export type ComposeContext = {
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
  slug: string;
};

export type ContainerState = {
  service: string;
  name: string;
  state: string;
  health: string | null;
  exitCode: number;
};

export function composeArgs(
  ctx: ComposeContext,
  composeFile: string,
  overridePath: string | null,
  verb: string[],
): string[] {
  const dir = projectPath(ctx.projectsDir, ctx.slug);
  const args = ["compose", "-f", join(dir, composeFile)];
  if (overridePath) args.push("-f", overridePath);
  return [...args, ...verb];
}

/** Resolves the real compose filename — it may be compose.yaml — then delegates. */
async function argsFor(
  ctx: ComposeContext,
  overridePath: string | null,
  verb: string[],
): Promise<string[]> {
  const dir = projectPath(ctx.projectsDir, ctx.slug);
  const composeFile = (await findComposeFile(dir)) ?? "docker-compose.yml";
  return composeArgs(ctx, composeFile, overridePath, verb);
}

export async function composeConfig(ctx: ComposeContext, run: Runner = runDocker): Promise<unknown> {
  const args = await argsFor(ctx, null, ["config", "--format", "json"]);
  const { stdout, stderr, code } = await run(args);
  if (code !== 0) throw new Error(stderr.trim() || `docker compose config exited ${code}`);
  return JSON.parse(stdout);
}

/**
 * Regenerated before every invocation — the compose file may have changed
 * since the last one. Returns null when translation is inactive.
 */
export async function ensureOverride(ctx: ComposeContext, run: Runner = runDocker): Promise<string | null> {
  if (ctx.projectsDir === ctx.projectsHostDir) return null;
  const canonical = await composeConfig(ctx, run);
  const yaml = buildOverride(canonical, {
    projectsDir: ctx.projectsDir,
    projectsHostDir: ctx.projectsHostDir,
    slug: ctx.slug,
  });
  const path = join(ctx.dataDir, "run", `${ctx.slug}.override.yml`);
  if (yaml === null) {
    await rm(path, { force: true });
    return null;
  }
  await mkdir(join(ctx.dataDir, "run"), { recursive: true });
  await writeFile(path, yaml, "utf8");
  return path;
}

export async function composePs(ctx: ComposeContext, run: Runner = runDocker): Promise<ContainerState[]> {
  const args = await argsFor(ctx, null, ["ps", "--all", "--format", "json"]);
  const { stdout, code } = await run(args);
  if (code !== 0) return [];
  // Compose emits one JSON object per line, not a JSON array.
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((c) => ({
      service: String(c.Service ?? ""),
      name: String(c.Name ?? ""),
      state: String(c.State ?? "unknown"),
      health: c.Health ? String(c.Health) : null,
      exitCode: Number(c.ExitCode ?? 0),
    }));
}

/** Streams merged stdout and stderr. Resolves with the exit code; does not throw on non-zero. */
export async function composeExec(
  ctx: ComposeContext,
  verb: string[],
  onOutput: (chunk: string) => void,
  run: Runner = runDocker,
): Promise<number> {
  if (verb[0] === "down" && verb.includes("-v")) {
    throw new Error("refusing to run `compose down -v`: volume removal is a separate action");
  }
  const overridePath = await ensureOverride(ctx, run);
  const args = await argsFor(ctx, overridePath, verb);

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: projectPath(ctx.projectsDir, ctx.slug) });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
```

Export `findComposeFile` from `src/server/projects/store.ts` (it is currently module-private).

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm vitest run src/server/docker/compose.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the integration test**

`src/server/docker/compose.integration.test.ts`:

```typescript
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeConfig, composeExec, composePs, type ComposeContext } from "./compose.js";

// Real Docker. Opt in with HOMESTACKS_DOCKER_TESTS=1.
const enabled = process.env.HOMESTACKS_DOCKER_TESTS === "1";
const d = enabled ? describe : describe.skip;

let root: string;
let ctx: ComposeContext;

beforeAll(async () => {
  if (!enabled) return;
  root = await mkdtemp(join(tmpdir(), "hs-compose-"));
  await mkdir(join(root, "probe", "config"), { recursive: true });
  await writeFile(join(root, "probe", "config", "marker.txt"), "REAL\n");
  await writeFile(
    join(root, "probe", "docker-compose.yml"),
    ["name: hs-probe", "services:", "  app:", "    image: traefik/whoami", '    ports: ["127.0.0.1:18099:80"]',
     "    volumes:", "      - ./config:/config", ""].join("\n"),
  );
  ctx = { projectsDir: root, projectsHostDir: root, dataDir: root, slug: "probe" };
});

afterAll(async () => {
  if (!enabled) return;
  await composeExec(ctx, ["down"], () => {});
});

d("compose against real Docker", () => {
  it("reads the project name from compose rather than the directory", async () => {
    const canonical = (await composeConfig(ctx)) as { name: string };
    expect(canonical.name).toBe("hs-probe");
  });

  it("brings the stack up and reports it running", async () => {
    const output: string[] = [];
    const code = await composeExec(ctx, ["up", "-d"], (c) => output.push(c));
    expect(code, output.join("")).toBe(0);
    const states = await composePs(ctx);
    expect(states.find((s) => s.service === "app")?.state).toBe("running");
  }, 120_000);

  it("streams output to the callback", async () => {
    const chunks: string[] = [];
    await composeExec(ctx, ["ps"], (c) => chunks.push(c));
    expect(chunks.join("")).toContain("app");
  }, 60_000);

  it("refuses `down -v`", async () => {
    await expect(composeExec(ctx, ["down", "-v"], () => {})).rejects.toThrow(/volume removal/);
  });

  it("brings the stack down", async () => {
    expect(await composeExec(ctx, ["down"], () => {})).toBe(0);
    expect((await composePs(ctx)).filter((s) => s.state === "running")).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 6: Run the integration test against real Docker**

```bash
HOMESTACKS_DOCKER_TESTS=1 pnpm vitest run src/server/docker/compose.integration.test.ts
```

Expected: PASS (5 tests). Then confirm it is skipped by default: `pnpm test` should report them as skipped, not failed.

Add the opt-in command to `package.json` as `"test:docker": "HOMESTACKS_DOCKER_TESTS=1 vitest run"`.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint
git add src/server/docker src/server/projects/store.ts package.json
git commit -m "feat: add compose command wrapper with streaming output"
```

---

### Task 8: Operation registry

**Files:**
- Create: `src/server/ops/registry.ts`
- Modify: `src/server/db/schema.ts` (add `operations`)
- Test: `src/server/ops/registry.test.ts`

**Interfaces:**
- Consumes: `Db` from Plan 1, `composeExec` (Task 7).
- Produces:
  - `type OperationKind = "up" | "down" | "restart" | "pull"`
  - `type OperationStatus = "running" | "succeeded" | "failed"`
  - `type Operation = { id: string; slug: string; kind: OperationKind; status: OperationStatus; exitCode: number | null; startedAt: number; finishedAt: number | null }`
  - `createRegistry(db: Db): OperationRegistry` with:
    - `start(slug, kind, actorUserId, run: (emit: (chunk: string) => void) => Promise<number>): Promise<Operation>`
    - `get(id): Operation | undefined`
    - `wait(id): Promise<void>` — resolves when the operation settles. Exists so tests can await completion deterministically instead of sleeping; the routes never call it.
    - `subscribe(id, onChunk, onEnd): () => void` — replays buffered output, then streams.
    - `listForProject(slug): Promise<Operation[]>`
  - `type OperationRegistry = ReturnType<typeof createRegistry>`

**Two properties this must have.** A **per-project mutex**, because two concurrent `compose up` on one project is a corruption path (spec §7.3) — a second `start` for a busy project rejects rather than queueing, so the user gets an immediate, honest error. And **output buffering**, because a client that subscribes after the operation began must still see everything from the start.

- [ ] **Step 1: Add the schema and migration**

Append to `src/server/db/schema.ts`:

```typescript
export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  projectSlug: text("project_slug").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  exitCode: integer("exit_code"),
  actorUserId: text("actor_user_id"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  output: text("output").notNull().default(""),
});
```

Add `integer` to the existing `drizzle-orm/sqlite-core` import. Then:

```bash
pnpm drizzle-kit generate
```

Read the generated SQL and confirm it creates the table with `id` as PRIMARY KEY. Commit the migration.

- [ ] **Step 2: Write the failing test**

`src/server/ops/registry.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "../db/client.js";
import { createRegistry } from "./registry.js";

let db: Db;
let registry: ReturnType<typeof createRegistry>;

const deferred = () => {
  let resolve!: (code: number) => void;
  const promise = new Promise<number>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
  registry = createRegistry(db);
});

describe("operation registry", () => {
  it("runs an operation and records success", async () => {
    const op = await registry.start("media", "up", "u1", async (emit) => { emit("done\n"); return 0; });
    await registry.wait(op.id);
    const final = registry.get(op.id);
    expect(final?.status).toBe("succeeded");
    expect(final?.exitCode).toBe(0);
  });

  it("records a non-zero exit as failed", async () => {
    const op = await registry.start("media", "up", "u1", async () => 1);
    await registry.wait(op.id);
    expect(registry.get(op.id)?.status).toBe("failed");
  });

  it("records a thrown error as failed rather than leaving it running", async () => {
    const op = await registry.start("media", "up", "u1", async () => { throw new Error("boom"); });
    await registry.wait(op.id);
    expect(registry.get(op.id)?.status).toBe("failed");
  });

  it("rejects a second operation on the same project while one is running", async () => {
    const gate = deferred();
    const first = await registry.start("media", "up", "u1", () => gate.promise);
    await expect(registry.start("media", "down", "u1", async () => 0)).rejects.toThrow(/already running/);
    gate.resolve(0);
    await registry.wait(first.id);
  });

  it("allows a second operation once the first finishes", async () => {
    const a = await registry.start("media", "up", "u1", async () => 0);
    await registry.wait(a.id);
    const b = await registry.start("media", "down", "u1", async () => 0);
    await registry.wait(b.id);
    expect(registry.get(b.id)?.status).toBe("succeeded");
  });

  it("allows concurrent operations on different projects", async () => {
    const gate = deferred();
    const a = await registry.start("media", "up", "u1", () => gate.promise);
    const b = await registry.start("paperless", "up", "u1", async () => 0);
    await registry.wait(b.id);
    gate.resolve(0);
    await registry.wait(a.id);
    expect(registry.get(b.id)?.status).toBe("succeeded");
  });

  it("replays buffered output to a late subscriber", async () => {
    const gate = deferred();
    const op = await registry.start("media", "up", "u1", async (emit) => {
      emit("first\n");
      return gate.promise;
    });
    await new Promise((r) => setTimeout(r, 10));
    const seen: string[] = [];
    registry.subscribe(op.id, (c) => seen.push(c), () => {});
    expect(seen.join("")).toContain("first\n");
    gate.resolve(0);
    await registry.wait(op.id);
  });

  it("notifies subscribers when the operation ends and stops after unsubscribe", async () => {
    const gate = deferred();
    let ended = false;
    const seen: string[] = [];
    const op = await registry.start("media", "up", "u1", async (emit) => {
      emit("a\n");
      const code = await gate.promise;
      emit("b\n");
      return code;
    });
    const unsubscribe = registry.subscribe(op.id, (c) => seen.push(c), () => { ended = true; });
    unsubscribe();
    gate.resolve(0);
    await registry.wait(op.id);
    expect(seen.join("")).toBe("a\n");
    expect(ended).toBe(false);
  });

  it("persists terminal results for history", async () => {
    const op = await registry.start("media", "up", "u1", async (emit) => { emit("hello\n"); return 0; });
    await registry.wait(op.id);
    const history = await registry.listForProject("media");
    expect(history[0]).toMatchObject({ id: op.id, status: "succeeded", exitCode: 0 });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run src/server/ops/registry.test.ts`
Expected: FAIL — cannot resolve `./registry.js`.

- [ ] **Step 4: Write the implementation**

`src/server/ops/registry.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { operations } from "../db/schema.js";

export type OperationKind = "up" | "down" | "restart" | "pull";
export type OperationStatus = "running" | "succeeded" | "failed";

export type Operation = {
  id: string;
  slug: string;
  kind: OperationKind;
  status: OperationStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
};

type Subscriber = { onChunk: (chunk: string) => void; onEnd: () => void };

type Live = {
  op: Operation;
  buffer: string[];
  subscribers: Set<Subscriber>;
  done: Promise<void>;
};

/** Caps a runaway `pull` from exhausting memory; the tail is what matters. */
const MAX_BUFFERED_CHUNKS = 5000;

export function createRegistry(db: Db) {
  const live = new Map<string, Live>();
  const busy = new Set<string>();

  async function start(
    slug: string,
    kind: OperationKind,
    actorUserId: string | null,
    run: (emit: (chunk: string) => void) => Promise<number>,
  ): Promise<Operation> {
    if (busy.has(slug)) {
      throw new Error(`an operation is already running for project "${slug}"`);
    }
    busy.add(slug);

    const op: Operation = {
      id: randomUUID(),
      slug,
      kind,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    const entry: Live = { op, buffer: [], subscribers: new Set(), done: Promise.resolve() };
    live.set(op.id, entry);

    const emit = (chunk: string) => {
      if (entry.buffer.length < MAX_BUFFERED_CHUNKS) entry.buffer.push(chunk);
      for (const sub of entry.subscribers) sub.onChunk(chunk);
    };

    entry.done = (async () => {
      let code = 1;
      try {
        code = await run(emit);
      } catch (err) {
        emit(`\n${err instanceof Error ? err.message : String(err)}\n`);
        code = 1;
      } finally {
        op.exitCode = code;
        op.status = code === 0 ? "succeeded" : "failed";
        op.finishedAt = Date.now();
        busy.delete(slug);
        for (const sub of entry.subscribers) sub.onEnd();
        entry.subscribers.clear();
        await db.insert(operations).values({
          id: op.id,
          projectSlug: slug,
          kind,
          status: op.status,
          exitCode: op.exitCode,
          actorUserId,
          startedAt: op.startedAt,
          finishedAt: op.finishedAt,
          output: entry.buffer.join(""),
        });
      }
    })();

    return op;
  }

  return {
    start,
    get: (id: string) => live.get(id)?.op,
    wait: (id: string) => live.get(id)?.done ?? Promise.resolve(),
    subscribe(id: string, onChunk: (chunk: string) => void, onEnd: () => void): () => void {
      const entry = live.get(id);
      if (!entry) {
        onEnd();
        return () => {};
      }
      for (const chunk of entry.buffer) onChunk(chunk);
      if (entry.op.status !== "running") {
        onEnd();
        return () => {};
      }
      const sub: Subscriber = { onChunk, onEnd };
      entry.subscribers.add(sub);
      return () => entry.subscribers.delete(sub);
    },
    async listForProject(slug: string) {
      return db
        .select()
        .from(operations)
        .where(eq(operations.projectSlug, slug))
        .orderBy(desc(operations.startedAt))
        .limit(50);
    },
  };
}

export type OperationRegistry = ReturnType<typeof createRegistry>;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/server/ops/registry.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint
git add src/server/ops src/server/db/schema.ts drizzle
git commit -m "feat: add operation registry with per-project mutex and output buffering"
```

---

### Task 9: Project API routes

**Files:**
- Create: `src/server/routes/projects.ts`
- Modify: `src/server/app.ts` (register the routes)
- Test: `src/server/routes/projects.test.ts`

**Interfaces:**
- Consumes: `requirePermission` (Plan 1), `scanProjects`/`readProjectFile`/`writeProjectFile`/`isValidSlug` (Tasks 4-5), `parseCanonical` (Task 2), `composeConfig` (Task 7), `Config`.
- Produces these routes, all requiring a session:

```
GET    /api/projects                       [project:read]  list + per-project model where parseable
GET    /api/projects/:slug                 [project:read]  model, container states, snapshot list
GET    /api/projects/:slug/file/:name      [compose:read]  name = compose | env
PUT    /api/projects/:slug/file/:name      [compose:write] snapshot + atomic write
POST   /api/projects/:slug/validate        [compose:write] runs `docker compose config`
```

**Sign in with `auth.api.signInEmail` in tests**, never over HTTP — Plan 1 rate-limits `/sign-in/email` to 5 per minute per test file.

- [ ] **Step 1: Write the failing test**

`src/server/routes/projects.test.ts`:

```typescript
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, runMigrations, type Db } from "../db/client.js";
import { user } from "../db/schema.js";

const TEST_AUTH = { secret: "test-secret-value-at-least-32-chars", baseURL: "http://localhost:7420" };

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let auth: ReturnType<typeof createAuth>;
let root: string;
let adminCookie: string;
let viewerCookie: string;

/** Server-side sign-in: bypasses the HTTP rate limiter (5/min per file). */
async function signIn(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie returned");
  return cookie.split(";")[0]!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-routes-"));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(
    join(root, "media", "docker-compose.yml"),
    "name: media\nservices:\n  web:\n    image: nginx\n",
  );

  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);
  app = await buildApp({ db, auth, projectsDir: root, projectsHostDir: root, dataDir: root });

  const a = await auth.api.signUpEmail({
    body: { email: "admin@example.com", name: "Admin", password: "correct-horse-battery" },
  });
  await db.update(user).set({ role: "admin" }).where(eq(user.id, a.user.id));
  await auth.api.signUpEmail({
    body: { email: "viewer@example.com", name: "Viewer", password: "correct-horse-battery" },
  });
  adminCookie = await signIn("admin@example.com", "correct-horse-battery");
  viewerCookie = await signIn("viewer@example.com", "correct-horse-battery");
});

describe("GET /api/projects", () => {
  it("lists discovered projects for an admin", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().projects.map((p: { slug: string }) => p.slug)).toEqual(["media"]);
  });

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/projects" })).statusCode).toBe(401);
  });
});

describe("compose file access", () => {
  it("lets an admin read the compose file", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/projects/media/file/compose", headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toContain("image: nginx");
  });

  it("denies a viewer, because .env and compose hold passwords", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/projects/media/file/compose", headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("writes and snapshots on PUT", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/projects/media/file/compose",
      headers: { cookie: adminCookie },
      payload: { content: "name: media\nservices:\n  web:\n    image: caddy\n" },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: "GET", url: "/api/projects/media/file/compose", headers: { cookie: adminCookie },
    });
    expect(get.json().content).toContain("caddy");
    const detail = await app.inject({
      method: "GET", url: "/api/projects/media", headers: { cookie: adminCookie },
    });
    expect(detail.json().snapshots.length).toBe(1);
  });

  it("denies a viewer writing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/media/file/compose",
      headers: { cookie: viewerCookie },
      payload: { content: "services: {}\n" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an unknown file name", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/projects/media/file/secrets", headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a traversal slug without touching the filesystem", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/projects/..%2F..%2Fetc/file/compose", headers: { cookie: adminCookie },
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it("404s an unknown project", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/projects/nope/file/compose", headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/server/routes/projects.test.ts`
Expected: FAIL — `buildApp` does not accept the new options.

- [ ] **Step 3: Extend `buildApp` and write the routes**

`src/server/app.ts` gains three options:

```typescript
export type AppDeps = {
  db: Db;
  auth: Auth;
  logger?: boolean;
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
};
```

Register `projectRoutes` after the existing routes, passing those three paths through. Update `src/server/index.ts` to supply them from `config`, and update Plan 1's existing `buildApp` call sites in `app.test.ts`, `plugin.test.ts`, `onboarding.test.ts` and `origin.test.ts` — a temp directory is fine for those.

`src/server/routes/projects.ts`:

```typescript
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/guard.js";
import { composeConfig } from "../docker/compose.js";
import { parseCanonical } from "../projects/model.js";
import {
  isValidSlug,
  listSnapshots,
  readProjectFile,
  scanProjects,
  writeProjectFile,
} from "../projects/store.js";

type Opts = { projectsDir: string; projectsHostDir: string; dataDir: string };

const fileParam = z.enum(["compose", "env"]);
const putBody = z.object({ content: z.string().max(1024 * 1024) });

export const projectRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const ctxFor = (slug: string) => ({ ...opts, slug });

  app.get("/api/projects", { preHandler: requirePermission({ project: ["read"] }) }, async () => {
    const entries = await scanProjects(opts.projectsDir);
    return { projects: entries };
  });

  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      const { slug } = request.params;
      if (!isValidSlug(slug)) return reply.status(400).send({ error: "invalid_slug" });
      const entries = await scanProjects(opts.projectsDir);
      const entry = entries.find((e) => e.slug === slug);
      if (!entry) return reply.status(404).send({ error: "not_found" });

      let model = null;
      let parseError: string | null = null;
      if (entry.hasCompose) {
        try {
          model = parseCanonical(await composeConfig(ctxFor(slug)));
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }
      }
      return { ...entry, model, parseError, snapshots: await listSnapshots(opts.projectsDir, slug) };
    },
  );

  app.get<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/file/:name",
    { preHandler: requirePermission({ compose: ["read"] }) },
    async (request, reply) => {
      const name = fileParam.safeParse(request.params.name);
      if (!name.success) return reply.status(400).send({ error: "unknown_file" });
      if (!isValidSlug(request.params.slug)) return reply.status(400).send({ error: "invalid_slug" });
      const content = await readProjectFile(opts.projectsDir, request.params.slug, name.data);
      if (content === null) return reply.status(404).send({ error: "not_found" });
      return { content };
    },
  );

  app.put<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/file/:name",
    { preHandler: requirePermission({ compose: ["write"] }) },
    async (request, reply) => {
      const name = fileParam.safeParse(request.params.name);
      if (!name.success) return reply.status(400).send({ error: "unknown_file" });
      if (!isValidSlug(request.params.slug)) return reply.status(400).send({ error: "invalid_slug" });
      const body = putBody.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: "invalid_body" });
      const entries = await scanProjects(opts.projectsDir);
      if (!entries.some((e) => e.slug === request.params.slug)) {
        return reply.status(404).send({ error: "not_found" });
      }
      await writeProjectFile(opts.projectsDir, request.params.slug, name.data, body.data.content);
      return { ok: true };
    },
  );

  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/validate",
    { preHandler: requirePermission({ compose: ["write"] }) },
    async (request, reply) => {
      if (!isValidSlug(request.params.slug)) return reply.status(400).send({ error: "invalid_slug" });
      try {
        const model = parseCanonical(await composeConfig(ctxFor(request.params.slug)));
        return { valid: true, model };
      } catch (err) {
        return { valid: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/routes/projects.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/server/routes/projects.ts src/server/app.ts src/server/index.ts src/server
git commit -m "feat: add project listing, detail, and file editing routes"
```

---

### Task 10: Lifecycle routes and SSE streaming

**Files:**
- Create: `src/server/routes/operations.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/routes/operations.test.ts`

**Interfaces:**
- Consumes: the registry (Task 8), `composeExec`/`composePs` (Task 7), `requirePermission`.
- Produces:

```
POST /api/projects/:slug/up|down|restart|pull   [project:control]  → { operationId }
GET  /api/operations/:id                        [project:read]     current state
GET  /api/operations/:id/stream                 [project:read]     SSE: output chunks then end
GET  /api/projects/:slug/operations             [project:read]     history
GET  /api/projects/:slug/logs                   [logs:read]        SSE: `compose logs -f`
```

**SSE framing.** Each event is `data: <json>\n\n`. Newlines inside a chunk must be JSON-encoded, not emitted raw, or a multi-line log line silently truncates the event. Send an initial comment (`: connected\n\n`) so the client sees the stream open, and set `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.

**Client disconnect must kill the follower.** `compose logs -f` runs until killed; if nobody unregisters on `request.raw.on("close")`, every closed tab leaks a `docker` process.

- [ ] **Step 1: Write the failing test**

`src/server/routes/operations.test.ts`:

```typescript
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, runMigrations, type Db } from "../db/client.js";
import { user } from "../db/schema.js";

const TEST_AUTH = { secret: "test-secret-value-at-least-32-chars", baseURL: "http://localhost:7420" };

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let auth: ReturnType<typeof createAuth>;
let root: string;
let adminCookie: string;
let viewerCookie: string;

async function signIn(email: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password: "correct-horse-battery" }, asResponse: true,
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-ops-"));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "docker-compose.yml"), "name: media\nservices:\n  web:\n    image: nginx\n");
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);
  app = await buildApp({ db, auth, projectsDir: root, projectsHostDir: root, dataDir: root });
  const a = await auth.api.signUpEmail({
    body: { email: "admin@example.com", name: "A", password: "correct-horse-battery" },
  });
  await db.update(user).set({ role: "admin" }).where(eq(user.id, a.user.id));
  await auth.api.signUpEmail({
    body: { email: "viewer@example.com", name: "V", password: "correct-horse-battery" },
  });
  adminCookie = await signIn("admin@example.com");
  viewerCookie = await signIn("viewer@example.com");
});

describe("lifecycle routes", () => {
  it("denies a viewer starting an operation", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/projects/media/up", headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires a session", async () => {
    expect((await app.inject({ method: "POST", url: "/api/projects/media/up" })).statusCode).toBe(401);
  });

  it("returns an operation id for an admin", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/projects/media/up", headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(202);
    expect(typeof res.json().operationId).toBe("string");
  });

  it("404s an unknown project without starting anything", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/projects/nope/up", headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an unknown verb", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/projects/media/destroy", headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when an operation is already running for the project", async () => {
    await app.inject({ method: "POST", url: "/api/projects/media/pull", headers: { cookie: adminCookie } });
    const second = await app.inject({
      method: "POST", url: "/api/projects/media/up", headers: { cookie: adminCookie },
    });
    expect([202, 409]).toContain(second.statusCode);
  });

  it("exposes operation history", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/projects/media/operations", headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().operations)).toBe(true);
  });

  it("denies a viewer reading logs", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/projects/media/logs", headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("SSE framing", () => {
  it("encodes newlines so a multi-line chunk stays one event", async () => {
    const { encodeSseData } = await import("./operations.js");
    const frame = encodeSseData({ chunk: "line one\nline two\n" });
    expect(frame.split("\n\n")).toHaveLength(2);
    expect(frame.startsWith("data: ")).toBe(true);
    expect(JSON.parse(frame.slice(6).trimEnd()).chunk).toBe("line one\nline two\n");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/server/routes/operations.test.ts`
Expected: FAIL — cannot resolve `./operations.js`.

- [ ] **Step 3: Write the routes**

`src/server/routes/operations.ts`:

```typescript
import { spawn } from "node:child_process";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { requirePermission } from "../auth/guard.js";
import { composeExec, ensureOverride } from "../docker/compose.js";
import { isValidSlug, projectPath, scanProjects } from "../projects/store.js";
import type { OperationKind, OperationRegistry } from "../ops/registry.js";

type Opts = {
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
  registry: OperationRegistry;
};

const VERBS: Record<string, { kind: OperationKind; args: string[] }> = {
  up: { kind: "up", args: ["up", "-d"] },
  down: { kind: "down", args: ["down"] },
  restart: { kind: "restart", args: ["restart"] },
  pull: { kind: "pull", args: ["pull"] },
};

/** One SSE event. Newlines inside the payload are JSON-escaped, never emitted raw. */
export function encodeSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function openSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");
}

export const operationRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const ctxFor = (slug: string) => ({
    projectsDir: opts.projectsDir,
    projectsHostDir: opts.projectsHostDir,
    dataDir: opts.dataDir,
    slug,
  });

  const exists = async (slug: string) =>
    isValidSlug(slug) && (await scanProjects(opts.projectsDir)).some((e) => e.slug === slug);

  app.post<{ Params: { slug: string; verb: string } }>(
    "/api/projects/:slug/:verb",
    { preHandler: requirePermission({ project: ["control"] }) },
    async (request, reply) => {
      const verb = VERBS[request.params.verb];
      if (!verb) return reply.callNotFound();
      const { slug } = request.params;
      if (!(await exists(slug))) return reply.status(404).send({ error: "not_found" });
      try {
        const op = await opts.registry.start(
          slug,
          verb.kind,
          request.session?.user.id ?? null,
          (emit) => composeExec(ctxFor(slug), verb.args, emit),
        );
        return reply.status(202).send({ operationId: op.id });
      } catch (err) {
        return reply.status(409).send({
          error: "operation_in_progress",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/operations/:id",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      const op = opts.registry.get(request.params.id);
      if (!op) return reply.status(404).send({ error: "not_found" });
      return op;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/stream",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      openSse(reply);
      const unsubscribe = opts.registry.subscribe(
        request.params.id,
        (chunk) => reply.raw.write(encodeSseData({ chunk })),
        () => {
          reply.raw.write(encodeSseData({ end: true, operation: opts.registry.get(request.params.id) }));
          reply.raw.end();
        },
      );
      request.raw.on("close", unsubscribe);
      return reply;
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/operations",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      if (!isValidSlug(request.params.slug)) return reply.status(400).send({ error: "invalid_slug" });
      return { operations: await opts.registry.listForProject(request.params.slug) };
    },
  );

  app.get<{ Params: { slug: string }; Querystring: { service?: string; tail?: string } }>(
    "/api/projects/:slug/logs",
    { preHandler: requirePermission({ logs: ["read"] }) },
    async (request, reply) => {
      const { slug } = request.params;
      if (!(await exists(slug))) return reply.status(404).send({ error: "not_found" });

      const overridePath = await ensureOverride(ctxFor(slug));
      const dir = projectPath(opts.projectsDir, slug);
      const args = ["compose", "-f", `${dir}/docker-compose.yml`];
      if (overridePath) args.push("-f", overridePath);
      args.push("logs", "--follow", "--tail", String(Number(request.query.tail ?? 200)));
      if (request.query.service) args.push(request.query.service);

      openSse(reply);
      const child = spawn("docker", args, { cwd: dir });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const send = (chunk: string) => reply.raw.write(encodeSseData({ chunk }));
      child.stdout.on("data", send);
      child.stderr.on("data", send);
      child.on("close", () => {
        reply.raw.write(encodeSseData({ end: true }));
        reply.raw.end();
      });
      // Without this, every closed browser tab leaks a `docker compose logs -f`.
      request.raw.on("close", () => child.kill("SIGTERM"));
      return reply;
    },
  );
};
```

Note the logs route builds its own args rather than calling `composeExec`, because it needs the child handle to kill on disconnect. Resolve the real compose filename the same way `composeExec` does rather than hardcoding `docker-compose.yml` — reuse the exported helper.

Register in `buildApp`. The registry is **constructed inside `buildApp` from `deps.db`**, not passed in through `AppDeps` — one registry per app instance, so the per-project mutex covers every route in that instance and tests get a fresh one automatically:

```typescript
const registry = createRegistry(deps.db);
await app.register(operationRoutes, {
  projectsDir: deps.projectsDir,
  projectsHostDir: deps.projectsHostDir,
  dataDir: deps.dataDir,
  registry,
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/routes/operations.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/server/routes/operations.ts src/server/app.ts
git commit -m "feat: add lifecycle routes with SSE operation and log streaming"
```

---

## Definition of Done

- `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm e2e` all clean.
- `HOMESTACKS_DOCKER_TESTS=1 pnpm test:docker` passes against real Docker; those tests are skipped, not failed, in the default run.
- A viewer receives 403 on compose read, compose write, lifecycle verbs, and logs. An anonymous request receives 401.
- Two concurrent lifecycle requests for one project produce one 202 and one 409.
- Editing a compose file leaves a snapshot and no temp file.
- `compose down -v` is refused at the wrapper level.

## Handoff to Plan 3 (project UI)

- `GET /api/projects`, `GET /api/projects/:slug` — list and detail, including `model` and `parseError`.
- `GET|PUT /api/projects/:slug/file/:name` — editor read/write.
- `POST /api/projects/:slug/validate` — validate before save.
- `POST /api/projects/:slug/{up,down,restart,pull}` → `{ operationId }`, then `GET /api/operations/:id/stream`.
- `GET /api/projects/:slug/logs?service=&tail=` — SSE log follower.
- `src/shared/projects.ts` — `ProjectModel`, `ServiceModel`, `PublishedPort`, `AppMeta`.
- `PublishedPort.loopbackOnly` drives the *tunnel-only* vs *LAN-reachable* indicator (spec §7.4).

## Not in this plan

Project creation from blank/template/import, rename and delete migrations, the template catalog, and image update checking. Rename in particular is a data-loss risk (spec §5.4 — named volumes are prefixed by the compose project name) and deserves its own task set rather than being appended here. These go to Plan 3 or a dedicated follow-up, decided when Plan 3 is scoped.
