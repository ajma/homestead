# Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the repository into a container someone can run on their NAS.

**Architecture:** One Node process serves the API and the built SPA. A multi-stage Alpine image carries its own Compose v2. Startup checks warn without blocking, and surface in the UI because a log line on a headless box is not a warning.

**Tech Stack:** TypeScript ESM, Fastify 5, tsup, Vite, Docker buildx, GitHub Actions, Vitest, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-09-07-packaging-design.md`

## Global Constraints

- **`src/server/auth/permissions.ts` and `src/shared/permissions.ts` must not change at all in this plan.** No task here needs a new permission. Homestead holds the Docker socket, so an admin is root-equivalent on the host; verify those files are untouched before finishing any task.
- **Every task that consumes another task's output needs a test that drives the real producer.** The previous plan produced five Criticals and every one of them sat between two individually-correct modules whose tests each mocked the other. Where this plan crosses a boundary — checks feeding the API, the API feeding the banner — the task brief names the producer that must be driven for real. This is not a preamble to skim; it is a per-task requirement.
- **No test may start a container, reach the network, open a socket, or use a real timer.** Every startup check takes an injected probe, so each failure path is exercised without arranging the failure.
- **Check what already exists before creating a file.** This plan was drafted as though Homestead had no startup checks; it has had them since `cf096c9`. The first attempt at Task 3 built a parallel system and deleted eleven existing tests. Before creating any file this plan lists as "Create", confirm it does not already exist, and read its neighbours.
- `src/web/**` and `e2e/**` must never import from `src/server/**`. `src/shared/**` is browser-safe.
- Import `test` from `e2e/support/fixtures.js`, never `@playwright/test`.
- **Lint baseline is 0 errors and exactly 6 warnings.** Biome counts formatting violations as errors.
- **Never add a `Co-Authored-By` trailer or any AI-attribution line to a commit.**
- **Commit a fix before mutating the file it lives in** — `git checkout <file>` discards uncommitted work there.
- **Read the target line out of the file before writing any mutation pattern**, compare a checksum before and after, and mutate a condition or return value rather than a string literal. Multi-line patterns fail silently on invisible whitespace; anchor single-line edits to a `grep -n` result.
- Run each gate and read its **actual exit status**. Vitest does not typecheck. Five gate claims on the previous plan were wrong.
- Never amend a commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `tsup.config.ts` | Server bundle: ESM, Node target, `dist/server`. |
| `vite.config.ts` | Web build output to `dist/web` (modify). |
| `src/server/app.ts` | Serve the built SPA alongside the API (modify). |
| `src/server/preflight.ts` | The startup checks — **already exists**; gains severity and a port check (modify). |
| `src/server/docker/preflight.ts` | Docker and Compose checks — **already exists** (modify). |
| `src/server/index.ts` | Run the checks, log them, hand them to the app (modify). |
| `src/server/routes/preflight.ts` | Expose the check results to admins. |
| `src/shared/preflight.ts` | Browser-safe `PreflightResult` and `Severity`. |
| `src/web/components/PreflightBanner.tsx` | The persistent warning. |
| `Dockerfile`, `.dockerignore` | The image. |
| `compose.example.yaml` | What a user pastes. |
| `.github/workflows/release.yml` | Multi-arch build and publish on a tag. |
| `README.md` | Install, configure, and the bridged-networking warning. |

---

## Task 1: Build the server and the web

**Files:**
- Create: `tsup.config.ts`
- Modify: `vite.config.ts`, `package.json`
- Test: none — verified by running the build

**Interfaces:**
- Produces: `pnpm build` emitting `dist/server/index.js` and `dist/web/index.html`.

- [ ] **Step 1: Add the server bundle config**

`tsup.config.ts`:

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/index.ts"],
  outDir: "dist/server",
  format: ["esm"],
  platform: "node",
  target: "node24",
  // Bundle our own code; leave node_modules external so native bindings
  // (libSQL) are resolved at runtime rather than inlined.
  noExternal: [/^@shared\//],
  clean: true,
  sourcemap: true,
});
```

- [ ] **Step 2: Point Vite's output at `dist/web`**

Add to `vite.config.ts`'s config object:

```typescript
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
```

- [ ] **Step 3: Add the scripts**

```json
    "build": "pnpm build:server && pnpm build:web",
    "build:server": "tsup",
    "build:web": "vite build",
    "start": "node dist/server/index.js",
```

- [ ] **Step 4: Run it and check both artifacts exist**

```bash
pnpm build
test -f dist/server/index.js && echo "server ok"
test -f dist/web/index.html && echo "web ok"
```

Both must print. Report the output verbatim.

- [ ] **Step 5: Confirm `dist/` is ignored**

`git check-ignore -q dist && echo IGNORED`. If it is not, add it to `.gitignore` and commit that first — a committed `dist/` would be noise in every future diff.

- [ ] **Step 6: Commit**

```bash
git add tsup.config.ts vite.config.ts package.json .gitignore
git commit -m "build: bundle the server and the web app"
```

---

## Task 2: Serve the SPA from the API process

**Files:**
- Modify: `src/server/app.ts`, `package.json`
- Test: `src/server/app.test.ts`

**Interfaces:**
- Consumes: `dist/web` from Task 1.
- Produces: `buildApp` gains an optional `webDir?: string`; when set, the app serves those files and falls back to `index.html` for unknown non-API paths.

- [ ] **Step 1: Write the failing tests**

```typescript
it("serves index.html for an unknown path so client routing works", async () => {
  const webDir = await mkdtemp(join(tmpdir(), "hs-web-"));
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>hs</title>");
  const app = await buildApp({ ...baseDeps, webDir });
  const res = await app.inject({ method: "GET", url: "/exposures" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("<title>hs</title>");
  await app.close();
  await rm(webDir, { recursive: true, force: true });
});

it("does not swallow an unknown API route", async () => {
  // The SPA fallback must not turn a missing endpoint into an HTML page —
  // a fetch would then fail on JSON parsing rather than on a 404.
  const webDir = await mkdtemp(join(tmpdir(), "hs-web-"));
  await writeFile(join(webDir, "index.html"), "<!doctype html>");
  const app = await buildApp({ ...baseDeps, webDir });
  const res = await app.inject({ method: "GET", url: "/api/nope" });
  expect(res.statusCode).toBe(404);
  expect(res.headers["content-type"]).not.toContain("text/html");
  await app.close();
  await rm(webDir, { recursive: true, force: true });
});

it("works with no webDir, as in development", async () => {
  const app = await buildApp(baseDeps);
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  await app.close();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/app.test.ts`
Expected: FAIL — `webDir` is not accepted.

- [ ] **Step 3: Implement**

Add `@fastify/static` (v8, which matches Fastify 5). Register it only when `webDir` is provided, and add a `setNotFoundHandler` that returns `index.html` **only** for requests whose path does not start with `/api/`. Everything under `/api/` keeps its JSON 404.

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run src/server && pnpm typecheck && pnpm lint`

```bash
git add src/server/app.ts src/server/app.test.ts package.json
git commit -m "feat(server): serve the built SPA from the API process"
```

---

## Task 3: Evolve the existing startup checks

**Homestead already has startup checks.** `src/server/preflight.ts` (from `cf096c9`) and `src/server/docker/preflight.ts` already cover five of this spec's six: Docker reachable, Compose v2, data dir writable, data dir on a local filesystem, projects dir readable. `index.ts` already runs them and logs each result. The `/proc/mounts` parser already handles octal escapes and longest-prefix mount matching, with tests for both.

**Do not build a second checks system beside it.** A first attempt at this task did, and deleted eleven of the existing tests in the process. This task *changes* what is there.

Three things are actually missing, and they are the whole task:

1. **Nothing blocks startup.** Today `index.ts` calls `process.exit(1)` when a `blocking` check fails. The spec chose warn-and-continue so a misconfigured instance still comes up far enough to be fixed through its own UI.
2. **No severity.** The network-filesystem failure is different in kind — it corrupts silently where every other failure produces visible errors — and the UI has to be able to say so.
3. **No port check**, and no browser-safe result type for the UI to consume.

**Files:**
- Create: `src/shared/preflight.ts`
- Modify: `src/server/preflight.ts`, `src/server/docker/preflight.ts`, `src/server/index.ts`
- Test: `src/server/preflight.test.ts`, `src/server/docker/preflight.test.ts` (extend — **delete nothing**)

**Interfaces:**
- Produces:
  ```typescript
  // src/shared/preflight.ts — browser-safe: types only, no node: imports
  export type Severity = "warning" | "danger";
  export type PreflightResult = {
    id: string;
    label: string;
    ok: boolean;
    detail: string;
    severity: Severity;
  };

  // src/server/preflight.ts
  export type Check = {
    id: string;
    label: string;
    severity: Severity;             // replaces `blocking: boolean`
    run: () => Promise<{ ok: boolean; detail: string }>;
  };
  export function runChecks(checks: Check[]): Promise<PreflightResult[]>;
  export function dataDirChecks(config: Config): Check[];
  export function portCheck(
    port: number,
    probe?: (port: number) => Promise<boolean>,
  ): Check;
  ```

- [ ] **Step 1: Replace `blocking` with `severity`**

`CheckResult` goes away; `runChecks` returns `PreflightResult[]` from `@shared/preflight.js` so the web can import the same type. Every existing check becomes `severity: "warning"` **except** `data_dir_local_fs`, which becomes `"danger"`.

Update the existing tests to match — the one named "reports the daemon as a blocking failure when it cannot be reached" and its siblings assert on `blocking`. Change what they assert, and keep every case they cover.

- [ ] **Step 2: Add the port check**

Follow the injection convention `dockerChecks(run: Runner = runDocker)` already establishes: a factory taking an optional probe that defaults to the real one, so tests inject and never bind a port.

```typescript
export function portCheck(
  port: number,
  probe: (port: number) => Promise<boolean> = realPortFree,
): Check {
  return {
    id: "port_free",
    label: "Listen port is available",
    severity: "warning",
    run: async () => {
      const free = await probe(port);
      return {
        ok: free,
        // Startup fails on its own when the port is taken. The check exists to
        // name which port, because the raw EADDRINUSE does not.
        detail: free ? `port ${port}` : `port ${port} is already in use`,
      };
    },
  };
}
```

`realPortFree` opens a throwaway `net.createServer()`, listens, and closes — it lives in this file but is only ever reached through the default argument.

- [ ] **Step 3: Write the failing tests for the port check**

```typescript
describe("portCheck", () => {
  it("passes when the port is free", async () => {
    const r = await portCheck(7420, async () => true).run();
    expect(r.ok).toBe(true);
  });

  it("names the port when it is taken", async () => {
    // The raw EADDRINUSE that follows does not say which port, and on a NAS
    // the operator is reading a log, not a stack trace.
    const r = await portCheck(7420, async () => false).run();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("7420");
  });

  it("becomes a failed check rather than a crash when the probe throws", async () => {
    const check = portCheck(7420, async () => {
      throw new Error("boom");
    });
    const [result] = await runChecks([check]);
    expect(result?.ok).toBe(false);
  });
});
```

The third case relies on `runChecks` already catching per-check — confirm that is still true after Step 1 rather than assuming it.

- [ ] **Step 4: Add the missing severity tests**

```typescript
it("marks the network-filesystem failure as danger, not warning", async () => {
  // Every other failure produces visible errors. This one corrupts quietly,
  // so it is the only one whose severity differs.
  const [result] = await runChecks([
    {
      id: "data_dir_local_fs",
      label: "Data directory is on a local filesystem",
      severity: "danger" as const,
      run: async () => ({ ok: false, detail: "on nfs4" }),
    },
  ]);
  expect(result?.severity).toBe("danger");
});

it("keeps every other check at warning severity", () => {
  const config = { dataDir: "/data", projectsDir: "/stacks" } as Config;
  const others = [...dataDirChecks(config), ...dockerChecks()].filter(
    (c) => c.id !== "data_dir_local_fs",
  );
  expect(others.length).toBeGreaterThan(0);
  for (const c of others) {
    expect(c.severity, `${c.id} should be a warning`).toBe("warning");
  }
});
```

The existing suite already covers unrecognised filesystem types (`accepts local btrfs`) and an unavailable mount table. **Verify those two still pass and leave them alone** — a false corruption warning would teach people to ignore the banner, which is the one outcome worse than not checking.

- [ ] **Step 5: Stop blocking startup**

In `src/server/index.ts`, delete the `blocked` filter and its `process.exit(1)`. Keep the per-check log line, and log a `danger` failure at error level rather than log level. Leave everything else in `main()` alone — Task 4 does the wiring.

- [ ] **Step 6: Prove the severity test discriminates**

Change `data_dir_local_fs` to `severity: "warning"`, confirm the danger test fails, and revert. Read the target line out of the file before editing and build the change from what is printed, not from memory; compare the file before and after to confirm you actually restored it.

- [ ] **Step 7: Verify no test was lost**

```bash
git show 04202f4:src/server/preflight.test.ts | grep -c "  it("
grep -c "  it(" src/server/preflight.test.ts
```

The second number must be **greater than** the first. Report both.

- [ ] **Step 8: Commit**

```bash
git add src/shared/preflight.ts src/server/preflight.ts src/server/preflight.test.ts src/server/docker/preflight.ts src/server/docker/preflight.test.ts src/server/index.ts
git commit -m "feat(server): give startup checks a severity and stop them blocking"
```

---

## Task 4: Expose the check results to admins

**Files:**
- Create: `src/server/routes/preflight.ts`, `src/server/routes/preflight.test.ts`
- Modify: `src/server/app.ts`, `src/server/index.ts`

**Interfaces:**
- Consumes: `PreflightResult` and `runChecks` (Task 3).
- Produces: `buildApp` gains optional `preflight?: PreflightResult[]`; `GET /api/preflight` → `{ checks: PreflightResult[] }`, gated on `requirePermission({ settings: ["read"] })`.

**`buildApp` takes already-computed results, not probes.** `index.ts` runs the checks once at startup — it already does — and hands the array in. Absent the option, `buildApp` holds `[]` and the route returns an empty list. Roughly fifteen existing test files call `buildApp`; none of them may end up shelling out to `docker version` or binding port 7420, and passing results rather than probes makes that true by construction rather than by discipline.

**Do not put this on `/api/status`.** That route is unauthenticated — the login page reads it to decide whether setup is needed. Filesystem types, the listen port and whether the Docker socket is mounted are infrastructure detail, and hanging them off a pre-auth endpoint hands them to anyone who can reach the box.

`settings: ["read"]` is admin-only in `permissions.ts` today, which is the correct audience: every remedy here is an admin action. **Use that existing statement — this task does not change `permissions.ts`.** Viewers get a 403 and simply see no banner.

- [ ] **Step 1: Write the failing tests**

Follow the arrangement in `src/server/routes/devices.test.ts` for building an app and obtaining admin and viewer cookies.

```typescript
const failing: PreflightResult[] = [
  {
    id: "data_dir_local_fs",
    label: "Data directory is on a local filesystem",
    ok: false,
    detail: "/data is on a network filesystem",
    severity: "danger",
  },
];

it("returns the results it was given", async () => {
  const app = await buildApp({ ...baseDeps, preflight: failing });
  const res = await app.inject({
    method: "GET",
    url: "/api/preflight",
    headers: { cookie: adminCookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().checks).toEqual(failing);
});

it("returns an empty list when no checks were run", async () => {
  const app = await buildApp(baseDeps);
  const res = await app.inject({
    method: "GET",
    url: "/api/preflight",
    headers: { cookie: adminCookie },
  });
  expect(res.json().checks).toEqual([]);
});

it("refuses a viewer", async () => {
  // Homestead holds the Docker socket. Its environment is not viewer business.
  const app = await buildApp({ ...baseDeps, preflight: failing });
  const res = await app.inject({
    method: "GET",
    url: "/api/preflight",
    headers: { cookie: viewerCookie },
  });
  expect(res.statusCode).toBe(403);
});

it("refuses an anonymous request", async () => {
  const app = await buildApp({ ...baseDeps, preflight: failing });
  const res = await app.inject({ method: "GET", url: "/api/preflight" });
  expect(res.statusCode).toBe(401);
});

it("leaves /api/status unauthenticated and free of preflight detail", async () => {
  // The login page reads /api/status before anyone has signed in.
  const app = await buildApp({ ...baseDeps, preflight: failing });
  const res = await app.inject({ method: "GET", url: "/api/status" });
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toContain("network filesystem");
  expect(res.json()).not.toHaveProperty("preflight");
});
```

Clean up each app with the same `onTestFinished` convention Task 2 adopted, so a failing assertion does not leak a handle.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/routes/preflight.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Implement**

Register the route the way `devices.ts` registers its own, gated on `requirePermission({ settings: ["read"] })`.

- [ ] **Step 4: Wire `index.ts`**

`main()` already computes `results`. Add the port check to that array and pass `preflight: results` into `buildApp`. Take the port from the same config the server listens on — a check against a hardcoded 7420 while the server binds `$PORT` would report on the wrong port.

- [ ] **Step 5: Prove the viewer test discriminates**

Change the gate to `app: ["read"]`, confirm the viewer test fails, and revert. A permission gate nobody has watched fail is a permission gate nobody has tested. Report the failure message.

- [ ] **Step 6: Verify permissions are untouched**

```bash
git diff --quiet HEAD -- src/server/auth/permissions.ts src/shared/permissions.ts && echo UNCHANGED
```

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/preflight.ts src/server/routes/preflight.test.ts src/server/app.ts src/server/index.ts
git commit -m "feat(server): report the startup checks to admins"
```

---

## Task 5: The banner

**Files:**
- Create: `src/web/components/PreflightBanner.tsx`, `src/web/components/preflight-banner.test.tsx`
- Modify: `src/web/components/AppShell.tsx`, `src/web/lib/queries.ts`

**Interfaces:**
- Consumes: `PreflightResult` from `src/shared/preflight.ts`, and `GET /api/preflight` → `{ checks: PreflightResult[] }` from Task 4.
- Produces: `<PreflightBanner checks={...} />` — presentational, matching the prop-taking style of `HistoryBar`. `AppShell` owns the query and passes the array down.

The real shape, already in the repo:

```typescript
export type Severity = "warning" | "danger";
export type PreflightResult = {
  id: string;
  label: string;   // "Data directory is on a local filesystem"
  ok: boolean;
  detail: string;  // "/data is on a network filesystem; SQLite locking is unreliable there"
  severity: Severity;
};
```

**This task consumes Task 4's payload.** Type the fixtures as `PreflightResult[]` — imported, not hand-rolled — so a change to the contract fails compilation rather than passing a stale test.

The banner belongs inside `AppShell`. Login sits **outside** `AppShell` in `src/web/App.tsx`, so placement alone keeps it off the login screen; no test needs to assert that.

Show both `label` and `detail` per failed check. The label alone ("Data directory is on a local filesystem") does not say what to do; the detail carries the path and the consequence.

- [ ] **Step 1: Write the failing tests**

```tsx
import type { PreflightResult } from "@shared/preflight.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreflightBanner } from "./PreflightBanner.js";

const pass = (id: string): PreflightResult => ({
  id,
  label: `${id} is fine`,
  ok: true,
  detail: "no problem here",
  severity: "warning",
});

const fail = (
  id: string,
  detail: string,
  severity: PreflightResult["severity"] = "warning",
): PreflightResult => ({ id, label: `${id} failed`, ok: false, detail, severity });

describe("PreflightBanner", () => {
  it("renders nothing when every check passes", () => {
    const { container } = render(
      <PreflightBanner checks={[pass("docker_reachable"), pass("port_free")]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there are no checks at all", () => {
    // A viewer's request 403s, so the banner receives an empty array.
    const { container } = render(<PreflightBanner checks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows both the label and the detail of a failed check", () => {
    // The label says what is wrong; only the detail says where.
    render(
      <PreflightBanner
        checks={[fail("docker_reachable", "/var/run/docker.sock: no such file")]}
      />,
    );
    expect(screen.getByText(/docker_reachable failed/)).toBeVisible();
    expect(screen.getByText(/no such file/)).toBeVisible();
  });

  it("shows every failed check, not just the first", () => {
    // Two things are wrong on a fresh misconfigured box more often than one,
    // and fixing only the one you were shown means another restart to learn
    // about the next.
    render(
      <PreflightBanner
        checks={[
          fail("docker_reachable", "socket unreachable"),
          pass("compose_v2"),
          fail("projects_dir_readable", "/opt/stacks is unreadable"),
        ]}
      />,
    );
    expect(screen.getByText(/socket unreachable/)).toBeVisible();
    expect(screen.getByText(/opt\/stacks is unreadable/)).toBeVisible();
    expect(screen.queryByText(/no problem here/)).toBeNull();
  });

  it("distinguishes a danger check from a warning", () => {
    // Silent corruption and a failed action are not the same news, and the
    // spec calls the network-filesystem case out as different in kind.
    render(
      <PreflightBanner
        checks={[
          fail("docker_reachable", "socket unreachable"),
          fail("data_dir_local_fs", "/data is on nfs4; data loss is possible", "danger"),
        ]}
      />,
    );
    const warn = screen.getByText(/socket unreachable/);
    const danger = screen.getByText(/data loss is possible/);
    expect(danger).toBeVisible();
    expect(danger.className).not.toBe(warn.className);
  });

  it("names itself for screen readers as an alert", () => {
    render(<PreflightBanner checks={[fail("port_free", "port 7420 is already in use")]} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/7420/);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web/components/preflight-banner.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`AppShell` queries `GET /api/preflight` and renders `<PreflightBanner checks={...} />` above the routed content, passing `[]` while loading or on error. **A viewer's request 403s by design** — that must render nothing, not an error state.

Tokens only — `design-system.test.ts` polices this. Any bordered element needs `border border-border`, since Tailwind's preflight zeroes `border-width`. **Do not add a nav entry**; the nav is icon-only below `sm:` with `min-w-11 min-h-11` links and its budget has been broken twice.

**Do not set `retry` or `refetchOnWindowFocus` on the hook** — client defaults, re-added per hook twice before.

- [ ] **Step 4: Prove the multiple-failures test discriminates**

Render only the first failed check, confirm that test fails, revert. Report the message.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/PreflightBanner.tsx src/web/components/preflight-banner.test.tsx src/web/components/AppShell.tsx src/web/lib/queries.ts
git commit -m "feat(web): surface failed startup checks in the UI"
```

---

## Task 6: The image

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.example.yaml`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
# Homestead drives Compose itself rather than inheriting the host's, because
# several NAS platforms ship only v1, which this product does not support.
RUN apk add --no-cache docker-cli docker-cli-compose
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
EXPOSE 7420
CMD ["node", "dist/server/index.js"]
```

`drizzle/` is copied because migrations are read from disk at startup.

- [ ] **Step 2: Write `.dockerignore`**

Exclude at least `node_modules`, `dist`, `.git`, `.superpowers`, `test-results`, `playwright-report`, and `*.md`. A fat context slows every build and can leak local state into the image.

- [ ] **Step 3: Write `compose.example.yaml`**

Exactly the spec's §4 block, with its comments intact. The `network_mode: host` comment must say **why**, because someone will otherwise switch it to bridge and watch every app report down.

- [ ] **Step 4: Build it for real and prove it runs**

```bash
docker build -t homestead:plan8 .
docker run --rm homestead:plan8 node -e "console.log('boots')"
docker run --rm homestead:plan8 docker compose version
```

The second must print `boots`; the third must print a v2 version. **Report all three outputs verbatim.** Then remove the image (`docker rmi homestead:plan8`) and confirm `docker images` shows no new leftovers.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore compose.example.yaml
git commit -m "build: add the container image and an example compose file"
```

---

## Task 7: Release workflow and README

**Files:**
- Create: `.github/workflows/release.yml`, `README.md`

- [ ] **Step 1: Write the workflow**

Trigger on a `v*` tag. Use `docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/login-action` against `ghcr.io` with `${{ secrets.GITHUB_TOKEN }}`, and `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`. Tag both the version and `latest`. Grant `packages: write` in the job's `permissions` block.

Keep it minimal. **This workflow cannot be tested until a remote exists**, so its first real run is its first test — every clever thing in it is a thing that fails then.

- [ ] **Step 2: Write the README**

Install, the compose file, and the configuration table from spec §12.4. Three things must be prominent, because each is a support question waiting to happen:

- **`network_mode: host` is required.** Bridged networking makes every local probe fail, so every app reads down while looking correctly configured.
- **`$HOMESTEAD_DATA` must be on local storage**, not NFS or SMB. SQLite corrupts quietly there.
- **`$HOMESTEAD_DATA` must persist**, or history and the icon cache are lost on every restart.

- [ ] **Step 3: Check the workflow parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"
```

- [ ] **Step 4: Run every gate**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm e2e`
Expected: PASS at both viewports.

- [ ] **Step 5: Confirm no host side effects**

```bash
docker ps -a --format '{{.ID}}' | sort > /tmp/before.txt
pnpm e2e
docker ps -a --format '{{.ID}}' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "no drift"
docker images --format '{{.Repository}}:{{.Tag}}' | grep -c homestead || echo "no leftover images"
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "build: add the release workflow and the README"
```

---

## Definition of Done

- `pnpm build` produces `dist/server/index.js` and `dist/web/index.html`.
- `docker build` succeeds and the image runs `docker compose version` reporting v2.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` clean; `pnpm e2e` green at **both** viewports; no Docker drift and no leftover images.
- `permissions.ts` and `shared/permissions.ts` are **unchanged by this entire plan**.
- A failed startup check does not prevent startup, and is asserted not to.
- An unrecognised filesystem type produces no warning.
- Several failed checks all appear in the banner, not just the first.
- `GET /api/preflight` refuses a viewer and an anonymous request; `/api/status` stays unauthenticated and carries no preflight detail.
- The SPA fallback does not turn an unknown `/api/` route into HTML.
- The README states the host-networking requirement, the local-storage requirement, and the persistence requirement.

## Handoff

- **The native install remains unbuilt** while product design §12 still promises it as co-equal. Either build it or amend that section; a promise the code does not keep costs someone an afternoon.
- The release workflow is untested until a remote exists.
- Still deferred across the project: per-viewer app visibility, icon uploads, discovered containers as an app source, notifications, the response-time graph, and ICMP.
