# Phase 1B-i — final review fix wave

The whole-branch review returned **NOT READY**. These are the fixes, in order of
severity. Everything here was reproduced against the running app before being written
down; the measured output is quoted with each item.

Where this document and the phase plan disagree, this document wins — it is later and
each item exists because the plan's version was shown to be wrong.

---

## 1. Critical — one broken app blanks the whole inventory

`GET /api/apps` maps `statusFor` over every row inside `Promise.all`. Neither
`composeConfig.resolve` nor `host.listContainers` is guarded, so a single rejection
rejects the whole array.

Measured, with two adopted apps:

```
list before                            200
list after ONE compose file vanishes   500 {"error":"internal_error", ...}
list with the docker socket down       500 {"error":"internal_error", ...}
```

Both are ordinary states here. The compose root is an SMB share the user edits over SSH,
so a renamed or moved `compose.yaml` is a Tuesday. And the spec is explicit at §8:

> A wedged Docker socket or a slow Cloudflare API must not degrade the screen whose job
> is to reach Jellyfin.

Today it does worse than degrade it: the admin cannot see *which* app broke, because the
list, the detail route and the compose route all 500 with a message that names nothing.
Recovery means restoring the file over SSH or editing SQLite.

**Fix.**

- `statusFor` catches. A missing or unresolvable compose file yields
  `{ status: 'unknown', detail: 'compose file could not be read', adminDetail: <the error> }`
  — `adminDetail`, not `detail`, because the error text can carry a path.
- The list route's single `listContainers()` call is wrapped. On failure, every row's
  status becomes `unknown` with `detail: 'Docker is unreachable'`.

  It must **not** fall back to an empty container list. `rollUpStatus` against `[]`
  returns `down` with "N missing", so an unreachable socket would paint every app red and
  tell the user their whole NAS is broken. `unknown` is the truth: we do not know.
- The per-app routes (`GET /api/apps/:id`, and anything else calling `statusFor`) inherit
  the same guard, since it lives inside `statusFor`.

**Tests.** All three of these are missing today, which is precisely why this shipped: no
route test in the phase exercises a file or socket being unavailable.

- Two apps adopted, one app's compose file deleted → `GET /api/apps` is 200, returns both,
  the broken one is `unknown`, the healthy one still reports its real status.
- `listContainers` throwing → `GET /api/apps` is 200 and every app is `unknown`, **not**
  `down`. Assert the status is not `down` explicitly; that is the whole point.
- A viewer in the same situation sees `statusDetail` with no filesystem path in it.

---

## 2. Important — eight of ten app routes ignore the scope predicate

`visibleAppsWhere(ctx)` is composed by `GET /api/apps` and `GET /api/apps/:id`. The other
eight select on `eq(apps.id, id)` alone.

Measured, with a principal created as `{ role: 'admin', scopeAllApps: false, appIds: [] }`:

```
GET  /api/apps                  200  []
GET  /api/apps/:id              404  {"error":"not_found"}
GET  /api/apps/:id/compose      200  {"content":"services: {}\n", ...}
GET  /api/apps/:id/env          200  {"entries":[{"key":"DB_PASSWORD", ...
POST /api/apps/:id/env/reveal   200  {"content":"DB_PASSWORD=hunter2\n", ...}
```

The detail route says the app does not exist and its sibling hands over the password. Two
routes disagree about the same access question, which means one of them is wrong no matter
which answer is intended.

`canForApp` and `inScope` exist in `src/server/auth/context.ts`, are unit-tested, and have
zero production call sites.

**Fix.** One helper, used by **every** route that loads an app by id:

```ts
/**
 * The single way a route loads an app. Composing `visibleAppsWhere` here rather than at
 * ten call sites is the point: a route that forgets it cannot be spotted by reading the
 * route, only by reading all ten and noticing one is different. Out of scope is 404, not
 * 403 — the same answer as a genuinely absent id, so the response does not confirm that
 * an app the caller may not see exists.
 */
async function loadApp(ctx: AuthContext, id: string) {
  const [row] = await db.select().from(apps).where(and(eq(apps.id, id), visibleAppsWhere(ctx)))
  return row
}
```

Every `const [row] = await db.select()...` in `apps.ts` becomes `const row = await loadApp(ctx, id)`.
Routes that currently call `requireCapability` without keeping the returned context need to
keep it.

**Tests.** One test per route, table-driven, asserting a scoped principal gets 404 from all
ten — not 403, and never a body containing `hunter2`.

---

## 3. Important — `projectName` is resolved once and never reconciled

Stored at adoption from `docker compose config`, then never revisited. Adding
`COMPOSE_PROJECT_NAME=other` to an app's `.env` leaves the row saying `jellyfin`, so
`listContainers({ project })` matches nothing and a healthy stack reads permanently down.

That is the exact failure the spec cites at §3 as the reason for storing the field at all,
and it is reachable through Homestead's own `PUT /api/apps/:id/env` — which invalidates the
compose cache but does not re-derive the name.

**Fix.** After a successful write in both `PUT /api/apps/:id/compose` and
`PUT /api/apps/:id/env`, invalidate as now, then re-resolve and update `apps.projectName`
if it changed. The resolve is already warm-cached against the new content in the compose
case, and needed anyway in the `.env` case.

Do not fail the write if the re-resolve fails — the user's file is already saved, and a
name that will be corrected on the next successful resolve is a smaller problem than a
save reported as failed after it succeeded.

**Test.** Write a `.env` setting `COMPOSE_PROJECT_NAME`, then assert the app row's
`projectName` follows, and that the status rollup finds containers under the new name.

---

## 4. Important — the config cache misses files the CLI reads

`inputHash` covers `compose.yaml` and `.env`. Compose also reads
`compose.override.yaml` / `compose.override.yml` / `docker-compose.override.yaml` /
`docker-compose.override.yml` from the same directory, automatically. Edit one over SSH
and the hash is unchanged, so a stale service set is served until restart.

**Fix.** Fold the override filenames into `inputHash`, in the same missing-is-a-constant
style as `.env`. Order matters for the hash's stability — iterate a fixed list, not a
directory read.

**Not fixed here:** `include:` and `extends: { file: }` targets, which can name arbitrary
paths and would need the resolved config to discover — a chicken-and-egg the override
list does not have. Carried forward.

---

## 5. Important — unbounded subprocess fan-out on a cold cache

`GET /api/apps` calls `statusFor` per row in a `Promise.all`, and each cache miss spawns
`docker compose config`. On the first page load after every restart — and after every
compose or `.env` write invalidates an entry — that is one Go binary per app,
simultaneously. Thirty on the target NAS.

The irony is that the same function comments celebrate collapsing thirty Docker API calls
into one, then fans out thirty processes beside it.

**Fix.** Bound the concurrency to 4 with a small local helper. No new dependency: process
the rows in chunks, or a tiny promise pool — whichever reads more clearly.

**Test.** Twenty apps, a `FakeHost` that records the number of concurrent `runCompose`
calls in flight, asserting the peak never exceeds 4.

---

## 6. Important — `launchInternalUrl` accepts any string

`PATCH /api/apps/:id` validates it as `z.string()`. `javascript:alert(document.cookie)`
is accepted, stored, and surfaces in the **viewer** DTO as `launchUrl`, which Phase 1D
will render as an `href`. An admin-to-viewer stored XSS, planted now and detonated by a
later phase.

**Fix.** Validate the scheme: `http:` and `https:` only, plus the empty/null case for an
app with no URL. Reject anything else with a 400. Use zod 4's `z.url()` where it fits —
note `z.string().url()` is deprecated in zod 4 — and add the scheme check explicitly,
because `z.url()` alone accepts other schemes.

**Test.** `javascript:`, `data:`, and a scheme-relative `//evil.example` are all rejected;
`http://nas.local:8096` and `https://…` are accepted.

---

## 7. Minor — `paused` contradicts the spec

The spec's status table at line 284 lists `paused` alongside exited-non-zero and
`unhealthy` under **down**. `classify` returns `degraded`.

**Fix.** `paused` → `down`, matching the spec. A paused container is not serving, and
`degraded` implies partial service. Update the test added for the paused branch.

---

## 8. Minor — three error shapes for one class of failure

Routes return `{ error }`, `{ error, message }`, and — from adopt at 409/422 —
`{ adopted, failed }` with no `error` key at all. A client cannot write one error handler.

**Fix.** Every non-2xx body carries `error` as a stable machine-readable slug, with
`message` optional and human-facing. Adopt keeps `adopted` and `failed` and gains
`error: 'adopt_failed'` on its non-2xx responses.

---

## 9. Minor — cleanups

- `apps-compose.test.ts` seeds `deleteFileErrors` with a placeholder key and then replaces
  `deleteFile` outright. The seeded entry is dead; use one mechanism.
- Adopt calls `listAppDirectories()` once per requested directory inside the loop. Hoist it.

---

## Carried forward, deliberately not fixed

- **`include:` / `extends:` targets are outside the cache hash** (see 4).
- **`runCompose` returns `ComposeResult`, not the spec's `JobHandle`.** There is no way to
  cancel a hung `pull`, and `execFile`'s 60 s timeout with a 16 MB `maxBuffer` will kill a
  real `pull` mid-flight. 1B-ii owns lifecycle jobs and must change this signature; doing
  it now would churn `compose-config.ts` and every route for no gain this phase.
- **`runCompose` passes no `-p` and no `env`**, so a lifecycle command acts on whatever
  project the current `.env` implies while status uses the stored `projectName`. Fold into
  1B-ii alongside the `JobHandle` change.
- **`statusFor` lives inside the route closure.** 1C's scheduler needs it; extract then.
- **Three test files `skipIf(!hasDocker)`**, and they contain the only coverage of
  `runCompose`'s argument-array injection resistance and compose-root confinement. On a
  Docker-less CI those vanish and the suite still reports green. Docker is present on this
  machine and they ran, but the arrangement is the same silent-false-negative shape this
  project has been bitten by repeatedly. 1B-ii should make the confinement assertions run
  without a daemon.
