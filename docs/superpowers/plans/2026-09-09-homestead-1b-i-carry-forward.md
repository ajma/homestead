# Phase 1B-i — carry-forward into 1B-ii and beyond

Written at the end of Phase 1B-i, after the whole-branch review and its fix wave. The
per-task scratch workspace it was assembled from is git-ignored and has been deleted;
this is the part worth keeping.

Phase 1A's carry-forward (`2026-09-09-homestead-1a-carry-forward.md`) is still live —
nothing in it was closed by this phase except the `hosts` row seeding and the viewer DTO,
both of which landed here.

## Do these before or during 1B-ii

**1. `runCompose` returns `ComposeResult`, but the spec's `Host` says `JobHandle`.**

There is no way to cancel a hung `pull`, and `execFile`'s `timeout: 60_000` with
`maxBuffer: 16 * 1024 * 1024` will kill a real `pull` mid-flight. 1B-ii owns lifecycle
jobs and has to change this signature; doing it in 1B-i would have churned
`compose-config.ts` and every route for no gain. The `onOutput` hook already in the
signature is what makes SSE land additively.

**2. `runCompose` passes no `-p` and no `env`.**

So a lifecycle command acts on whatever project the current `.env` implies, while status
uses the stored `projectName`. Those can disagree — which is the same class of bug the
reconciliation in 1B-i's fix wave closed for the read path. Fold it into the `JobHandle`
change.

**3. `FakeHost`'s `onOutput` fidelity.**

It emits a single chunk. Real `execFile` streams many, split at arbitrary byte
boundaries — including mid-UTF-8 and mid-line. Every SSE and log-streaming test in 1B-ii
would pass against a fake that cannot reproduce the case those features exist to handle.
Fix the fake before writing those tests, not after.

**4. Extract `statusFor` from the route closure.**

It lives inside `appRoutes` and closes over `db`, `host` and `composeConfig`. 1C's
scheduler needs the same computation.

## Verify on the real NAS

**`trustedProxies` may be wrong for the actual topology** — still open from Phase 1A, see
that document. One `curl` through the tunnel against `/api/health` with request logging
answers it.

## Known gaps, consciously left

| # | Gap | Why it is acceptable for now |
|---|---|---|
| 1 | The config cache hashes `compose.yaml`, `.env` and the four well-known override filenames, but not `include:` or `extends: { file: }` targets | Those can name arbitrary paths and need the resolved config to discover — a chicken-and-egg the fixed override list does not have. An SSH edit to an included file serves a stale service set until restart. |
| 2 | `lastComposeHash` is written and never read | The editor's guard uses the hash it loaded, which is the stronger check. The column is for 1B-ii's drift detection. |
| 3 | Three test files `skipIf(!hasDocker)`, and they hold the only coverage of `runCompose`'s argument-array injection resistance and compose-root confinement | On a Docker-less CI those vanish and the suite still reports green — the same silent-false-negative shape this project keeps hitting. Make the confinement assertions run without a daemon in 1B-ii. |
| 4 | `app:config` and `app:secrets` are both held by admin and neither by viewer, so the split is preparatory rather than load-bearing | It is what makes the reveal auditable as a distinct act, and Phase 2 may introduce a role that holds one without the other. |
| 5 | A scoped principal can still call the collection routes — `GET /api/apps/scan` and `POST /api/apps/adopt` | Scope constrains access to *existing* apps; adoption creates one. A scoped admin is an odd configuration in any case. Revisit if 1D exposes scoping for admins. |
| 6 | A `.env` symlinked outside the compose root reports as absent, and a write then fails closed inside `resolveForWrite` with a generic error rather than a description | Fails closed, which is the important half. |
| 7 | Compose validation's scratch file survives an abnormal termination between the write and the `finally` | It is a dotfile, `docker compose` does not pick it up, and a startup sweep would need a list-files-in-a-directory primitive on `Host` that nothing else wants yet. |

## Things that must not be "simplified" later

Each closes a defect that was measured, not hypothesised, and each has a regression test.
A future reader will find all of them slightly odd, which is why they are listed.

- **`AppStatusSummary` splits `detail` from `adminDetail`.** Raw `docker compose config`
  stderr reached a viewer's `statusDetail` carrying `/volume2/docker/jellyfin/.env` and an
  interpolated `sk-live-…` value. One field that every caller must remember to sanitise
  fails open; two fields make the leak structurally impossible.
- **`statusFor` catches, and an unreachable Docker yields `unknown`, never `down`.**
  Falling back to an empty container list makes the rollup say `down` with "N missing",
  painting every app red and telling the user their whole NAS is broken over one wedged
  socket.
- **`loadApp` is the only way a route loads an app by id.** Eight of ten routes previously
  selected on `eq(apps.id, id)` alone, so a scoped principal got 404 from
  `GET /api/apps/:id` and 200 with the password from `POST /api/apps/:id/env/reveal`. Out
  of scope is 404, not 403, so the answer does not confirm the app exists.
- **`readEnv` distinguishes absent from unreadable, via `Host.fileExists`.** Collapsing
  them was a data-loss path: `.env` is routinely `chmod 600`, so a read failure reported
  "no `.env`", the user created one with `expectedHash: null`, `writeTextFile`'s own read
  failed identically, the guard matched, and the secrets file was replaced.
- **Only an explicit `restart: "no"` makes a clean exit `completed`.** Compose files
  usually omit `restart`, so treating a null policy as one-shot would show green over an
  exited web server.
- **A non-object service entry fails the compose parse rather than being filtered out.**
  Filtering shrinks the expected service set the rollup compares against, so a degraded
  stack would report healthy. Relatedly: `"services": "nope"` once returned `valid: true`
  with four bogus services, because `Object.entries` enumerates a string's characters.
- **A service's state is the worst of its containers'.** Keying containers by service name
  into a plain `Map` kept only the last, so three replicas with the middle one unhealthy
  reported `up`.
- **Compose validation writes to a ULID-named scratch file and invalidates its cache
  entry.** A fixed name raced a debounced editor — one request's cleanup deleted the file
  another was mid-resolve on — and poisoned the path-keyed cache.
- **The adoption scan resolves project names from `COMPOSE_PROJECT_NAME` and compose's
  normalisation, never the raw directory name.** A mismatch does not merely blank a field:
  the stack reads stopped *and* its containers list separately as an orphan. Verified
  against real Docker, where a directory named `jellyfin` correctly resolved to
  `hs-verify-jellyfin`.
- **`launchInternalUrl` is validated by parsing and reading `protocol`.** It reaches the
  viewer DTO and 1D will render it as an `href`, so `javascript:` was an admin-to-viewer
  stored XSS. Prefix matching is not enough — schemes are case-insensitive.
- **`buildTestApp` wraps `inject` with a per-instance source address.** Better-Auth's
  sign-in limiter is process-global and keyed by IP, so the whole suite shared one bucket:
  from the fourth `createViewer` in a process the cookie was empty and the request ran
  unauthenticated. Assertions of the form `expect(x[0]).not.toHaveProperty(…)` then passed
  vacuously against a 401. Do not remove the wrapper, and do not disable the limiter to
  make a test easier.

## Toolchain notes

- **`lib` is `ES2023` while `target` stays `ES2022`.** Deliberate: `target` governs which
  syntax is downlevelled, `lib` declares which runtime methods exist.
- **`vitest` does not typecheck.** A fix wave reported a clean typecheck with six real
  `tsc` errors outstanding, one in production code, because the suite was green. Run
  `pnpm exec tsc --noEmit` as a separate gate, always.
- Everything in Phase 1A's toolchain notes still applies, including that deprecated APIs
  are invisible to every gate here.
