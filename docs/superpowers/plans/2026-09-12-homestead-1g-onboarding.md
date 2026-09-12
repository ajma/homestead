# Homestead Phase 1G — Onboarding, Settings, and Closing Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a freshly installed Homestead from an empty database to a working launcher without the user ever reading documentation — and, because this is the last phase of Phase 1, close the carried debt that would otherwise never be closed.

**Architecture:** A resumable wizard backed by the `setup_state` table, which exists in the schema and has never been read or written. Each step is idempotent and records its own completion, so a browser closed mid-setup resumes where it left off rather than starting over. Steps 1, 2, 3, 5 and 6 of spec §9; step 4 is Cloudflare and belongs to Phase 2. The users step needs a users UI, which does not exist despite the CRUD API shipping in 1A — so this phase also builds the settings surface the spec keeps referring to.

**Tech Stack:** Fastify, Drizzle + libSQL, dockerode, React 19, TanStack Query 5, react-router-dom 7, Tailwind 4, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — section 9 (Onboarding), with section 10's path-identity constraint behind step 2.

**Carry-forwards this plan is built on, both read in full before writing it:** `docs/superpowers/plans/2026-09-11-homestead-1e-carry-forward.md` and `docs/superpowers/plans/2026-09-12-homestead-1f-carry-forward.md`.

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess`; ESM with `.js` import specifiers on server relative imports; `moduleResolution: bundler`; no `baseUrl`; `target: ES2022` / `lib: ES2023`.
- **No new dependencies.** 1F added the four it was permitted; this phase needs none.
- zod 4 for request validation. Vitest for tests. Biome for lint and format.
- Every non-2xx response body carries an `error` slug.
- `inScope` / `visibleAppsWhere` / `canForApp` remain the only scope predicates.
- **Every `.tsx` test file starts with `// @vitest-environment jsdom`.** `src/web/test-environment.test.ts` enforces it and forgetting it is silent for any test that never renders.
- Check Biome by exit code, never by piping to `tail`: `pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"`.
- `pnpm exec tsc --noEmit` and `pnpm build` are separate gates. **The initial chunk must stay near 329 kB** — 1F split the editors out deliberately; anything that pulls them back is a regression.
- Run the full suite at least **three times** before believing it green.
- **Do not run `pnpm add`, `pnpm install`, `pnpm install --force` or `pnpm exec tsx`.** Concurrent pnpm operations corrupted `package.json` three times during 1F.

---

## Rulings made while writing this plan

**1. This phase closes the carried debt it can.** Phase 1 ends here. Tasks 10–12 clear items carried since 1B-ii, 1C and 1E that are cheap and in scope. The two I am *not* closing are named in the Self-Review with reasons, so nobody has to guess whether they were forgotten.

**2. Setup completion is permanent and one-way.** Once `setup_state.completedAt` is set, `/setup` redirects to the launcher. The alternative — a wizard you can re-enter — means a second admin could be walked through "create the first admin" again. Settings is where you change things afterwards, which is what the spec means by "can be completed later from settings".

**3. The wizard does not gate on steps it cannot verify.** Step 2 (verify host) can fail for reasons the user must fix outside Homestead — a bind mount at the wrong path. The wizard reports it loudly and **lets them continue anyway**, because a NAS admin mid-migration may legitimately know better, and a setup flow that traps you on step 2 with no override is worse than one that warns. Steps 3 and 5 are both explicitly skippable in the spec.

**4. The users UI is built once and used twice.** Step 5 of the wizard and the settings page are the same component with different chrome. Building two would guarantee they drift.

**5. `PUT /api/apps/:id/env` gains a `changes` mode rather than a new endpoint.** 1F's carry-forward wants the `.env` merge moved server-side so a table save stops receiving every secret. A second endpoint would leave two ways to write the same file; an optional `changes` array on the existing one keeps the hash guard, the audit and the unreadable-file refusal in one place.

---

## File Structure

**Server — new:** `src/server/routes/setup.ts` (setup state and host verification).

**Server — modified:** `src/server/host/types.ts` and `local-host.ts` and `test-helpers.ts` (`dockerVersion`), `src/server/routes/apps.ts` (`changes` mode on env PUT), `src/server/routes/probes.ts` (`nextRunAt` on interval change), `src/server/app.ts` (register).

**Shared — new:** `src/shared/setup.ts` — `SetupStep`, `SetupState`, `HostCheck`.

**Web — new:**

| File | Responsibility |
|---|---|
| `src/web/api/setup.ts` | Setup state and host-check hooks. |
| `src/web/api/users.ts` | Users hooks, shared by the wizard and settings. |
| `src/web/routes/setup/SetupWizard.tsx` | The shell: which step, resume, advance, finish. |
| `src/web/routes/setup/StepCreateAdmin.tsx` | Step 1. |
| `src/web/routes/setup/StepVerifyHost.tsx` | Step 2. |
| `src/web/routes/setup/StepImport.tsx` | Step 3. |
| `src/web/routes/setup/StepInviteUsers.tsx` | Step 5, wrapping `UserManager`. |
| `src/web/components/UserManager.tsx` | The users table. Used by the wizard and by settings. |
| `src/web/routes/Settings.tsx` | The settings surface. |

**Web — modified:** `src/web/App.tsx` (setup route and its guard), `src/web/routes/AdminApps.tsx` (row actions), `src/web/routes/EditApp.tsx` (right-rail metadata), `src/web/live/useEventStream.ts` (`statusSince`).

---

### Task 1: `dockerVersion()` and the host check

Spec §9 step 2: *"prove the Docker socket works by displaying the actual `docker version` response; run the mount round-trip preflight from Section 10 and show its result. Fail loudly here rather than later during a deploy, when the symptom would be a stack silently starting with empty volumes."*

**Files:**
- Modify: `src/server/host/types.ts`, `src/server/host/local-host.ts`, `src/server/test-helpers.ts`
- Create: `src/shared/setup.ts`, `src/server/routes/setup.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/routes/setup-host.test.ts`

**Interfaces:**
- Consumes: `runMountPreflight({ composeRoot, dockerSocket })` from `@server/host/preflight`, returning `{ ok: true } | { ok: false; reason: string }`.
- Produces:
  ```ts
  // Host interface
  dockerVersion(): Promise<{ version: string; apiVersion: string; os: string; arch: string }>;
  // src/shared/setup.ts
  export type HostCheck = {
    composeRoot: string;
    docker: { ok: true; version: string; apiVersion: string; os: string; arch: string }
          | { ok: false; message: string };
    preflight: { ok: true } | { ok: false; reason: string };
  };
  ```
  Route: `GET /api/setup/host-check`, admin-only, returning `HostCheck`.

- [ ] **Step 1: Write the failing test**

`src/server/routes/setup-host.test.ts`:

```ts
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

describe("GET /api/setup/host-check", () => {
  it("reports the compose root, a real docker version, and the preflight result", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/setup/host-check", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.composeRoot).toBe("string");
    expect(body.docker.ok).toBe(true);
    expect(body.docker.version).toBeTruthy();
    expect(body.preflight.ok).toBe(true);
  });

  it("reports a dead Docker socket as a failure rather than throwing", async () => {
    // The whole point of this screen is to fail loudly HERE. A 500 would tell the user
    // Homestead is broken; what is actually broken is their socket, and they can fix it.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.dockerVersion = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    const res = await app.inject({ method: "GET", url: "/api/setup/host-check", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().docker).toMatchObject({ ok: false });
    expect(res.json().docker.message).toContain("docker.sock");
  });

  it("still reports the preflight when Docker itself is fine", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.preflight = async () => ({ ok: false, reason: "marker not visible from the daemon" });
    const res = await app.inject({ method: "GET", url: "/api/setup/host-check", headers: { cookie } });
    expect(res.json().docker.ok).toBe(true);
    expect(res.json().preflight).toEqual({ ok: false, reason: "marker not visible from the daemon" });
  });

  it("does not let one failure hide the other", async () => {
    // Both broken is the realistic case for a wrong bind mount, and a user fixing one
    // needs to know the other is also wrong rather than discovering it on the next screen.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.dockerVersion = async () => {
      throw new Error("no socket");
    };
    app.deps.preflight = async () => ({ ok: false, reason: "path mismatch" });
    const body = (await app.inject({ method: "GET", url: "/api/setup/host-check", headers: { cookie } })).json();
    expect(body.docker.ok).toBe(false);
    expect(body.preflight.ok).toBe(false);
  });

  it("is admin-only", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET", url: "/api/setup/host-check", headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/server/routes/setup-host.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add `dockerVersion` to the Host interface**

In `src/server/host/types.ts`, beside `listContainers`:

```ts
  /** The daemon's own version response. Step 2 of onboarding shows it verbatim, because
   *  "Docker is reachable" is a claim and a version string is evidence. */
  dockerVersion(): Promise<{ version: string; apiVersion: string; os: string; arch: string }>;
```

In `LocalHost`, implement it from dockerode's `version()`, mapping `Version`, `ApiVersion`, `Os` and `Arch`. In `FakeHost`, return a fixed plausible response and make it overridable, as the tests above do.

- [ ] **Step 4: Make the preflight injectable**

The route needs to run the preflight on demand and the tests need to override it. Add `preflight` to `AppDeps` as `() => Promise<PreflightResult>`, wired in `src/server/index.ts` to a call of `runMountPreflight({ composeRoot: config.composeRoot, dockerSocket: config.dockerSocket })`, and in `src/server/test-helpers.ts` to a default `async () => ({ ok: true })`.

**`index.ts` already calls `runMountPreflight` at startup and throws `PreflightError`. Leave that.** Startup refusing to run with a broken mount is correct; this route is for showing the user *why*, and for re-checking after they fix it.

- [ ] **Step 5: Write the route**

`src/server/routes/setup.ts`:

```ts
import type { HostCheck } from "@shared/setup.js";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/context.js";

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  const { config, host, preflight } = app.deps;

  app.get("/api/setup/host-check", async (request) => {
    requireAdmin(request);

    // Both checks run, and neither can hide the other. A wrong bind mount usually breaks
    // both, and a user who fixes the socket needs to already know the path is wrong too —
    // discovering it one screen later is the failure this whole step exists to prevent.
    const [docker, preflightResult] = await Promise.all([
      host
        .dockerVersion()
        .then((v) => ({ ok: true as const, ...v }))
        .catch((error: unknown) => ({
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        })),
      preflight().catch((error: unknown) => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      })),
    ]);

    return { composeRoot: config.composeRoot, docker, preflight: preflightResult } satisfies HostCheck;
  });
}
```

Register it in `src/server/app.ts` **before** `spaRoutes`, which installs the not-found handler.

- [ ] **Step 6: Run and verify**

Run: `pnpm exec vitest run src/server/routes/setup-host.test.ts`
Expected: all pass.

- [ ] **Step 7: Binding checks**

- Remove the `.catch` on `dockerVersion` → the dead-socket test must fail with a 500.
- Run the two checks sequentially and return early on the first failure → the "does not let one failure hide the other" test must fail.

- [ ] **Step 8: Commit**

```bash
git add src/server/host/ src/server/test-helpers.ts src/shared/setup.ts src/server/routes/setup.ts src/server/app.ts src/server/routes/setup-host.test.ts
git commit -m "Prove the Docker socket and the bind mount, and show both at once"
```

---

### Task 2: Make `setup_state` real

The table exists in the schema and **nothing has ever read or written it**. Resumability is entirely unimplemented.

**Files:**
- Modify: `src/server/routes/setup.ts`, `src/shared/setup.ts`
- Test: `src/server/routes/setup-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SETUP_STEPS = ["admin", "host", "import", "users"] as const;
  export type SetupStep = (typeof SETUP_STEPS)[number];
  export type SetupState = { completedSteps: SetupStep[]; completedAt: number | null };
  ```
  Routes: `GET /api/setup/state`; `POST /api/setup/state/:step/complete`; `POST /api/setup/finish`.

Note `admin` is a step even though `POST /api/setup/admin` already exists — the wizard needs to know it is done, and `countUsers() > 0` is the fact that decides it.

- [ ] **Step 1: Write the failing test**

Cover: a fresh install reports no completed steps and a null `completedAt`; completing a step records it; **completing the same step twice is idempotent and does not duplicate it**; an unknown step name is rejected with an `error` slug rather than stored; `finish` sets `completedAt`; **finishing twice does not move `completedAt`**, because a second call must not look like a second setup; the state survives a restart (write, re-read through a fresh query); `admin` reports complete whenever a user exists, even if nothing ever posted it — because the first admin can be created from the login screen, which predates this wizard.

That last one is the subtle one:

```ts
it("reports the admin step complete once any user exists, however they were created", async () => {
  // Login.tsx has created the first admin since Phase 1A. Someone who set up that way and
  // then opens the wizard must not be told to do it again.
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  const state = (await app.inject({ method: "GET", url: "/api/setup/state", headers: { cookie } })).json();
  expect(state.completedSteps).toContain("admin");
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

One row, `id: 1`, upserted. `completedSteps` is a JSON array; read it defensively — a hand-edited or corrupt value must degrade to `[]` rather than throw, since this is the table that decides whether a user can get into the product at all.

Derive `admin` from `countUsers() > 0` at read time rather than storing it. Storing it would let the two disagree.

- [ ] **Step 3: Binding checks**

- Append without deduplicating → the idempotence test must fail.
- Let `finish` overwrite `completedAt` unconditionally → the finish-twice test must fail.
- Return the stored steps without deriving `admin` → its test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/setup.ts src/shared/setup.ts src/server/routes/setup-state.test.ts
git commit -m "Give setup_state a reader and a writer, five phases after adding it"
```

---

### Task 3: The wizard shell and its route guard

**Files:**
- Create: `src/web/api/setup.ts`, `src/web/routes/setup/SetupWizard.tsx`
- Modify: `src/web/App.tsx`
- Test: `src/web/routes/setup/SetupWizard.test.tsx`, extend `src/web/App.test.tsx`

**Interfaces:**
- Consumes: `GET /api/setup/state`, `GET /api/setup/status`.
- Produces: `useSetupState()`, `useCompleteStep()`, `useFinishSetup()`; `<SetupWizard />` at `/setup`.

- [ ] **Step 1: Write the failing test**

Cover: a fresh install renders step 1; a state with `admin` complete resumes at step 2 rather than step 1; **a completed setup redirects to the launcher**; the reverse guard — with setup incomplete, visiting `/` redirects to `/setup`; a viewer never sees the wizard; the step indicator shows which steps are done; and **a failed state fetch does not strand the user on a blank screen**.

The resume test is the point of the whole phase:

```tsx
it("resumes at the first incomplete step rather than starting over", async () => {
  // A browser closed halfway through setup must not mean doing it all again — especially
  // step 3, which adopts apps and would otherwise be re-offered as if nothing happened.
  stubState({ completedSteps: ["admin", "host"], completedAt: null });
  renderAt("/setup");
  await waitFor(() => expect(screen.getByRole("heading", { name: /Import/ })).toBeTruthy());
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

The wizard renders one step at a time from the state, not from local navigation — so a reload lands in the same place. Keep a "back" affordance for review, but the *resume point* is always derived from the server's answer.

**The guard in `App.tsx` is two-way** and both directions matter: incomplete setup pulls you to `/setup`; complete setup pushes you off it. Put the redirect above the admin check — a machine with no users has no admin to authorise anything, so the wizard must be reachable unauthenticated for step 1 and authenticated thereafter.

- [ ] **Step 3: Binding checks**

- Derive the current step from local state rather than the server's → the resume test must fail.
- Remove the completed-setup redirect → its test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/api/setup.ts src/web/routes/setup/ src/web/App.tsx src/web/App.test.tsx
git commit -m "Resume setup where the user left it, not where they started"
```

---

### Task 4: Step 1 — create admin

Spec: *"First account, becomes admin, closes the bootstrap route permanently."*

**Files:**
- Create: `src/web/routes/setup/StepCreateAdmin.tsx`
- Test: `src/web/routes/setup/StepCreateAdmin.test.tsx`

- [ ] **Step 1: Write the failing test**

Cover: renders name, email and password fields; posts to `/api/setup/admin`; a weak or mismatched password is refused client-side with a message about what is wrong; the server's error slug is rendered as a sentence; **submitting twice does not create two accounts** (the in-flight guard, synchronous before the request — `CreateAppDialog` has the pattern); **on success it advances without asking the user to log in again**, since the route signs them in; and the step renders as already-done, with no form, when a user already exists.

- [ ] **Step 2: Run to verify it fails, then implement**

Reuse the existing `POST /api/setup/admin` exactly as `Login.tsx` calls it — read that first. This step is a second caller of the same route, not a new one, and the route already closes itself once a user exists.

Say on screen that this account becomes the administrator and that the bootstrap route closes afterwards. That is a one-way door and the spec calls it permanent.

- [ ] **Step 3: Binding check**

Remove the in-flight guard → the double-submit test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/setup/StepCreateAdmin.tsx src/web/routes/setup/StepCreateAdmin.test.tsx
git commit -m "Create the first administrator from the wizard"
```

---

### Task 5: Step 2 — verify host

**Files:**
- Create: `src/web/routes/setup/StepVerifyHost.tsx`
- Test: `src/web/routes/setup/StepVerifyHost.test.tsx`

- [ ] **Step 1: Write the failing test**

Cover: shows the compose root; shows the Docker version, API version, OS and arch **verbatim from the response**, because a version string is evidence where "Docker is reachable" is only a claim; a dead socket shows the error message and does not claim success; a failed preflight shows its reason **and an explanation of the path-identity constraint** — the user cannot act on "preflight failed" alone; a re-check button re-runs both; and **the user can continue past a failure**, with the warning still visible.

That last one is a deliberate ruling and needs its reason in the test:

```tsx
it("lets the user continue past a failed preflight, with the warning still shown", async () => {
  // A wrong bind mount is fixed outside Homestead, and a NAS admin mid-migration may know
  // better than we do. Trapping them on step 2 with no override is worse than warning
  // loudly — but the warning must not disappear when they proceed.
  ...
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

For the preflight failure, explain the constraint in the user's terms, drawn from spec §10: the compose root must be bind-mounted **at the same absolute path inside the container as on the host**, because the Docker daemon resolves each stack's bind mounts against the host filesystem and a host-invalid source is *silently created as an empty directory*. That last clause is why this check exists — the alternative symptom is a stack that starts successfully with no data in it.

Symlinks on the host are fine; mounting the share at a different path inside the container is not. Say both.

- [ ] **Step 3: Binding checks**

- Render a generic "check failed" instead of the response's message → the dead-socket test must fail.
- Block Continue when the preflight fails → the continue-past-failure test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/setup/StepVerifyHost.tsx src/web/routes/setup/StepVerifyHost.test.tsx
git commit -m "Show the user what their Docker socket and bind mount actually say"
```

---

### Task 6: Step 3 — import from disk

Spec: *"The adoption scan as a multi-select table… Read-only with respect to the user's files."*

**Files:**
- Create: `src/web/routes/setup/StepImport.tsx`
- Test: `src/web/routes/setup/StepImport.test.tsx`

- [ ] **Step 1: Write the failing test**

Cover: lists discovered directories with project name, compose file, container count and running state; an already-adopted directory is shown without a checkbox; orphan stacks are surfaced with a line explaining what an orphan is; adopting posts only the checked directories; **a partial failure keeps the step open and names what failed**; the step is skippable; and **skipping still marks it complete**, so a resume does not re-offer it.

- [ ] **Step 2: Run to verify it fails, then implement**

`AdoptDialog` from 1E already does most of this. **Extract its body into a component both can use** rather than copying it — the wizard's version has different chrome (no dialog shell, a Skip button) but identical behaviour, and two copies of an adoption flow will drift. If extraction proves messy, say so and copy deliberately rather than half-extracting.

- [ ] **Step 3: Binding checks**

- Send every discovered directory rather than the checked ones → its test must fail.
- Advance on a partial failure → the partial-failure test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/setup/StepImport.tsx src/web/routes/setup/StepImport.test.tsx src/web/routes/AdoptDialog.tsx
git commit -m "Adopt what is already on disk, during setup"
```

---

### Task 7: The users manager and the settings page

The CRUD API shipped in 1A. Nothing has ever called it from a browser, and `/settings/*` is a `Placeholder`.

**Files:**
- Create: `src/web/api/users.ts`, `src/web/components/UserManager.tsx`, `src/web/routes/Settings.tsx`
- Modify: `src/web/App.tsx`
- Test: `src/web/components/UserManager.test.tsx`, `src/web/routes/Settings.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/users`, `PATCH /api/users/:id`, `PUT /api/users/:id/scope`, `DELETE /api/users/:id`.
- Produces: `<UserManager />`; `<Settings />` at `/settings`.

- [ ] **Step 1: Write the failing test**

Cover: lists users with role and scope; creating a viewer posts name, email, password and role; **changing scope to specific apps shows an app picker and sends `appIds`**; deleting asks for confirmation naming the user; the server's `last_admin` 409 renders as a sentence explaining you cannot remove the last administrator; **disabling a user is offered as distinct from deleting**, since the API supports both and they mean different things; and a viewer cannot reach settings at all.

- [ ] **Step 2: Run to verify it fails, then implement**

Use `ConfirmDialog` for delete — it is async-aware, stays open on failure and shows the message in place, which matters here because `last_admin` is a refusal the user needs to read.

Note from 1E's carry-forward: changing a user's `role`, `scopeAllApps` or `disabled` closes their SSE streams server-side, so their open tabs re-authorise. That is correct and needs no client work; do not add any.

- [ ] **Step 3: Binding checks**

- Send `appIds` on a `scopeAllApps: true` update → the scope test must fail.
- Remove the delete confirmation → its cancel test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/api/users.ts src/web/components/UserManager.tsx src/web/routes/Settings.tsx src/web/App.tsx src/web/components/UserManager.test.tsx src/web/routes/Settings.test.tsx
git commit -m "Manage users from a browser, five phases after the API shipped"
```

---

### Task 8: Step 5 — invite users, and Step 6 — done

**Files:**
- Create: `src/web/routes/setup/StepInviteUsers.tsx`
- Modify: `src/web/routes/setup/SetupWizard.tsx`
- Test: `src/web/routes/setup/StepInviteUsers.test.tsx`, extend `SetupWizard.test.tsx`

- [ ] **Step 1: Write the failing test**

Cover: renders `UserManager` with wizard chrome; the step is skippable and skipping marks it complete; finishing posts to `/api/setup/finish` and lands on the launcher; **a finished setup cannot be re-entered**; and the final screen says what was set up — how many apps adopted, how many users invited — rather than a bare "Done", because a user who just clicked through four screens deserves to see what happened.

- [ ] **Step 2: Run to verify it fails, then implement**

`StepInviteUsers` is `UserManager` plus a Skip and a Finish. Do not fork it.

- [ ] **Step 3: Binding check**

Allow re-entry after finishing → the cannot-re-enter test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/setup/ src/web/routes/setup/StepInviteUsers.test.tsx
git commit -m "Invite the household, then hand over to the launcher"
```

---

### Task 9: Move the `.env` merge server-side

1F's carry-forward, item 1. A table-mode save fetches the whole `.env` — every secret — to reapply changed keys through `upsertEnv` in the browser. The audit now records *why*, but the read still happens.

**Files:**
- Modify: `src/server/routes/apps.ts`, `src/web/routes/edit/EnvTab.tsx`
- Test: extend `src/server/routes/apps-env.test.ts` and `src/web/routes/edit/EnvTab.test.tsx`

**Interfaces:**
- Produces: `PUT /api/apps/:id/env` additionally accepts `{ changes: Array<{ key: string; value: string | null }>, expectedHash }`, where a `null` value deletes the key. The existing `{ content, expectedHash }` mode stays for raw mode.

- [ ] **Step 1: Write the failing test**

Cover: a `changes` PUT applies each key through `upsertEnv` server-side and **preserves every comment and untouched line byte-for-byte**; a `null` value deletes the key; the hash guard still applies and a mismatch still 409s; the unreadable-file refusal still applies; `content` and `changes` together is a 400 rather than a guess; an empty `changes` array is a no-op rather than an empty file; and **the client no longer requests the whole file on a table save** — assert on the requests, not the DOM.

That last one is the entire point:

```tsx
it("saves a table edit without ever fetching the other secrets", async () => {
  // The carried finding: the browser used to receive every credential in order to write
  // one. Assert on what was requested, because the DOM looks identical either way.
  ...
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

`upsertEnv` is already in `src/shared/env-file.ts` and importable from both zones, which is most of the work. Apply changes in order against the freshly-read file, then write with the caller's `expectedHash`.

Keep the client's conflict handling: on 409 it still offers the disk version or an overwrite, and the auto-merge still refuses a key the concurrent edit also touched. **Clearing pending edits when the user loads the disk version must keep working** — that was a data-loss bug fixed at the very end of 1F.

- [ ] **Step 3: Binding checks**

- Rebuild the file from the changes instead of `upsertEnv` → the comment-preservation test must fail.
- Ignore `expectedHash` in the `changes` branch → the 409 test must fail.
- Have the client fetch the whole file again → the no-whole-file-fetch test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/apps.ts src/web/routes/edit/EnvTab.tsx src/server/routes/apps-env.test.ts src/web/routes/edit/EnvTab.test.tsx
git commit -m "Merge .env changes on the server, so a save stops shipping every secret"
```

---

### Task 10: Two small carried fixes

Both from 1E's carry-forward. Neither is large; both have been carried long enough.

**Files:**
- Modify: `src/server/routes/probes.ts`, `src/web/live/useEventStream.ts`
- Test: extend `src/server/routes/probes.test.ts` and `src/web/live/useEventStream.test.tsx`

- [ ] **Step 1: `intervalSeconds` must move `nextRunAt`**

Carried since 1C. `PATCH /api/probes/:id` with a new interval leaves `nextRunAt` alone, so an admin who changes a daily probe to every 30 seconds waits up to a day to see it. 1E shipped the UI that edits it, which made it visible.

Test: patching the interval sets `nextRunAt` to no later than now plus the new interval; patching an unrelated field leaves `nextRunAt` untouched; and shortening an interval on a probe that was due tomorrow makes it due within the new window.

- [ ] **Step 2: `statusSince` must come from the server**

The client stamps `statusSince` with its own receipt time when patching a tile from an SSE frame, so a tile's age comes from two different clocks depending on whether it arrived by fetch or by patch.

**The frame does not currently carry the transition time**, so this needs both halves: add it to the published payload and use it on the client. Test that a patched tile's `since` equals the server's value and not the client's clock.

- [ ] **Step 3: Binding checks**

- Leave `nextRunAt` alone on an interval change → its test must fail.
- Stamp `Date.now()` on the client → the `statusSince` test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/probes.ts src/web/live/useEventStream.ts src/server/routes/probes.test.ts src/web/live/useEventStream.test.tsx
git commit -m "Apply a new probe interval immediately, and date a tile by the server's clock"
```

---

### Task 11: Inventory row actions and right-rail metadata

1E's carry-forward, item 4 — two spec §8 items my 1E Self-Review wrongly claimed as delivered. Every action is reachable from the edit page, so this is convenience rather than capability, but the spec asks for it and the Self-Review should not have said it was done.

**Files:**
- Modify: `src/web/routes/AdminApps.tsx`, `src/web/routes/EditApp.tsx`
- Test: extend `src/web/routes/AdminApps.test.tsx` and `src/web/routes/EditApp.test.tsx`

- [ ] **Step 1: Write the failing tests**

For row actions: each row offers deploy, restart and open-in-editor; the destructive one confirms; **actions disable while that app has a job running**, matching `ActionBar`; and a row action invalidates only that app's key, not the whole list — the list is the Docker-touching endpoint and re-fetching all of it to update one row is the mistake 1E already made once.

For the right rail: it shows directory, compose file, project name, adoption date and last deploy; it is absent on mobile widths, where the action bar takes that space.

- [ ] **Step 2: Run to verify they fail, then implement**

Reuse `ActionBar`'s mutation path rather than writing a second one; extract if needed. One job runner, one set of semantics.

- [ ] **Step 3: Binding checks**

- Invalidate `adminAppsKey` from a row action → the only-that-app test must fail.
- Remove the in-flight disable → its test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/AdminApps.tsx src/web/routes/EditApp.tsx src/web/routes/AdminApps.test.tsx src/web/routes/EditApp.test.tsx
git commit -m "Act on an app from the inventory, and say where it lives"
```

---

### Task 12: Close Phase 1

**Files:**
- Modify: `src/web/routes/AppLayout.tsx` (a settings link)
- Test: extend `src/web/App.test.tsx`

- [ ] **Step 1: Write the failing tests**

Cover: an admin sees a Settings link and a viewer does not; `/setup` is unreachable once complete; **a viewer visiting `/settings` lands on the launcher**; and the full set of admin routes — `/apps`, `/apps/:slug/*`, `/settings`, `/setup` — are each unreachable by a viewer, tested by navigation rather than by the absence of a link.

- [ ] **Step 2: Implement, run, verify**

- [ ] **Step 3: Full gates**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run     # three times
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
pnpm build
```

**Report the initial-chunk size.** 1F left it at 329 kB by lazy-loading the editors; a settings page or a wizard that pulls CodeMirror back into the main chunk would undo that silently.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/AppLayout.tsx src/web/App.test.tsx
git commit -m "Link settings, and prove every admin route turns a viewer away"
```

---

## Self-Review

**1. Spec coverage.** Section 9's in-scope steps all map to a task:

| Spec requirement | Task |
|---|---|
| Resumable via `setup_state`, every step idempotent | 2, 3 |
| Step 1 — create admin, closes bootstrap permanently | 4 |
| Step 2 — compose root, real `docker version`, mount preflight | 1, 5 |
| Step 3 — adoption scan as multi-select, read-only | 6 |
| Step 4 — Cloudflare | **Phase 2, out of scope** |
| Step 5 — invite users and their scope | 7, 8 |
| Step 6 — done → launcher | 8 |
| "Can be completed later from settings" | 7 |

**Carried debt closed here:** the `.env` server-side merge (Task 9); `intervalSeconds`/`nextRunAt` and `statusSince` (Task 10); inventory row actions and right-rail metadata (Task 11).

**Carried debt deliberately NOT closed, with reasons, so nobody has to guess:**
- **`target="_blank"` from a standalone PWA.** Needs a real phone. No amount of jsdom settles it.
- **`createBrowserRouter` + `useBlocker` for in-SPA unsaved-changes protection.** A router migration touching every route, at the end of a phase, to close a gap whose current mitigation (`beforeunload`) covers the common case. It wants its own change.
- **A startup sweep of `jobs` rows stuck at `running`, and a SIGTERM handler.** Both belong with the Dockerfile, and **spec §10 has no plan at all** — see the risk below.
- **A drift signal on the vendored schema pin.** The pin is fresh; this becomes real in months, not weeks.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Tasks 1 and 2 carry complete code for the server surface everything else depends on; Tasks 3–12 give test coverage lists with the load-bearing cases written out and their reasoning, which is the pattern the last three phases have used successfully for conventional React.

**3. Type consistency.** `HostCheck` is defined in Task 1 and consumed in Task 5. `SetupStep`, `SETUP_STEPS` and `SetupState` are defined in Task 2 and consumed in Tasks 3, 6 and 8. `UserManager` is built in Task 7 and reused unchanged in Task 8. `preflight: () => Promise<PreflightResult>` is added to `AppDeps` in Task 1 and must be wired in **both** `index.ts` and `test-helpers.ts` — a divergence there was a real defect in 1C.

**4. Cross-task conflict scan.**

| Tasks | Shared surface | Finding |
|---|---|---|
| 1, 2 | `src/server/routes/setup.ts` | 1 creates it, 2 appends routes. Sequential. Clean. |
| 1, 2 | `src/shared/setup.ts` | 1 adds `HostCheck`, 2 adds the step types. No collision. |
| 3, 4, 5, 6, 8 | `SetupWizard.tsx` | 3 creates the shell with step placeholders; 4–6 and 8 substitute. Declared in each. |
| 3, 7, 12 | `App.tsx` | 3 adds `/setup` and its guard, 7 adds `/settings`, 12 only tests. Sequential. |
| 7, 8 | `UserManager` | 7 builds, 8 wraps. 8 must not fork it. |
| 6 | `AdoptDialog.tsx` | Task 6 extracts a shared body. The only task touching a 1E file for structure rather than behaviour — flagged as the likeliest place for an accidental behaviour change. |
| 9, 11 | `EnvTab` / `AdminApps` | Different files, no overlap. |
| 1 | `index.ts` + `test-helpers.ts` | The `preflight` dep must be wired in both. Named because this exact divergence shipped once. |

**5. Risks worth naming.**

- **Task 6's extraction is the highest-risk change in the phase.** `AdoptDialog` is reviewed, working 1E code, and the wizard needs the same behaviour with different chrome. An extraction that quietly changes the partial-failure path would be a regression in a flow nobody exercises twice. Its tests must cover the dialog's behaviour after the extraction, not only the wizard's.
- **Spec §10 — Deployment — has never been planned.** The Dockerfile, the multi-stage build, the SIGTERM handler and the stuck-job sweep all live there, and three carry-forwards now point at it. Phase 1's milestone is "manage every NAS stack from a phone and know whether it is healthy", which this phase completes — but the product cannot actually be *deployed* until §10 is built. **That is the next plan after this one**, and it should be said out loud rather than discovered.
- **Task 9 changes a `PUT` contract on the credentials file.** It was declined mid-wave in 1F for exactly that reason. It is safe here because it has a whole task rather than the tail of one, but the conflict handling fixed at the end of 1F must keep working — particularly clearing pending edits when the user loads the disk version, which was a data-loss bug.
