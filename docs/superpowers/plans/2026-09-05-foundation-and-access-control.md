# Homestead Plan 1 — Foundation & Access Control

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Homestead server that boots, validates its environment, stores encrypted secrets, and enforces admin/viewer access control behind a login screen.

**Architecture:** Single pnpm package with three zones (`src/web`, `src/server`, `src/shared`). Fastify serves the API and the built SPA from one Node process. SQLite via libSQL + Drizzle. Better-Auth with the admin plugin provides sessions and role-based access control. Configuration is a pure function of the environment so it can be unit-tested without a filesystem.

**Tech Stack:** TypeScript (ESM, strict), Fastify 5, Vite + React, Tailwind, TanStack Query v5, react-router-dom v6, Drizzle ORM + `@libsql/client`, Better-Auth + admin plugin, Vitest, Playwright, Biome, tsup.

**Spec:** `docs/superpowers/specs/2026-09-05-homestead-design.md`

## Global Constraints

- Node: current LTS. pnpm as package manager. ESM throughout (`"type": "module"`).
- TypeScript: `strict: true`, `moduleResolution: "bundler"`, `target: "ES2022"`.
- Always install the newest stable major of every dependency. No RCs or betas.
- Path alias `@shared/*` → `src/shared/*`. Server and web both import through it.
- Biome is the only linter/formatter. No ESLint, no Prettier.
- **No `Co-Authored-By` trailers and no AI-attribution lines in commit messages.**
- `$HOMESTEAD_DATA` must be on a local filesystem — SQLite locking is unreliable over NFS/SMB (spec §4.1).
- Every secret at rest (`api_token`, `tunnel_token`, `client_secret`) is encrypted with the key from `HOMESTEAD_SECRET_KEY`, or from `$HOMESTEAD_DATA/secret.key` generated at `0600` (spec §12.4).
- Role enforcement is a server-side route precondition, never a UI concern (spec §6).
- `compose:read` is an admin permission, not a viewer one — the compose file and `.env` hold passwords (spec §6).

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `vite.config.ts`, `tsup.config.ts` | Tooling |
| `src/server/config.ts` | Pure env → `Config`. No I/O. |
| `src/server/crypto/secrets.ts` | Key material lifecycle; AES-256-GCM encrypt/decrypt. |
| `src/server/db/schema.ts` | Drizzle tables: Better-Auth's plus `settings`. |
| `src/server/db/client.ts` | libSQL client construction and migration runner. |
| `src/server/db/settings.ts` | Typed get/set over the `settings` table. |
| `src/server/auth/permissions.ts` | Access-control statements and role definitions. |
| `src/server/auth/index.ts` | The Better-Auth instance. |
| `src/server/auth/plugin.ts` | Fastify plugin: mounts the handler, decorates `request.session`. |
| `src/server/auth/guard.ts` | `requirePermission()` preHandler factory. |
| `src/server/auth/bootstrap.ts` | Atomic single-winner claim for first-admin creation. |
| `src/server/routes/onboarding.ts` | `POST /api/onboarding/admin`. |
| `src/server/preflight.ts` | Startup check registry; later plans register Docker checks. |
| `src/server/app.ts` | Fastify app assembly. Exported for `inject()` tests. |
| `src/server/index.ts` | Process entrypoint: preflight, listen. |
| `src/shared/permissions.ts` | Statement shape shared by server and web. |
| `src/web/lib/auth-client.ts` | Better-Auth React client. |
| `src/web/routes/Login.tsx`, `src/web/routes/Setup.tsx`, `src/web/routes/Dashboard.tsx` | Screens. |
| `src/web/components/ProtectedRoute.tsx` | Session gate. |

---

### Task 1: Project scaffold and health endpoint

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`
- Modify: `.gitignore` (already exists from the spec commit; add `drizzle/meta` noise only if drizzle-kit generates any)
- Create: `src/server/app.ts`, `src/server/index.ts`
- Test: `src/server/app.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildApp(): Promise<FastifyInstance>` from `src/server/app.ts`. Every later task adds routes by extending this function.

- [ ] **Step 1: Initialise the package and install dependencies**

```bash
pnpm init
pnpm pkg set type=module
pnpm add fastify
pnpm add -D typescript @types/node vitest @biomejs/biome tsx tsup
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["node", "vitest/globals"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src", "*.config.ts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts` and `biome.json`**

`vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { globals: true, environment: "node", include: ["src/**/*.test.ts"] },
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) },
  },
});
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "files": { "includes": ["src/**", "*.config.ts"] }
}
```

If the `$schema` version does not match the installed Biome, run `pnpm biome migrate --write` to correct it.

- [ ] **Step 4: Write the failing test**

`src/server/app.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("app", () => {
  it("responds to the health check", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm vitest run src/server/app.test.ts`
Expected: FAIL — cannot resolve `./app.js`.

- [ ] **Step 6: Write the minimal implementation**

`src/server/app.ts`:

```typescript
import Fastify, { type FastifyInstance } from "fastify";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get("/api/health", async () => ({ status: "ok" }));
  return app;
}
```

`src/server/index.ts`:

```typescript
import { buildApp } from "./app.js";

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 7420), host: "0.0.0.0" });
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run src/server/app.test.ts`
Expected: PASS

- [ ] **Step 8: Add scripts and commit**

```bash
pnpm pkg set scripts.dev="tsx watch src/server/index.ts"
pnpm pkg set scripts.test="vitest run"
pnpm pkg set scripts.lint="biome check ."
git add -A
git commit -m "feat: scaffold server with health endpoint"
```

---

### Task 2: Configuration module

**Files:**
- Create: `src/server/config.ts`
- Test: `src/server/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Config = { dataDir: string; projectsDir: string; projectsHostDir: string; port: number; secretKey: string | undefined }`
  - `loadConfig(env: Record<string, string | undefined>): Config` — throws `ConfigError` on invalid input.
  - `class ConfigError extends Error`

- [ ] **Step 1: Install zod**

```bash
pnpm add zod
```

- [ ] **Step 2: Write the failing test**

`src/server/config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("applies defaults when nothing is set", () => {
    const c = loadConfig({});
    expect(c.dataDir).toBe("/var/lib/homestead");
    expect(c.projectsDir).toBe("/opt/stacks");
    expect(c.port).toBe(7420);
    expect(c.secretKey).toBeUndefined();
  });

  it("defaults projectsHostDir to projectsDir", () => {
    const c = loadConfig({ HOMESTEAD_PROJECTS: "/opt/stacks" });
    expect(c.projectsHostDir).toBe("/opt/stacks");
  });

  it("keeps projectsHostDir distinct when set, for path translation", () => {
    const c = loadConfig({
      HOMESTEAD_PROJECTS: "/data/stacks",
      HOMESTEAD_PROJECTS_HOST: "/volume2/docker",
    });
    expect(c.projectsDir).toBe("/data/stacks");
    expect(c.projectsHostDir).toBe("/volume2/docker");
  });

  it("rejects relative paths", () => {
    expect(() => loadConfig({ HOMESTEAD_DATA: "relative/path" })).toThrow(ConfigError);
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(ConfigError);
  });

  it("strips a trailing slash so path joins do not double up", () => {
    const c = loadConfig({ HOMESTEAD_PROJECTS: "/opt/stacks/" });
    expect(c.projectsDir).toBe("/opt/stacks");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/server/config.test.ts`
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 4: Write the implementation**

`src/server/config.ts`:

```typescript
import { z } from "zod";

export class ConfigError extends Error {}

export type Config = {
  dataDir: string;
  projectsDir: string;
  projectsHostDir: string;
  port: number;
  secretKey: string | undefined;
};

const absolutePath = z
  .string()
  .refine((v) => v.startsWith("/"), { message: "must be an absolute path" })
  .transform((v) => (v.length > 1 && v.endsWith("/") ? v.slice(0, -1) : v));

const schema = z.object({
  HOMESTEAD_DATA: absolutePath.default("/var/lib/homestead"),
  HOMESTEAD_PROJECTS: absolutePath.default("/opt/stacks"),
  HOMESTEAD_PROJECTS_HOST: absolutePath.optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(7420),
  HOMESTEAD_SECRET_KEY: z.string().min(1).optional(),
});

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const v = parsed.data;
  return {
    dataDir: v.HOMESTEAD_DATA,
    projectsDir: v.HOMESTEAD_PROJECTS,
    projectsHostDir: v.HOMESTEAD_PROJECTS_HOST ?? v.HOMESTEAD_PROJECTS,
    port: v.PORT,
    secretKey: v.HOMESTEAD_SECRET_KEY,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/server/config.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/config.ts src/server/config.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add configuration module with path translation variables"
```

---

### Task 3: Secret key and encryption

**Files:**
- Create: `src/server/crypto/secrets.ts`
- Test: `src/server/crypto/secrets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ensureSecretKey(dataDir: string, envKey: string | undefined): Promise<Buffer>` — 32 bytes. Uses `envKey` (hex or base64) if given, else reads `${dataDir}/secret.key`, else generates and writes it at mode `0o600`.
  - `encrypt(plaintext: string, key: Buffer): string` — returns `v1.<iv>.<tag>.<ciphertext>`, all base64url.
  - `decrypt(payload: string, key: Buffer): string` — throws on tampering or wrong key.

- [ ] **Step 1: Write the failing test**

`src/server/crypto/secrets.test.ts`:

```typescript
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt, ensureSecretKey } from "./secrets.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hs-secrets-"));
});

describe("ensureSecretKey", () => {
  it("generates a 32-byte key and persists it with 0600", async () => {
    const key = await ensureSecretKey(dir, undefined);
    expect(key).toHaveLength(32);
    const s = await stat(join(dir, "secret.key"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("returns the same key on a second call", async () => {
    const a = await ensureSecretKey(dir, undefined);
    const b = await ensureSecretKey(dir, undefined);
    expect(b.equals(a)).toBe(true);
  });

  it("prefers an env-supplied key and does not write a file", async () => {
    const provided = randomBytes(32).toString("hex");
    const key = await ensureSecretKey(dir, provided);
    expect(key.toString("hex")).toBe(provided);
    await expect(readFile(join(dir, "secret.key"))).rejects.toThrow();
  });
});

describe("encrypt/decrypt", () => {
  it("round-trips a value", async () => {
    const key = await ensureSecretKey(dir, undefined);
    expect(decrypt(encrypt("cf-api-token", key), key)).toBe("cf-api-token");
  });

  it("produces a different ciphertext each time", async () => {
    const key = await ensureSecretKey(dir, undefined);
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("rejects a tampered payload", async () => {
    const key = await ensureSecretKey(dir, undefined);
    const parts = encrypt("secret", key).split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), key)).toThrow();
  });

  it("rejects the wrong key", async () => {
    const key = await ensureSecretKey(dir, undefined);
    const payload = encrypt("secret", key);
    expect(() => decrypt(payload, randomBytes(32))).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/crypto/secrets.test.ts`
Expected: FAIL — cannot resolve `./secrets.js`.

- [ ] **Step 3: Write the implementation**

`src/server/crypto/secrets.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

function parseKey(raw: string): Buffer {
  const hex = /^[0-9a-fA-F]+$/.test(raw.trim()) ? Buffer.from(raw.trim(), "hex") : null;
  const key = hex?.length === KEY_BYTES ? hex : Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`secret key must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

export async function ensureSecretKey(
  dataDir: string,
  envKey: string | undefined,
): Promise<Buffer> {
  if (envKey) return parseKey(envKey);

  const path = join(dataDir, "secret.key");
  try {
    return parseKey(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const key = randomBytes(KEY_BYTES);
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, key.toString("hex"), { mode: 0o600, flag: "wx" });
  return key;
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== VERSION || !iv || !tag || !ct) {
    throw new Error("malformed encrypted payload");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/crypto/secrets.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/crypto
git commit -m "feat: add secret key lifecycle and AES-256-GCM helpers"
```

---

### Task 4: Database, migrations, and settings

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/db/settings.ts`, `drizzle.config.ts`
- Test: `src/server/db/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Db` — the Drizzle instance type, re-exported from `src/server/db/client.ts`.
  - `createDb(url: string): Db`
  - `runMigrations(db: Db): Promise<void>`
  - `getSetting(db: Db, key: string): Promise<string | undefined>`
  - `setSetting(db: Db, key: string, value: string): Promise<void>`
  - `settings` table from `schema.ts`.

- [ ] **Step 1: Install database dependencies**

```bash
pnpm add drizzle-orm @libsql/client
pnpm add -D drizzle-kit
```

- [ ] **Step 2: Write the schema and drizzle config**

`src/server/db/schema.ts`:

```typescript
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
```

`drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: "file:./.dev/homestead.db" },
});
```

- [ ] **Step 3: Write the failing test**

`src/server/db/settings.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "./client.js";
import { getSetting, setSetting } from "./settings.js";

let db: Db;
beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
});

describe("settings", () => {
  it("returns undefined for a missing key", async () => {
    expect(await getSetting(db, "onboarding_completed")).toBeUndefined();
  });

  it("round-trips a value", async () => {
    await setSetting(db, "onboarding_completed", "true");
    expect(await getSetting(db, "onboarding_completed")).toBe("true");
  });

  it("overwrites an existing key rather than failing", async () => {
    await setSetting(db, "instance_name", "first");
    await setSetting(db, "instance_name", "second");
    expect(await getSetting(db, "instance_name")).toBe("second");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run src/server/db/settings.test.ts`
Expected: FAIL — cannot resolve `./client.js`.

- [ ] **Step 5: Write the client and settings modules**

`src/server/db/client.ts`:

```typescript
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const normalised = url === ":memory:" ? ":memory:" : `file:${url}`;
  return drizzle(createClient({ url: normalised }), { schema });
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: "./drizzle" });
}
```

`src/server/db/settings.ts`:

```typescript
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { settings } from "./schema.js";

export async function getSetting(db: Db, key: string): Promise<string | undefined> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0]?.value;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}
```

- [ ] **Step 6: Generate the migration**

```bash
pnpm drizzle-kit generate
```

Expected: a new SQL file under `drizzle/` creating the `settings` table. Commit this file — migrations are generated once and applied everywhere, never regenerated at runtime.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run src/server/db/settings.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add src/server/db drizzle drizzle.config.ts package.json pnpm-lock.yaml
git commit -m "feat: add libSQL database, migrations, and settings store"
```

---

### Task 5: Access-control statements and roles

**Files:**
- Create: `src/shared/permissions.ts`, `src/server/auth/permissions.ts`
- Test: `src/server/auth/permissions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `statement` — the access-control statement object, from `src/shared/permissions.ts`.
  - `ac`, `adminRole`, `viewerRole` from `src/server/auth/permissions.ts`.
  - `roles = { admin: adminRole, viewer: viewerRole }`

- [ ] **Step 1: Install Better-Auth**

```bash
pnpm add better-auth @better-auth/drizzle-adapter
```

If `@better-auth/drizzle-adapter` does not resolve, the adapter is exported from `better-auth/adapters/drizzle` in the installed version — check the `exports` map in `node_modules/better-auth/package.json` and use whichever path exists. Record the choice in a comment.

- [ ] **Step 2: Write the failing test**

`src/server/auth/permissions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { adminRole, viewerRole } from "./permissions.js";

describe("roles", () => {
  it("lets an admin write compose files", () => {
    expect(adminRole.authorize({ compose: ["write"] }).success).toBe(true);
  });

  it("denies a viewer compose read, because .env holds passwords", () => {
    expect(viewerRole.authorize({ compose: ["read"] }).success).toBe(false);
  });

  it("lets a viewer read apps", () => {
    expect(viewerRole.authorize({ app: ["read"] }).success).toBe(true);
  });

  it("denies a viewer project control", () => {
    expect(viewerRole.authorize({ project: ["control"] }).success).toBe(false);
  });

  it("denies a viewer tunnel management", () => {
    expect(viewerRole.authorize({ tunnel: ["create"] }).success).toBe(false);
  });

  it("keeps the admin plugin's built-in user permissions", () => {
    expect(adminRole.authorize({ user: ["create"] }).success).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/server/auth/permissions.test.ts`
Expected: FAIL — cannot resolve `./permissions.js`.

- [ ] **Step 4: Write the shared statement and the roles**

`src/shared/permissions.ts`:

```typescript
export const homesteadStatement = {
  project: ["read", "create", "update", "delete", "control"],
  compose: ["read", "write"],
  tunnel: ["read", "create", "delete"],
  app: ["read"],
  logs: ["read"],
  stats: ["read"],
  settings: ["read", "write"],
} as const;
```

`src/server/auth/permissions.ts`:

```typescript
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { homesteadStatement } from "@shared/permissions.js";

export const statement = {
  ...defaultStatements,
  ...homesteadStatement,
} as const;

export const ac = createAccessControl(statement);

export const adminRole = ac.newRole({
  ...adminAc.statements,
  project: ["read", "create", "update", "delete", "control"],
  compose: ["read", "write"],
  tunnel: ["read", "create", "delete"],
  app: ["read"],
  logs: ["read"],
  stats: ["read"],
  settings: ["read", "write"],
});

export const viewerRole = ac.newRole({
  app: ["read"],
});

export const roles = { admin: adminRole, viewer: viewerRole };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/server/auth/permissions.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/shared/permissions.ts src/server/auth package.json pnpm-lock.yaml
git commit -m "feat: define admin and viewer access control roles"
```

---

### Task 6: Better-Auth instance and Fastify mount

**Files:**
- Create: `src/server/auth/index.ts`, `src/server/auth/plugin.ts`
- Modify: `src/server/db/schema.ts`, `src/server/app.ts`
- Test: `src/server/auth/plugin.test.ts`

**Interfaces:**
- Consumes: `Db`, `runMigrations`, `createDb` (Task 4); `ac`, `roles` (Task 5).
- Produces:
  - `createAuth(db: Db): Auth` from `src/server/auth/index.ts`, where `type Auth = ReturnType<typeof createAuth>`.
  - `authPlugin` — a Fastify plugin taking `{ auth: Auth }`, mounting `/api/auth/*` and decorating `request.session`.
  - `buildApp(opts: { db: Db; auth: Auth }): Promise<FastifyInstance>` — **Task 1's signature changes here**; update `src/server/index.ts` and `src/server/app.test.ts` accordingly.
  - Module augmentation adding `session: SessionWithUser | null` to `FastifyRequest`, where
    `type SessionWithUser = { user: { id: string; email: string; role: string | null | undefined } }`.

- [ ] **Step 1: Generate the Better-Auth tables**

Write `src/server/auth/index.ts` first so the CLI can read the config:

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { admin } from "better-auth/plugins";
import type { Db } from "../db/client.js";
import { ac, roles } from "./permissions.js";

export type AuthOptions = { secret: string; baseURL: string };

export function createAuth(db: Db, opts: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    plugins: [admin({ ac, roles, defaultRole: "viewer", adminRoles: ["admin"] })],
  });
}

export type Auth = ReturnType<typeof createAuth>;
```

`secret` and `baseURL` are required rather than read from ambient environment
variables, so tests construct a fully-specified instance and never depend on
`BETTER_AUTH_SECRET` being exported. Tests throughout this plan use:

```typescript
const TEST_AUTH = { secret: "test-secret-value-at-least-32-chars", baseURL: "http://localhost:7420" };
```

Then generate the schema and append it to `src/server/db/schema.ts`:

```bash
pnpm dlx @better-auth/cli generate --output src/server/db/auth-schema.ts
```

Re-export it from `schema.ts` by adding `export * from "./auth-schema.js";`, then run `pnpm drizzle-kit generate` and commit the new migration. The generated `user` table must include `role`, `banned`, `banReason`, `banExpires`, and `session` must include `impersonatedBy` — these come from the admin plugin. If they are absent, the plugin was not picked up; confirm `createAuth` is exported and re-run.

- [ ] **Step 2: Write the failing test**

`src/server/auth/plugin.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb, runMigrations, type Db } from "../db/client.js";
import { createAuth } from "./index.js";

const TEST_AUTH = { secret: "test-secret-value-at-least-32-chars", baseURL: "http://localhost:7420" };

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
  app = await buildApp({ db, auth: createAuth(db, TEST_AUTH) });
});

describe("auth plugin", () => {
  it("mounts the Better-Auth handler", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/get-session" });
    expect(res.statusCode).toBe(200);
  });

  it("leaves request.session null when unauthenticated", async () => {
    app.get("/api/_probe", async (req) => ({ hasSession: req.session !== null }));
    const res = await app.inject({ method: "GET", url: "/api/_probe" });
    expect(res.json()).toEqual({ hasSession: false });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/server/auth/plugin.test.ts`
Expected: FAIL — `buildApp` does not accept options.

- [ ] **Step 4: Write the plugin**

`src/server/auth/plugin.ts`:

```typescript
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { Auth } from "./index.js";

export type SessionWithUser = {
  user: { id: string; email: string; role: string | null | undefined };
};

declare module "fastify" {
  interface FastifyRequest {
    session: SessionWithUser | null;
  }
}

const plugin: FastifyPluginAsync<{ auth: Auth }> = async (app, { auth }) => {
  app.decorateRequest("session", null);

  app.addHook("onRequest", async (request) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    request.session = (session as SessionWithUser | null) ?? null;
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });
};

export const authPlugin = fp(plugin);
```

Install the plugin wrapper: `pnpm add fastify-plugin`.

- [ ] **Step 5: Update `buildApp` to take dependencies**

`src/server/app.ts`:

```typescript
import Fastify, { type FastifyInstance } from "fastify";
import type { Auth } from "./auth/index.js";
import { authPlugin } from "./auth/plugin.js";
import type { Db } from "./db/client.js";

export type AppDeps = { db: Db; auth: Auth };

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("db", deps.db);
  await app.register(authPlugin, { auth: deps.auth });
  app.get("/api/health", async () => ({ status: "ok" }));
  return app;
}
```

Update `src/server/app.test.ts` to construct the same dependencies as the plugin test, and update `src/server/index.ts`:

```typescript
import { buildApp } from "./app.js";
import { createAuth } from "./auth/index.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";

import { ensureSecretKey } from "./crypto/secrets.js";

const config = loadConfig(process.env);
const key = await ensureSecretKey(config.dataDir, config.secretKey);
const db = createDb(`${config.dataDir}/homestead.db`);
await runMigrations(db);
const auth = createAuth(db, {
  secret: key.toString("hex"),
  baseURL: `http://localhost:${config.port}`,
});
const app = await buildApp({ db, auth });
await app.listen({ port: config.port, host: "0.0.0.0" });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/server`
Expected: PASS — all suites including the updated `app.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: mount Better-Auth on Fastify with session decoration"
```

---

### Task 7: Single-winner first-admin bootstrap

**Files:**
- Create: `src/server/auth/bootstrap.ts`, `src/server/routes/onboarding.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/routes/onboarding.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 4), `Auth` (Task 6), `setSetting` (Task 4).
- Produces:
  - `claimAdminBootstrap(db: Db): Promise<boolean>` — returns `true` for exactly one caller, ever.
  - `releaseAdminBootstrap(db: Db): Promise<void>` — undoes a claim when admin creation fails.
  - Route `POST /api/onboarding/admin`.

**Why a sentinel row rather than a transaction:** Better-Auth performs the user insert through its own adapter, so it cannot be enrolled in a Drizzle transaction that also counts users. Instead the claim is an `INSERT … ON CONFLICT DO NOTHING` of a unique sentinel key. SQLite makes that atomic, so exactly one concurrent request wins the insert and proceeds. This gives the same guarantee the spec requires without wrapping a third-party call in a transaction.

- [ ] **Step 1: Write the failing test**

`src/server/routes/onboarding.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, runMigrations, type Db } from "../db/client.js";
import { user } from "../db/schema.js";

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;

const body = { email: "admin@example.com", name: "Admin", password: "correct-horse-battery" };
const TEST_AUTH = { secret: "test-secret-value-at-least-32-chars", baseURL: "http://localhost:7420" };

beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
  app = await buildApp({ db, auth: createAuth(db, TEST_AUTH) });
});

describe("POST /api/onboarding/admin", () => {
  it("creates the first user with the admin role", async () => {
    const res = await app.inject({ method: "POST", url: "/api/onboarding/admin", payload: body });
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("admin");
  });

  it("refuses a second call", async () => {
    await app.inject({ method: "POST", url: "/api/onboarding/admin", payload: body });
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: { ...body, email: "attacker@example.com" },
    });
    expect(res.statusCode).toBe(409);
    expect((await db.select({ n: count() }).from(user))[0]?.n).toBe(1);
  });

  it("admits exactly one of many concurrent callers", async () => {
    const attempts = Array.from({ length: 8 }, (_, i) =>
      app.inject({
        method: "POST",
        url: "/api/onboarding/admin",
        payload: { ...body, email: `race${i}@example.com` },
      }),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect((await db.select({ n: count() }).from(user))[0]?.n).toBe(1);
  });

  it("rejects a weak password without consuming the claim", async () => {
    const weak = await app.inject({
      method: "POST",
      url: "/api/onboarding/admin",
      payload: { ...body, password: "short" },
    });
    expect(weak.statusCode).toBe(400);
    const good = await app.inject({ method: "POST", url: "/api/onboarding/admin", payload: body });
    expect(good.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/routes/onboarding.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Write the bootstrap claim**

`src/server/auth/bootstrap.ts`:

```typescript
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

const CLAIM_KEY = "admin_bootstrap_claimed";

export async function claimAdminBootstrap(db: Db): Promise<boolean> {
  const inserted = await db
    .insert(settings)
    .values({ key: CLAIM_KEY, value: new Date().toISOString() })
    .onConflictDoNothing()
    .returning({ key: settings.key });
  return inserted.length === 1;
}

export async function releaseAdminBootstrap(db: Db): Promise<void> {
  await db.delete(settings).where(eq(settings.key, CLAIM_KEY));
}
```

- [ ] **Step 4: Write the route**

`src/server/routes/onboarding.ts`:

```typescript
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth/index.js";
import { claimAdminBootstrap, releaseAdminBootstrap } from "../auth/bootstrap.js";
import type { Db } from "../db/client.js";
import { user } from "../db/schema.js";

const bodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(12),
});

export const onboardingRoutes: FastifyPluginAsync<{ db: Db; auth: Auth }> = async (
  app,
  { db, auth },
) => {
  app.post("/api/onboarding/admin", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }

    if (!(await claimAdminBootstrap(db))) {
      return reply.status(409).send({ error: "already_initialised" });
    }

    try {
      const created = await auth.api.signUpEmail({ body: parsed.data });
      await db.update(user).set({ role: "admin" }).where(eq(user.id, created.user.id));
      return reply.send({ ok: true });
    } catch (err) {
      await releaseAdminBootstrap(db);
      request.log.error({ err }, "admin bootstrap failed");
      return reply.status(400).send({ error: "signup_failed" });
    }
  });
};
```

Register it in `src/server/app.ts` after the auth plugin:

```typescript
await app.register(onboardingRoutes, { db: deps.db, auth: deps.auth });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/server/routes/onboarding.test.ts`
Expected: PASS (4 tests). If the concurrency test admits more than one, the claim is not atomic — confirm `onConflictDoNothing().returning()` is used and that `settings.key` is the primary key.

- [ ] **Step 6: Commit**

```bash
git add src/server/auth/bootstrap.ts src/server/routes src/server/app.ts
git commit -m "feat: add single-winner first-admin bootstrap route"
```

---

### Task 8: Permission guard

**Files:**
- Create: `src/server/auth/guard.ts`
- Test: `src/server/auth/guard.test.ts`

**Interfaces:**
- Consumes: `request.session` (Task 6); `roles` (Task 5).
- Produces: `requirePermission(permission: Record<string, string[]>): preHandler` — replies `401` when there is no session, `403` when the role lacks the permission, otherwise passes through.

- [ ] **Step 1: Write the failing test**

`src/server/auth/guard.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { requirePermission } from "./guard.js";
import type { SessionWithUser } from "./plugin.js";

function appWithSession(session: SessionWithUser | null): FastifyInstance {
  const app = Fastify();
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req) => {
    req.session = session;
  });
  app.get(
    "/guarded",
    { preHandler: requirePermission({ compose: ["write"] }) },
    async () => ({ ok: true }),
  );
  return app;
}

const asRole = (role: string): SessionWithUser => ({
  user: { id: "u1", email: "u@example.com", role },
});

describe("requirePermission", () => {
  it("returns 401 with no session", async () => {
    const res = await appWithSession(null).inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a viewer", async () => {
    const res = await appWithSession(asRole("viewer")).inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(403);
  });

  it("allows an admin", async () => {
    const res = await appWithSession(asRole("admin")).inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 for an unknown role rather than failing open", async () => {
    const res = await appWithSession(asRole("wizard")).inject({ method: "GET", url: "/guarded" });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/auth/guard.test.ts`
Expected: FAIL — cannot resolve `./guard.js`.

- [ ] **Step 3: Write the guard**

`src/server/auth/guard.ts`:

```typescript
import type { preHandlerHookHandler } from "fastify";
import { roles } from "./permissions.js";

type RoleName = keyof typeof roles;

function isRoleName(value: string | null | undefined): value is RoleName {
  return value === "admin" || value === "viewer";
}

export function requirePermission(
  permission: Record<string, string[]>,
): preHandlerHookHandler {
  return async (request, reply) => {
    const session = request.session;
    if (!session) return reply.status(401).send({ error: "unauthenticated" });

    const roleName = session.user.role;
    if (!isRoleName(roleName)) return reply.status(403).send({ error: "forbidden" });

    // biome-ignore lint/suspicious/noExplicitAny: statement shape is dynamic per call site
    const decision = roles[roleName].authorize(permission as any);
    if (!decision.success) return reply.status(403).send({ error: "forbidden" });
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/auth/guard.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/auth/guard.ts src/server/auth/guard.test.ts
git commit -m "feat: add role-based route permission guard"
```

---

### Task 9: Startup preflight checks

**Files:**
- Create: `src/server/preflight.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/preflight.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2).
- Produces:
  - `type CheckResult = { id: string; label: string; ok: boolean; detail: string; blocking: boolean }`
  - `type Check = { id: string; label: string; blocking: boolean; run: () => Promise<Omit<CheckResult, "id" | "label" | "blocking">> }`
  - `runChecks(checks: Check[]): Promise<CheckResult[]>`
  - `isNetworkFilesystem(path: string, mountTable: string): boolean` — pure, takes `/proc/mounts` content so it is testable.
  - `dataDirChecks(config: Config): Check[]`

Plans 2 and 5 register Docker and path-translation checks against this same registry.

- [ ] **Step 1: Write the failing test**

`src/server/preflight.test.ts`:

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirChecks, isNetworkFilesystem, runChecks } from "./preflight.js";
import { loadConfig } from "./config.js";

const MOUNTS = [
  "/dev/sda1 / ext4 rw,relatime 0 0",
  "nas:/export/data /mnt/nas nfs4 rw 0 0",
  "//server/share /mnt/smb cifs rw 0 0",
  "/dev/sdb1 /volume2 btrfs rw 0 0",
].join("\n");

describe("isNetworkFilesystem", () => {
  it("flags an NFS mount", () => {
    expect(isNetworkFilesystem("/mnt/nas/homestead", MOUNTS)).toBe(true);
  });

  it("flags a CIFS mount", () => {
    expect(isNetworkFilesystem("/mnt/smb/homestead", MOUNTS)).toBe(true);
  });

  it("accepts local btrfs", () => {
    expect(isNetworkFilesystem("/volume2/docker/.homestead", MOUNTS)).toBe(false);
  });

  it("picks the longest matching mount point, not the first", () => {
    expect(isNetworkFilesystem("/volume2", MOUNTS)).toBe(false);
    expect(isNetworkFilesystem("/mnt/nas", MOUNTS)).toBe(true);
  });
});

describe("runChecks", () => {
  it("reports a writable data dir as ok", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hs-pre-"));
    const config = loadConfig({ HOMESTEAD_DATA: dir, HOMESTEAD_PROJECTS: dir });
    const results = await runChecks(dataDirChecks(config));
    expect(results.find((r) => r.id === "data_dir_writable")?.ok).toBe(true);
  });

  it("reports an unwritable data dir as a blocking failure", async () => {
    const config = loadConfig({ HOMESTEAD_DATA: "/proc/nope", HOMESTEAD_PROJECTS: "/tmp" });
    const results = await runChecks(dataDirChecks(config));
    const check = results.find((r) => r.id === "data_dir_writable");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
  });

  it("does not let one failing check abort the others", async () => {
    const results = await runChecks([
      { id: "boom", label: "Boom", blocking: false, run: async () => { throw new Error("x"); } },
      { id: "fine", label: "Fine", blocking: false, run: async () => ({ ok: true, detail: "" }) },
    ]);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === "boom")?.ok).toBe(false);
    expect(results.find((r) => r.id === "fine")?.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server/preflight.test.ts`
Expected: FAIL — cannot resolve `./preflight.js`.

- [ ] **Step 3: Write the implementation**

`src/server/preflight.ts`:

```typescript
import { access, constants, readFile } from "node:fs/promises";
import type { Config } from "./config.js";

const NETWORK_FSTYPES = new Set([
  "nfs", "nfs4", "cifs", "smbfs", "smb3", "fuse.sshfs", "afs", "9p",
]);

export type CheckResult = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
};

export type Check = {
  id: string;
  label: string;
  blocking: boolean;
  run: () => Promise<{ ok: boolean; detail: string }>;
};

export function isNetworkFilesystem(path: string, mountTable: string): boolean {
  let best: { point: string; type: string } | undefined;
  for (const line of mountTable.split("\n")) {
    const [, point, type] = line.split(/\s+/);
    if (!point || !type) continue;
    if (path === point || path.startsWith(point === "/" ? "/" : `${point}/`)) {
      if (!best || point.length > best.point.length) best = { point, type };
    }
  }
  return best ? NETWORK_FSTYPES.has(best.type) : false;
}

export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (c) => {
      try {
        const { ok, detail } = await c.run();
        return { id: c.id, label: c.label, blocking: c.blocking, ok, detail };
      } catch (err) {
        return {
          id: c.id,
          label: c.label,
          blocking: c.blocking,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

export function dataDirChecks(config: Config): Check[] {
  return [
    {
      id: "data_dir_writable",
      label: "Data directory is writable",
      blocking: true,
      run: async () => {
        await access(config.dataDir, constants.W_OK);
        return { ok: true, detail: config.dataDir };
      },
    },
    {
      id: "data_dir_local_fs",
      label: "Data directory is on a local filesystem",
      blocking: true,
      run: async () => {
        const mounts = await readFile("/proc/mounts", "utf8").catch(() => "");
        if (!mounts) return { ok: true, detail: "mount table unavailable; skipped" };
        const networked = isNetworkFilesystem(config.dataDir, mounts);
        return {
          ok: !networked,
          detail: networked
            ? `${config.dataDir} is on a network filesystem; SQLite locking is unreliable there`
            : config.dataDir,
        };
      },
    },
    {
      id: "projects_dir_readable",
      label: "Projects directory is readable",
      blocking: false,
      run: async () => {
        await access(config.projectsDir, constants.R_OK);
        return { ok: true, detail: config.projectsDir };
      },
    },
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server/preflight.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Wire preflight into startup**

In `src/server/index.ts`, insert this immediately after `loadConfig` and
**before** the existing `ensureSecretKey` call — checks must run before anything
touches the data directory:

```typescript
import { dataDirChecks, runChecks } from "./preflight.js";

const results = await runChecks(dataDirChecks(config));
for (const r of results) {
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
}
const blocked = results.filter((r) => !r.ok && r.blocking);
if (blocked.length > 0) {
  console.error(`\nStartup blocked by ${blocked.length} failed check(s).`);
  process.exit(1);
}
```

- [ ] **Step 6: Run the whole suite and lint**

Run: `pnpm vitest run && pnpm biome check .`
Expected: all suites PASS, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/preflight.ts src/server/preflight.test.ts src/server/index.ts
git commit -m "feat: add startup preflight checks with network filesystem detection"
```

---

### Task 10: Web shell with setup, login, and protected routing

**Files:**
- Create: `src/web/index.html`, `vite.config.ts`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/index.css`
- Create: `src/web/lib/auth-client.ts`, `src/web/components/ProtectedRoute.tsx`
- Create: `src/web/routes/Setup.tsx`, `src/web/routes/Login.tsx`, `src/web/routes/Dashboard.tsx`
- Create: `src/server/routes/status.ts`
- Test: `e2e/onboarding.spec.ts`, `playwright.config.ts`

**Interfaces:**
- Consumes: `POST /api/onboarding/admin` (Task 7); Better-Auth endpoints under `/api/auth/*` (Task 6).
- Produces:
  - `GET /api/status` → `{ initialised: boolean }` — drives the redirect between `/setup` and `/login`. Unauthenticated by necessity; it leaks only whether an admin exists.
  - `authClient` with `signIn`, `signOut`, `useSession`.

- [ ] **Step 1: Install web dependencies**

```bash
pnpm add react react-dom react-router-dom @tanstack/react-query
pnpm add -D @vitejs/plugin-react vite tailwindcss @tailwindcss/vite @types/react @types/react-dom @playwright/test
pnpm exec playwright install chromium
```

- [ ] **Step 2: Add the status route**

`src/server/routes/status.ts`:

```typescript
import { count } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../db/client.js";
import { user } from "../db/schema.js";

export const statusRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get("/api/status", async () => {
    const [row] = await db.select({ n: count() }).from(user);
    return { initialised: (row?.n ?? 0) > 0 };
  });
};
```

Register it in `buildApp` alongside `onboardingRoutes`.

- [ ] **Step 3: Write `vite.config.ts` and `index.html`**

`vite.config.ts`:

```typescript
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) },
  },
  server: { proxy: { "/api": "http://localhost:7420" } },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
```

`src/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Homestead</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

`src/web/index.css`:

```css
@import "tailwindcss";
```

- [ ] **Step 4: Write the auth client and routes**

`src/web/lib/auth-client.ts`:

```typescript
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: [adminClient()] });
export const { signIn, signOut, useSession } = authClient;
```

`src/web/components/ProtectedRoute.tsx`:

```tsx
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "../lib/auth-client.js";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession();
  if (isPending) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!data) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

`src/web/routes/Setup.tsx`:

```tsx
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

export function Setup() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/onboarding/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        password: form.get("password"),
      }),
    });
    if (res.ok) navigate("/login");
    else setError("Could not create the administrator account. Passwords need 12+ characters.");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Welcome to Homestead</h1>
      <p className="text-slate-500">Create the administrator account.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input name="name" placeholder="Name" required className="rounded border p-2" />
        <input name="email" type="email" placeholder="Email" required className="rounded border p-2" />
        <input name="password" type="password" placeholder="Password" required minLength={12} className="rounded border p-2" />
        <button type="submit" className="rounded bg-slate-900 p-2 text-white">Create account</button>
      </form>
      {error && <p role="alert" className="text-red-600">{error}</p>}
    </main>
  );
}
```

`src/web/routes/Login.tsx`:

```tsx
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signIn } from "../lib/auth-client.js";

export function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (res.error) setError("Incorrect email or password.");
    else navigate("/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input name="email" type="email" placeholder="Email" required className="rounded border p-2" />
        <input name="password" type="password" placeholder="Password" required className="rounded border p-2" />
        <button type="submit" className="rounded bg-slate-900 p-2 text-white">Sign in</button>
      </form>
      {error && <p role="alert" className="text-red-600">{error}</p>}
    </main>
  );
}
```

`src/web/routes/Dashboard.tsx`:

```tsx
import { useSession } from "../lib/auth-client.js";

export function Dashboard() {
  const { data } = useSession();
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-slate-500">Signed in as {data?.user.email}</p>
    </main>
  );
}
```

`src/web/App.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute.js";
import { Dashboard } from "./routes/Dashboard.js";
import { Login } from "./routes/Login.js";
import { Setup } from "./routes/Setup.js";

export function App() {
  const { data, isPending } = useQuery({
    queryKey: ["status"],
    queryFn: async () => (await fetch("/api/status")).json() as Promise<{ initialised: boolean }>,
  });

  if (isPending) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!data?.initialised) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Navigate to="/login" replace />} />
      <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
    </Routes>
  );
}
```

`src/web/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import "./index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 5: Write the failing e2e test**

`playwright.config.ts`:

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:5173" },
  webServer: [
    {
      command: "pnpm dev",
      port: 7420,
      env: {
        HOMESTEAD_DATA: "/tmp/homestead-e2e",
        HOMESTEAD_PROJECTS: "/tmp/homestead-e2e/stacks",
      },
      reuseExistingServer: false,
    },
    { command: "pnpm dev:web", port: 5173, reuseExistingServer: false },
  ],
});
```

`e2e/onboarding.spec.ts`:

```typescript
import { rm, mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.beforeAll(async () => {
  await rm("/tmp/homestead-e2e", { recursive: true, force: true });
  await mkdir("/tmp/homestead-e2e/stacks", { recursive: true });
});

test("first run creates an admin, then signs in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Homestead" })).toBeVisible();

  await page.getByPlaceholder("Name").fill("Admin");
  await page.getByPlaceholder("Email").fill("admin@example.com");
  await page.getByPlaceholder("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByPlaceholder("Email").fill("admin@example.com");
  await page.getByPlaceholder("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("admin@example.com")).toBeVisible();
});

test("setup is closed once an admin exists", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
```

- [ ] **Step 6: Run the e2e test to verify it fails**

```bash
pnpm pkg set scripts.dev:web="vite"
pnpm pkg set scripts.e2e="playwright test"
pnpm e2e
```

Expected: FAIL — the web server has no routes yet, or the heading is absent.

- [ ] **Step 7: Run the e2e test to verify it passes**

Run: `pnpm e2e`
Expected: both tests PASS. The second test relies on the first having created an admin, so they must run in file order — Playwright does this by default within a file.

- [ ] **Step 8: Run everything and commit**

```bash
pnpm vitest run && pnpm biome check . && pnpm e2e
git add -A
git commit -m "feat: add web shell with first-run setup, login, and protected routing"
```

---

## Definition of Done

- `pnpm vitest run` passes: config, secrets, settings, permissions, auth plugin, onboarding, guard, preflight.
- `pnpm e2e` passes: first-run setup → login → dashboard, and setup closes afterwards.
- `pnpm biome check .` is clean.
- A fresh checkout with `HOMESTEAD_DATA` on a network mount refuses to start with a named check failure.
- Eight concurrent calls to `POST /api/onboarding/admin` create exactly one user.

## Handoff to Plan 2

Plan 2 (Projects & Docker execution) consumes:
- `buildApp({ db, auth })` — add routes here.
- `requirePermission({ compose: ["write"] })` — guard every project mutation.
- `runChecks` / `Check` — register `docker_reachable`, `compose_v2_present`, and the path-translation parity check from spec §12.3.
- `Config.projectsDir` and `Config.projectsHostDir` — the override-file translation in spec §7.2.
- `encrypt` / `decrypt` and the key from `ensureSecretKey` — for Plan 3's Cloudflare credentials.
