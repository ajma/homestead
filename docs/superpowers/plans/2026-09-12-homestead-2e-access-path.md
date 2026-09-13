# Homestead Phase 2E — The External Probe and the Access Sign-In Path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on the two things Phase 1 built and left inert — the external probe, which reports `degraded` forever because nothing gives it credentials, and the Cloudflare Access sign-in path, which is correct, tested, and registered nowhere.

**Architecture:** Both are wiring, not new machinery. 2D produced the monitor service token's `clientId` and `clientSecret`; the probe runner already takes an `accessCredentials` callback and is simply never given one. The Access JWT plugin already verifies signature, issuer, expiry and audience; it needs a team domain and an audience to come from the database rather than only from environment variables, and it needs to be mounted.

**Tech Stack:** Fastify, Better-Auth, Drizzle, zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — §7 **Auth and RBAC** for the Access path, §5 for the probe, §10 for where the settings come from.

**Carry-forwards:** 2A's through 2D's. 2D's names both of these as 2E's.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`.
- Baseline **1616 tests**.
- **No test may make a real network call.**
- **Never log or return the monitor service token's secret.**
- **Add a new migration if one is needed; never rewrite `0000`–`0003`.** Drizzle's libsql migrator gates on journal timestamps, not content hashes, and the test VM holds real data. `settings` and `secrets` are flat key-value tables that already exist and will probably suffice.
- **libSQL, measured:** `:memory:` rejects **any** statement during an open transaction.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, Biome clean **by exit code**:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain --untracked-files=all` empty at the end of each task; no scratch files in the repo. Scratch in `/tmp`.

## The security posture this phase must not weaken

§7 is unambiguous and the reasoning is the important part:

> **The Access path is inert until configured.** It activates only when a team domain and an audience are configured… Failing closed on missing configuration is the correct default anyway: a half-configured Access path that accepted unverifiable tokens would be strictly worse than no Access path.

So: **partial configuration must be treated as no configuration.** A team domain with no audience, or an audience with no team domain, activates nothing. An empty-string value is not a value. This is the one place in the project where a permissive bug hands someone else's authenticated session to a stranger, and it is worth more tests than its size suggests.

---

### Task 1: Give the external probe its credentials

Phase 1 shipped `createHttpRunners` with an `accessCredentials?: () => Promise<AccessCredentials | null>` parameter (`http-runner.ts:71`) that is read at `:144` — and `startup.ts` never passes one. **Every `http_external` probe an admin can create today reports `degraded`, permanently.** The runner is structurally complete and functionally inert.

**Files:** modify `src/server/startup.ts`, `src/server/monitoring/http-runner.ts` if needed, and their tests.

- [ ] **Step 1: Write the failing tests**

- With monitor access configured, the runner sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`. **Assert the header values against the stored credentials**, not merely that headers exist.
- With none configured, the probe reports `degraded` with a reason naming the missing configuration — **not** a bare failure. An admin seeing `degraded` must be able to tell "you have not finished setting this up" from "your app is down". §5's fault classification exists for exactly this.
- **Credentials are read per probe run, not captured once at startup.** After 2D's rotation replaces the secret, the next run must use the new one. A closure capturing the value at construction is the obvious wrong implementation and it passes every test that only runs one probe.
- The secret never appears in a probe result, a `check_results` row, or a log line.
- A startup-level test that `startup.ts` actually wires the callback. This is the line whose absence caused the defect, and a unit test of the runner cannot see it.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Pass a callback that reads from 2D's `MonitorAccessStore` at call time.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Prove the bindings**

1. Remove the wiring from `startup.ts` → the startup test fails. **This is the mutation that reproduces the original defect**; confirm it does.
2. Capture the credentials once at construction instead of per run → the rotation test fails.

- [ ] **Step 6: Gates and commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
git add -A && git commit -m "Give the external probe the credentials it has always taken

createHttpRunners has accepted an accessCredentials callback since Phase
1 and startup never passed one, so every http_external probe an admin
could create reported degraded forever. Read per run, not captured at
construction: 2D's rotation must take effect on the next probe."
```

---

### Task 2: Access settings from the database

§10: the team domain and audience "normally live in the database, written when Homestead provisions its own exposure in Phase 2"; the environment variables exist "only as an override for the case where Homestead is placed behind an Access application it did not create".

Today only the environment path exists (`config.ts:22-23`, `accessEnabled` at `:84`).

**Files:** create `src/server/auth/access-settings.ts` + test; modify `src/server/routes/cloudflare.ts` and its test; possibly `src/server/auth/access-plugin.ts`.

**Interfaces:**
```ts
export type AccessSettings = { teamDomain: string; aud: string } | null;
export async function resolveAccessSettings(deps: { db: Db; config: Config }): Promise<AccessSettings>;
```

**Precedence, and state it in a comment:** the environment wins when it supplies **both** values, because §10 calls it an override for a deployment Homestead does not control. The database is the normal source. **Neither source may be mixed with the other** — a team domain from the environment and an audience from the database is a configuration nobody wrote and nobody can reason about.

- [ ] **Step 1: Write the failing tests**

- Both from the database → resolved from the database.
- Both from the environment → the environment wins.
- **Environment supplies one, database supplies the other → `null`.** Not a blend. Test both directions.
- Exactly one value present anywhere → `null`.
- **An empty string is not a value** → `null`. Test it, because `""` passing a truthiness check is how half-configured states happen.
- Nothing configured → `null`.

- [ ] **Step 2: Where the database values come from**

When an exposure is created for an app whose `systemKind` is `"self"` — Homestead's own — record its `aud` and the account's team domain as the Access settings. 2D already stores `accessAppAud` on the exposure.

**But nothing currently sets `systemKind: "self"`.** 1I deferred that as a design question and 2B settled only what `self` *means*, not who assigns it. **Do not build self-detection here.** Instead: resolve from the exposure of the app marked `self` if one exists, and leave marking it to a later phase. Write a test with a seeded `self` app proving the resolution works, and **say plainly in your report that the marking step does not exist yet**, so this reads as a known gap rather than a finished feature.

- [ ] **Step 3-5: Red, implement, green**

- [ ] **Step 6: Prove the bindings**

1. Allow mixing sources → the mixed-source tests fail.
2. Treat `""` as configured → the empty-string test fails.

- [ ] **Step 7: Gates and commit**

---

### Task 3: Mount the Access sign-in path

`src/server/auth/access-plugin.ts` exists, is tested, and **is registered nowhere** — its only exercise is its own test file. §7 describes the endpoint: on a request carrying `Cf-Access-Jwt-Assertion` with no active session, verify the signature, `iss`, `exp`, and that `aud` equals Homestead's own Access audience, then resolve the identity to a user.

**Files:** modify `src/server/auth/auth.ts` and/or `src/server/app.ts`; tests alongside.

- [ ] **Step 1: Write the failing tests — this is security code, so write them as an attacker would**

- A valid assertion with a matching `aud`, for a known user, establishes a session.
- **A valid assertion whose `aud` is a *different* Access application is rejected.** This is the attack that matters: any Access application in the same Cloudflare account issues a structurally valid JWT, so without the audience check, a tenant of any other app in the account signs in as your admin.
- An expired token is rejected. A token with a bad signature is rejected. A token from the wrong issuer is rejected.
- **With settings unresolved, the header is ignored entirely** — not partially honoured, not an error that leaks whether Access is configured. Inert means inert.
- **An existing password session is unaffected** by a garbage `Cf-Access-Jwt-Assertion` header.
- An assertion for an email with no Homestead user does not create one implicitly. Decide and state the behaviour; **auto-provisioning from an Access assertion would let anyone your Access policy admits become a Homestead user**, which is a policy decision that belongs to the admin, not to this code.
- **A disabled user's assertion is rejected.** Phase 1C's carry-forward records that a stale `AuthContext` kept streams open for a disabled user; the same care applies here.

- [ ] **Step 2-4: Red, implement, green**

- [ ] **Step 5: Prove the bindings**

1. Remove the `aud` comparison → the wrong-audience test fails. **If it does not, stop — that is the single most important line in this phase.**
2. Honour the header when settings are unresolved → the inert test fails.
3. Accept a disabled user → its test fails.

- [ ] **Step 6: Gates and commit**

---

## Self-Review

**1. Spec coverage.** §7's Access sign-in path, including its "inert until configured" requirement and the audience check; §10's rule that the database is the normal source for the team domain and audience with the environment as an override; and the external probe's credentials, which §6 describes as the monitor token's purpose. **Closes the Phase 1 defect** recorded in 2A's carry-forward: every `http_external` probe reporting `degraded` forever.

**Not here:** the UI for any of it, the service-token expiry warning, drift flagging and onboarding step 4 — all 2F. And **marking an app as `systemKind: "self"`**, which remains unassigned; Task 2 resolves from such an app if one exists and the report must say the marking step does not.

**2. Placeholder scan.** No "TBD". Two decisions are delegated with their grounds: what happens when an Access assertion names an unknown email, and whether the plugin mounts through Better-Auth or as a Fastify hook — the existing `auth.ts` decides that and the implementer should follow it rather than introduce a second pattern.

**3. Type consistency.** `AccessSettings` is a nullable object rather than two nullable fields, precisely so a half-configured state is unrepresentable — the type does the work the tests also check. `resolveAccessSettings` takes `db` and `config` because precedence needs both sources. The probe's `accessCredentials` callback signature already exists and is unchanged; Task 1 only supplies it.

**4. What a reviewer should attack hardest.** Task 3's audience check. Every other defect in this phase makes something not work; that one makes something work for the wrong person. A structurally valid Cloudflare Access JWT is issued by every Access application in the account, so the audience comparison is the entire boundary between "my admin" and "anyone admitted to any other app I host". It is one comparison, and a test asserting successful sign-in passes whether or not it is there.
