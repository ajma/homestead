# Phase 1A — carry-forward into Phase 1B

Written at the end of Phase 1A, after the final whole-branch review and its fix wave.
This is the durable record of what was deliberately left undone and what the next phase
must do first. The per-task scratch workspace it was assembled from is git-ignored and
has been deleted; this file is the part worth keeping.

## Do these before the first app-reading endpoint in 1B

**1. Build the viewer DTO before anything can serve app data.**

The design spec requires "a different serializer, not a filtered one — the viewer DTO is a
distinct type on which compose, `.env`, and log fields do not exist," because
field-stripping "fails open the day someone adds a property."

Phase 1A ships no such type. The final review traced every reachable surface and confirmed
a viewer can read nothing — but *because no endpoint that could serve configuration exists
yet*, not because a projection excludes it. The capability table plus `visibleAppsWhere` is
precisely the filtering model the spec rejects. The guarantee currently rests on
remembering to check `can()` at each new call site.

**2. Seed a `hosts` row at startup.**

`src/server/index.ts` constructs `new LocalHost("local", …)`, and `apps.hostId` has a
foreign key to `hosts.id`, but nothing ever inserts that row. Adoption's first insert in
1B will fail until startup seeds it.

## Verify on the real NAS before Phase 2 wires audit to real users

**`trustedProxies` defaults to loopback, which may be wrong for the actual topology.**

The reasoning in `config.ts` and the spec says cloudflared runs with `network_mode: host`
and reaches Homestead over localhost. But Homestead is itself a container with a published
port, and a connection from the host's loopback to a published container port traverses
`docker-proxy`, which rewrites the source to the bridge gateway (`172.17.0.1`). If that
happens, `X-Forwarded-For` from Cloudflare is discarded for all tunnel traffic, every
external client shares one rate-limit bucket, and audit rows record the gateway.

LAN clients are unaffected either way (DNAT preserves their source). This only bites if
Homestead is *not* also on host networking, which no Dockerfile in this phase settles.

One `curl` through the tunnel against `/api/health` with request logging answers it. Then
either document that Homestead must use `network_mode: host`, or widen the default.

## Deferred minor findings, still open

Each was raised by a per-task or final review, triaged, and consciously deferred.

| # | Finding | Why deferred |
|---|---|---|
| 1 | `apps_host_directory` unique constraint untested (`apps_host_slug` is) | Six lines, no risk either way |
| 2 | Symlinked-directory exclusion from `listAppDirectories` is implicit, resting on `Dirent` lstat semantics | Add the assertion when 1B builds adoption on top of it — a refactor to `stat` would silently start discovering directories outside the compose root |
| 3 | `buildTestApp` has no automatic cleanup | In-memory databases die with the process |
| 4 | `jwksCache` has no size bound | One team domain for the life of a single-team install |
| 5 | Failed last-admin attempts are not audited | Genuine but low value until there is an audit viewer |
| 6 | `POST /api/users` leaves an orphan session row | Cookie is not forwarded so the token is unreachable, but it will appear in any future "active sessions" view |
| 7 | `HOMESTEAD_SECRET_KEY` serves as both the AES-256-GCM key and Better-Auth's `secret` | No known break; an HKDF split with distinct info strings would remove the question |
| 8 | `spa.ts` and `db/client.ts` resolve `dist/web` and `./drizzle` against `process.cwd()` | Correct only if the container WORKDIR is the app root and migrations are copied into the runtime image — check when the Dockerfile lands |
| 9 | `Login.tsx` collapses all errors into one string; `signOut` ignores failure | Acceptable for a skeleton; revisit in 1D |

Two further items were examined and **deliberately closed with no action**: the
`PRAGMA foreign_keys = ON` that is redundant with libSQL's default (it is load-bearing —
the cascade test fails without it, and stock SQLite defaults it off), and a duplicated
commit subject line (rewriting a SHA referenced by the recovery ledger is strictly worse
than an untidy `git log`).

## Things that must not be "simplified" later

Each closes a measured vulnerability and each has a regression test. A future reader will
find all of them slightly odd, which is the point of listing them here.

- **`writeTextFile` uses temp-file-plus-`rename`.** `rename` replaces a symlink at the
  destination rather than following it, closing the TOCTOU window between `PathGuard`'s
  check and the write. A direct `writeFile` follows the symlink.
- **`resolveForWrite` checks the target as well as the parent.** A symlink planted as the
  target inside a legitimate parent was a proven write-anywhere primitive.
- **File modes are read from the destination and reapplied.** `rename` gives the
  destination the temp file's mode, which silently downgraded a user's `chmod 600 .env`
  to `0644`.
- **`encrypt`/`decrypt` take a mandatory `aad`, and `SecretStore.get` passes the
  *queried* name.** Using the stored column would authenticate a row against itself and
  reopen the row-swap.
- **`app.ts` strips client IP headers and substitutes `request.ip`.** Better-Auth resolves
  client IPs from headers alone and cannot see the connection peer, so its `trustedProxies`
  option cannot help — and setting it actually enabled the chain-walk that made forgery
  easy. There is an invariant test coupling the two header lists.
- **`setErrorHandler` precedes every `register()`.** Fastify child contexts capture the
  parent's handler at registration time; installing it afterwards left every encapsulated
  route on the default handler, leaking bound SQL parameters.
- **`lastActiveAdminIsSafe` filters on `disabled_at IS NULL` and is a condition on the
  mutating statement.** Counting disabled admins allowed a two-click, unrecoverable
  lockout; a preceding `SELECT` allowed concurrent removals to interleave.

## Toolchain notes worth keeping

- **Deprecated APIs are invisible to every gate here.** `tsc --noEmit` reports them as
  *suggestion* diagnostics it never prints, and exits 0. TypeScript 7 is the Go port, so
  the compiler API that could enumerate them sits behind `unstable/*`. Biome does not read
  JSDoc `@deprecated`. Three slipped through this phase (`z.string().url()`,
  `z.string().email()`, React `FormEvent`), each caught only by an editor diagnostic.
- **TypeScript 7 removed `baseUrl`.** `paths` targets must be relative with a leading `./`.
- **libSQL enables `foreign_keys` by default**, unlike stock SQLite.
- **Better-Auth writes `users.createdAt`/`updatedAt` in milliseconds** while Homestead's own
  tables use `unixepoch()` seconds. Anything Homestead writes into a Better-Auth table must
  use milliseconds.
