# Homestead Phase 2C — The Tunnel and the Managed cloudflared App

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin clicks Provision, and Homestead creates a remotely-managed Cloudflare tunnel, writes `cloudflared` as an ordinary Homestead-managed app, and brings it up — with reverse-order rollback if any of that fails.

**Architecture:** The first real use of 2B's step runner, and a deliberate one: five steps that each touch something external, so the rollback path is exercised by the feature that most needs it. The tunnel is created with `config_src: "cloudflare"`, which is load-bearing — ingress then lives in Cloudflare's API, so the container needs no local config file and no restart when an app is exposed later. The app Homestead writes is an ordinary compose stack in an ordinary directory; the only thing marking it is `systemKind: "cloudflared"`.

**Tech Stack:** Fastify, Drizzle, zod 4, TanStack Query, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` §6 — the subsections **The managed `cloudflared` stack** and **cloudflared networking**.

**Carry-forwards:** `2026-09-12-homestead-2a-carry-forward.md` and `2026-09-12-homestead-2b-carry-forward.md`. Read both.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`. `pnpm db:generate` is fine.
- Baseline **1435 tests**.
- **No test may make a real network call.** Inject `fetch`, as 2A does.
- **Never log or return the tunnel token.** It is a credential that grants control of the tunnel; treat it exactly as 2A treats the API token.
- **Once a migration may have been applied anywhere, add a new one — never rewrite it.** Drizzle's libsql migrator gates on journal timestamps, not content hashes, so a rewritten migration silently no-ops on a database that already ran it. 2B got away with an in-place rewrite only by verifying nothing had applied it. **The test VM now holds real data** — one user, one adopted app — so that escape hatch is gone.
- **libSQL, measured:** `:memory:` rejects **any** statement during an open transaction; tests use `:memory:`.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, Biome clean **by exit code**:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain` empty at the end of each task. Scratch in `/tmp`.

## What is known about Cloudflare's tunnel API, and what is not

Same discipline as 2A. Getting this wrong is how the phase ships something that works against a fake and fails against Cloudflare.

**Relied on:**
- Tunnels live under the account: `/accounts/{account_id}/cfd_tunnel`.
- `POST` creates one; the body carries a `name` and `config_src`. **`config_src: "cloudflare"` is the whole point** — §6 says so explicitly, and it is what keeps ingress in Cloudflare's API rather than in a local file the container would need restarting to re-read.
- The tunnel's run token is fetched separately, at `…/cfd_tunnel/{id}/token`, and is what `cloudflared` needs to run.
- `GET` lists, `DELETE` removes.
- Every response uses the v4 envelope 2A's client already parses.
- A deleted tunnel may be returned by a list call with a `deleted_at` set rather than vanishing.

**Not verified — do not guess these into the code.** The exact shape of the token response (a bare string in `result`, or an object), and whether `DELETE` requires the tunnel to have no active connections. **Where you need one of these, write the code so that both plausible shapes are handled, or so the failure is loud and legible** — and say in your report which you did. A silent `undefined` that becomes a `.env` value is the failure mode to avoid; Phase 1G shipped exactly that with a missing Docker version field.

## The compose file Homestead writes

`cloudflared` must be an ordinary compose stack — adopting it later, editing it by hand over SSH, or reading it in the compose editor all have to work normally.

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    # Host networking, per spec §6. The tunnel's ingress service for an app is
    # http://localhost:<published-port>, and those ports are published on the host
    # for LAN clients regardless — so the tunnel reaches them the same way a phone
    # on the sofa does. A bridged container's localhost would be its own.
    network_mode: host
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
```

The token goes in a sibling `.env` as `TUNNEL_TOKEN=…`, never inline in the compose file. `src/shared/env-file.ts` already owns reading and writing `.env`, and `maskEnv` already masks values — **check that the masking covers this key and does not need a special case.**

**Two consequences of host networking that §6 accepts and this plan inherits:** the tunnel container can reach anything on the NAS and its LAN, so the ingress rule list is the effective boundary on what is exposed; and externally exposed apps stay reachable on the LAN without passing through Access. Both are intended. Put them in the scaffolded file as a comment — the person who reads this stack over SSH in a year should find the reasoning there, not only in a spec.

---

### Task 1: Tunnel endpoints on the Cloudflare client

**Files:**
- Modify: `src/server/cloudflare/client.ts` and its test
- Modify: `src/shared/cloudflare.ts` if a DTO is shared

**Interfaces:**
- Produces, added to `CloudflareClient`:
  ```ts
  createTunnel(name: string): Promise<{ id: string; name: string }>;
  listTunnels(): Promise<Array<{ id: string; name: string; deletedAt: number | null }>>;
  tunnelToken(tunnelId: string): Promise<string>;
  deleteTunnel(tunnelId: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

- `createTunnel` posts `config_src: "cloudflare"`. **Assert on the request body**, not just the response — this is the field the whole design rests on and nothing else would notice if it were dropped.
- `listTunnels` **excludes tunnels with a `deleted_at`**, or surfaces it — pick one, and test it. A deleted tunnel reappearing in a picker is a confusing bug.
- `tunnelToken` returns a non-empty string, and **a response whose token is missing or empty raises rather than returning `""`.** An empty token in a `.env` produces a container that starts, fails to connect, and looks like a network problem.
- `deleteTunnel` on an already-deleted tunnel is not an error — the rollback path calls it, and rollback must be idempotent.
- All four classify faults through 2A's existing `CloudflareError`, and **none puts the token in an error message.**

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/server/cloudflare/client.test.ts`
Expected: FAIL — methods do not exist.

- [ ] **Step 3: Implement**

Reuse 2A's transport, envelope parsing, retry and fault classification. **Do not add a second request path.** If the existing one cannot express something, change it once rather than working around it.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Prove the bindings**

1. Drop `config_src` from the create body → its test fails.
2. Return `""` from `tunnelToken` instead of raising → its test fails.
3. Make `deleteTunnel` throw on an already-deleted tunnel → its test fails.

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Add tunnel endpoints to the Cloudflare client

config_src: cloudflare is asserted on the request body, not just
accepted in the response. It is what keeps ingress in Cloudflare's API
rather than a local file the container would need restarting to reread,
and nothing else in the system would notice if it were dropped."
```

---

### Task 2: Persisting the tunnel, and scaffolding the app

**Files:**
- Create: `src/server/cloudflare/tunnel-store.ts` + test, `src/server/cloudflare/scaffold-cloudflared.ts` + test
- Modify: `src/shared/cloudflare.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TunnelRecord = { tunnelId: string; name: string; appId: string | null; createdAt: number };
  export class TunnelStore {
    get(): Promise<TunnelRecord | null>;
    set(record: TunnelRecord): Promise<void>;
    clear(): Promise<void>;
  }
  export function scaffoldCloudflared(): { composeFile: string; envFile: string };
  ```

**One tunnel, not many.** §6 says "one remotely-managed tunnel". Store it in the `settings` table — flat key-value, already exists, no migration. The token goes in `secrets` via `SecretStore`.

`scaffoldCloudflared` returns file *contents*; it writes nothing. That keeps it a pure function with exhaustive tests, and leaves the writing to the step that can undo it.

- [ ] **Step 1: Write the failing tests**

For `TunnelStore`: round-trips; `get()` returns null when unset; `clear()` removes both the record and the token; **a partially-written record does not read back as a valid one** — a tunnel id with no token is not a usable tunnel and should read as absent or raise, not as present.

For `scaffoldCloudflared`: the compose file parses as YAML (the `yaml` package is already a dependency); it contains `network_mode: host`, the `tunnel --no-autoupdate run` command, and `TUNNEL_TOKEN` by interpolation and **not** inline; the `.env` is `TUNNEL_TOKEN=<value>` and round-trips through `src/shared/env-file.ts`'s `parseEnv`; and **`maskEnv` masks it** — assert that, rather than assuming, since the whole point is that the token never shows in the UI.

Phase 1E's `scaffoldCompose` sanitises a display name before it reaches a comment header, because a newline broke out and injected a second `services:` block. **Read that function.** This scaffold takes no user input today, which is the reason it is safe — say so in a comment so nobody later adds a parameter without noticing.

- [ ] **Step 2-4: Red, implement, green**

- [ ] **Step 5: Prove the bindings**

1. Remove `network_mode: host` → its test fails.
2. Inline the token into the compose file instead of the `.env` → the "not inline" test fails.
3. Make `clear()` leave the token behind → its test fails.

- [ ] **Step 6: Gates and commit**

---

### Task 3: The provision sequence

This is the first real consumer of 2B's `runSteps`, and the reason it was built first.

**Files:**
- Create: `src/server/cloudflare/provision-tunnel.ts` + test, `src/server/routes/cloudflare-tunnel.ts` + test
- Modify: `src/server/app.ts`

**Interfaces:**
- Consumes: `runSteps` and `StepJobRunner` (2B), `CloudflareClient` (Task 1), `TunnelStore` and `scaffoldCloudflared` (Task 2), `Host.createAppDirectory` and `writeTextFile`, the `apps` and `probes` tables.
- Produces:
  ```ts
  export function tunnelProvisionSteps(deps: {...}): Array<Step<ProvisionCtx>>;
  ```

**Five steps, each with an `undo`:**

| | Step | Undo |
|---|---|---|
| 1 | Create the tunnel in Cloudflare | Delete it |
| 2 | Fetch its token and store it | Clear it |
| 3 | Create the app directory and write `compose.yaml` + `.env` | Remove the files |
| 4 | Insert the `apps` row with `systemKind: "cloudflared"` and a docker probe | Delete the row |
| 5 | `docker compose up -d` | `docker compose down` |

**Every step must be idempotent**, because §6 requires it and because a retried provision must not create a second tunnel. Step 1 in particular: if a tunnel is already recorded, the sequence must refuse to start rather than create another. **Decide where that check lives — before the sequence or as step 1's own idempotency — and say which and why.**

**Step 3 writes into the compose root**, so it goes through `PathGuard`. Phase 1E shipped a defect where `POST /api/apps` could never create a directory in production because `PathGuard.resolveForWrite` requires the parent to exist, and every test used an in-memory `FakeHost` that could not model it. **Write at least one test against a real `LocalHost` over a `mkdtemp` root**, not only against `FakeHost`. That carry-forward names this as the pattern that cost a whole phase.

- [ ] **Step 1: Write the failing tests**

The happy path, and then the ones that matter:
- **Step 4 fails → steps 3, 2, 1 are undone in that order, and step 4 is not.** Assert the Cloudflare tunnel was deleted and the directory removed.
- **Step 5 fails → the app row is deleted, the files removed, the tunnel deleted.** A failed `docker compose up` must not leave a half-registered system app.
- **An `undo` that itself fails does not abort the rest**, and the failure reaches the job output — `runSteps` guarantees this, so this test is checking the wiring, not re-testing `runSteps`.
- Provisioning when a tunnel already exists does not create a second one.
- The route requires an admin capability; **a viewer gets 403.**
- The token never appears in the job output. **Assert on the persisted output**, since that is what a user reads and what the audit trail keeps.

- [ ] **Step 2-4: Red, implement, green**

- [ ] **Step 5: Prove the bindings**

1. Make step 4's undo a no-op → the "app row deleted" assertion fails.
2. Reverse the undo order → the ordering test fails.
3. Drop the already-exists check → its test fails.

- [ ] **Step 6: Gates and commit**

---

### Task 4: The UI

**Files:**
- Modify: `src/web/routes/settings/CloudflarePanel.tsx` + test, `src/web/api/cloudflare.ts`

**Interfaces:** Consumes the tunnel status DTO and the provision route.

- [ ] **Step 1: Write the failing tests**

- With no credentials, the tunnel section says so and does not offer Provision. **Provisioning without a token cannot succeed, so offering it is a trap.**
- With credentials and no tunnel, Provision is offered.
- While a provision job runs, the button is disabled and the job's output is visible. **`JobOutput` already exists** and streams a job — reuse it rather than writing a second streaming view.
- With a tunnel, the panel shows its name and links to the `cloudflared` app.
- A failed provision shows what was rolled back and, prominently, **what was not** — that is the only way a user learns they have an orphaned Cloudflare resource.

- [ ] **Step 2-4: Red, implement, green**

- [ ] **Step 5: Prove the binding, and mind the harness**

Make the panel offer Provision with no credentials → its test fails.

**TanStack's `notifyManager` defers re-renders through `setTimeout(0)` and RTL's `act()` can mask that deferral.** If a binding check comes back green, suspect the harness before believing the code, and say so.

- [ ] **Step 6: Gates and commit**

Report the initial chunk size — 411 kB at last measure, `ComposeTab` a separate ~586 kB lazy chunk.

---

## Self-Review

**1. Spec coverage.** This implements §6's **The managed `cloudflared` stack** and **cloudflared networking** in full: one remotely-managed tunnel with `config_src: "cloudflare"`, written as an ordinary Homestead-managed app with the token in its `.env`, appearing on the dashboard with a docker probe and logs, flagged as a system app, with `network_mode: host`.

**Not in this sub-phase, by design:** exposing an app (2D), the service token and reusable policy (2D), the external probe (2E), and adoption of a pre-existing tunnel — deferred in 2A's plan because the account is a clean slate. **Task 1 still builds `listTunnels`**, because the already-exists check needs it and because 2D's drift reconcile will.

**2. Placeholder scan.** No "TBD". Three decisions are delegated with their grounds stated: the shape of the token response (handle both or fail loudly — say which), where the already-exists check lives, and whether `listTunnels` filters or surfaces deleted tunnels.

**3. Type consistency.**
- `CloudflareClient` gains four methods in Task 1, consumed in Task 3. `tunnelToken` returns `string`, never `string | undefined` — the raising behaviour is what makes that honest.
- `TunnelRecord.appId` is nullable because steps 1 and 2 run before the app row exists in step 4; the sequence fills it in. A non-nullable field would force a fake id through two steps.
- `scaffoldCloudflared` returns contents, not paths — Task 3 owns writing, because Task 3 owns undoing.
- `Step<ProvisionCtx>` matches 2B's `Step<C>`; the generic context is what lets `runSteps` stay ignorant of Cloudflare.

**4. The risk worth a reviewer's attention.** Task 3's rollback is the first place in this project where a failure leaves state in **someone else's system**. A bug in `runSteps` is now a bug that orphans a Cloudflare tunnel. 2B tested that module exhaustively in isolation; this task tests the *wiring* — that each step's `undo` actually undoes its own step, and that the context carries enough for it to do so. An `undo` that silently no-ops because its context field was never set is the defect to hunt, and it looks identical to a working one in a green test.
