# Phase 1D — carry-forward into 1E and beyond

Written at the end of Phase 1D, after the whole-branch review and its two fix waves. The
per-task scratch workspace it was assembled from is git-ignored and has been deleted.

Phase 1A's, 1B's and 1C's carry-forwards remain live except where noted.

## What 1D shipped

The launcher: `GET /api/launcher` (a cheap indexed query over the denormalised probe
columns, with no Docker call), `GET /api/launcher/:appId/health` (three signals plus a
30-day timeline), the icon service (`GET /api/icons/search`, `GET /api/icons/:file`, disk
cache, offline-tolerant), one shell-level `EventSource` patching the query cache in place,
and the React surface — `AppIcon`, `StatusChip`, `AppCard`, `Launcher`, `HealthPanel`,
`Sparkline` — plus a PWA manifest.

Also, and newly load-bearing: **component tests run at all.** Before Task 1,
`vitest.config.ts` collected only `*.test.ts` in the node environment, so a `.tsx` test
file was not merely unsupported, it was not collected.

## Closed from the 1C carry-forward

- **The SSE-versus-`/api/apps` status disagreement** is resolved for the launcher, which
  was the surface at risk. It reads the debounced status from `probes.lastStatus` and
  receives patches derived from the same source, so its two transports cannot disagree.
  `GET /api/apps`' live rollup remains the admin inventory's concern — **1E must make the
  same choice deliberately.**

Still deferred from that document: no SIGTERM handler (belongs with the Dockerfile);
`runCompose` passes no `-p`; `JobRunner.cancel` is unreachable; `FakeHost.streamLogs`
cannot model an open-ended stream; the config cache ignores `include:` and `extends:`;
purging the icon disk cache is manual.

## Do these in 1E

**1. A probe's enable/disable/delete publishes no event.** `probes.ts` PATCH and DELETE
call neither `events.publish` nor anything else, so every open tab keeps the stale
`ProbeSnapshot` in its cached array. Measured: docker up plus http down reads
`down`/"Containers not running"; disable the http probe and the server would now say
`up`/"Healthy" while open tabs stay wrong until the next reconnect. Bounded to ≤15 minutes
by `MAX_STREAM_MS` → `onOpen` invalidation, and it needs an admin action to trigger. The
fix wants a new SSE frame type — "this app's probe set changed", client invalidates — which
is its own small task. 1E adds the probe-editing UI, so this lands with it or the UI ships
a lie.

**2. An SSE event for an unknown *app* id is dropped with no invalidation.** The
unknown-*probe* case invalidates correctly. An app adopted in another tab therefore does
not appear until a reconnect.

**3. `PATCH /api/probes/:id` with a new `intervalSeconds` leaves `nextRunAt` alone** —
carried from 1C, and 1E is where an admin first edits an interval and expects to see it
take effect.

**4. The client stamps `statusSince` with its own receipt time**, not the server's
transition time. Off by the delivery latency, which is milliseconds — but it means a tile's
age is derived from two different clocks depending on whether it came from a fetch or a
patch.

**5. `target="_blank"` from a standalone PWA** may eject to a full browser rather than
opening in the installed app. Worth testing on a real phone before it becomes a habit.

**6. Manual icon selection and upload.** Task 6 built `GET /api/icons/search` and nothing
consumes it. Adoption now pre-fills an exact-match suggestion, and `PATCH /api/apps/:id`
accepts `iconRef`, so the path exists — but no UI drives it. Spec §8's "manual search,
custom upload" is 1E's.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | `sse-patch-store.ts` never prunes a patch for a deleted probe | The entry sits for the tab's lifetime. Bounded by probe churn per session, not by time. |
| 2 | The launcher's probe select carries no scope predicate | Verified to leak nothing — scope is applied one layer later, when probes are joined to already-scoped apps. The boundary is late, not absent. |
| 3 | `AppCard.test.tsx` names a property it cannot observe | Cosmetic test-name defect; the behaviour is covered elsewhere. |
| 4 | The icon disk cache never expires and has no purge endpoint | Browser caching is one day; the server's is manual. An admin deletes the directory. |
| 5 | `HealthPanel` is nested divs rather than a native `<dialog>` | Measured, not preferred: jsdom 30.0.1 does not implement `HTMLDialogElement.showModal`/`.close`, so a native dialog's modal behaviour would be untestable here. Focus trap, initial focus and restore are implemented by hand. |

## Things that must not be "simplified" later

Each closes a defect that was measured, not hypothesised.

- **`GET /api/launcher` is a separate route from `GET /api/apps`, and touches neither
  `Host` nor `ComposeConfigCache`.** Verified structurally: its import closure is eight
  files with no edge to `host/`, `apps/` or `monitoring/`, and it makes zero Docker and
  zero compose calls with the host throwing. A flag on the existing route would leave the
  expensive path — one `listContainers` plus up to four concurrent `docker compose config`
  spawns — one bad conditional away from the screen whose entire requirement is not to
  have one.
- **`rollUpProbes` lives in `src/shared/` and both sides call it.** The client used to
  write one probe's event straight onto the tile: docker down, then the HTTP probe flips
  up for its own reasons, and the tile read "Healthy" while the containers were still
  down — permanently, because `publish` is edge-triggered and never re-announces an
  unchanged failure. Client and server now run the identical function on the same inputs,
  so disagreement is impossible by construction rather than something tests chase.
- **`rollUpProbes` breaks severity ties deterministically** (older `statusSince`, then
  `probeId`), and the probe select has an `ORDER BY`. Measured: the same app with the same
  health, rows reversed, produced `"No route to the app" · since 500` against
  `"Containers not running" · since 100`. It was right only because adoption happens to
  insert the docker probe first.
- **The launcher grid has a total order**, falling back to `id`. Category, `sortOrder` and
  `displayName` can all tie, and a stable sort faithfully preserves an input order that is
  itself unpinned.
- **The phrase table reads `kind` and `faultClass` together, never `faultClass` first.**
  Reading fault class first made a missing Cloudflare Access token — which the external
  runner emits as `degraded`/`config` — render as "Compose config invalid", sending the
  user to edit a `docker-compose.yml` that was fine. It also made a wedged Docker socket,
  emitted as `down`/`network` with the comment "Not the app's fault", read as "Containers
  not running".
- **Only a strictly-`up` sibling exonerates**, and `http_external` + `app` never exonerates
  at all. Claiming "app is fine" on the strength of a probe that is `unknown` is worse than
  saying nothing, and contradicting the probe's own classification is worse still.
- **A fault-class change publishes only when the debounced status is `down` or
  `degraded`.** Comparing the raw observation instead made a single unconfirmed failure —
  and its recovery — publish, so an ordinary transient blip put one message per probe per
  interval on every open tab. That is the spam the `changed` flag exists to prevent.
- **`Launcher` renders cached data on a *refetch* error and only shows the error screen
  when there is nothing to show.** `isError` alone threw away tiles that were still in
  hand, along with whatever the user was typing into the search box — and the reconnect
  path invalidates several times an hour by design.
- **`isPending`, not `isFetching`.** The mirror of the above: `isFetching` puts a spinner
  over a populated grid on every background refetch.
- **The icon slug passes both a regex and index membership before becoming a URL.** One
  would do today. The regex is the kind of thing a later change loosens, and the index
  check is what keeps the SSRF property true when it does. Homestead sits inside a home
  network; the reachable targets are the router and the NAS's own admin UI.
- **Both icon downloads bound the *read*, not the buffer.** Checking `byteLength` after
  `arrayBuffer()` drove a 357 MB heap delta on a 96 MB body before the check fired.
- **The adoption icon suggestion is exact-match only.** A bidirectional prefix test gave
  `plex-backup` Plex's logo and `media-old` whatever app claims the `media` alias, and
  `-backup`/`-old`/`-data` directories are ordinary on a NAS. A wrong icon is worse than a
  letter tile: the tile is visibly a placeholder, a wrong logo looks deliberate, and nobody
  reports it — they quietly distrust the launcher.
- **`AppIcon`'s `src` is always the local proxy.** Hotlinking would tell a public CDN which
  self-hosted services this household runs, from every viewer's network, and would stop the
  launcher rendering during exactly the outage that makes reaching LAN services urgent.
- **`StatusChip`'s glyph is the visible indicator, not an `sr-only` span.** It was
  previously invisible to sighted users and almost certainly unannounced too, because an
  explicit `aria-label` on the button overrides accessible-name computation from child
  content — a dead span making the never-colour-alone rule look handled.
- **`Sparkline` distinguishes a no-data day from a fully-down day by `probeCount`,** in
  colour, in bar shape, and in per-bar accessible text. Ratios are `0` in both cases;
  conflating them reports an outage for every day before a probe existed, which teaches
  people to ignore the chart.
- **`DayBucket` carries per-probe-averaged ratios, not pooled counts.** Pooling let the
  fastest-polling probe dominate: docker up all day at 60s beside an HTTP probe down all
  day at 300s summed to 83% healthy for an app whose web interface was unreachable
  throughout. The card's status was right; only the history lied, in the reassuring
  direction.
- **`use-now.ts` shares one interval across all consumers.** Thirty tiles must not mean
  thirty timers, and the hook must clear the interval when the last consumer unmounts.
- **The SSE patch store lets a patch survive a stale in-flight refetch.** A refetch whose
  server read predates the transition used to resolve afterwards and overwrite the patch,
  reverting a tile to `up` for up to 15 minutes.

## Toolchain notes

Additions to 1B's and 1C's lists, which all still hold.

- **`environmentMatchGlobs` does not exist in Vitest 5.** It was removed in v4 and is
  absent from the installed types. An unknown key in the `test` block is *ignored*, not
  rejected, so the config looks right while every `.tsx` test runs in the node environment.
  Use the per-file `// @vitest-environment jsdom` docblock. `src/web/test-environment.test.ts`
  enforces it, because forgetting is silent for any test that never renders — measured, a
  `.tsx` file asserting `expect(1 + 1).toBe(2)` passes in node having tested nothing.
- **`@testing-library/react` registers its own `afterEach(cleanup)` on import** whenever a
  global `afterEach` exists, which `globals: true` provides. An explicit one is a backstop
  for the `globals: false` case, not the mechanism — a binding check that removes it stays
  green unless you also set `RTL_SKIP_AUTO_CLEANUP=true`.
- **A global `setupFiles` entry importing Testing Library** loads React into every server
  test worker — roughly 70% of a small server test file's runtime. Import-scope the helper
  instead.
- **`pnpm exec biome check . | tail -1` hides the exit code and a real failure.** Redirect
  to a file and check `$?`.
- **jsdom 30.0.1 does not implement `HTMLDialogElement.showModal`/`.close`.** A native
  `<dialog>`'s modal behaviour cannot be tested here.
- **jsdom does not move focus on a synthetic `keyDown`.** A focus-trap test asserting
  `activeElement` after a Tab keydown passes against no trap at all; assert
  `defaultPrevented` instead.
- **`pnpm build` is a gate no unit test covers.** `public/` handling and the manifest link
  are build-time concerns.

## The failure pattern that dominated this phase

One shape recurred, and it is the one to watch for in 1E: **a test that claims to guard a
line it cannot reach.** The whole-branch review's 39-case mutation sweep put a number on
it — 34 went red, and every one of the 5 survivors was a real hole:

- A focus-trap test whose assertion was also the no-handler state.
- `MAX_ICON_BYTES` with no test at all.
- `requireAuth` untested on the one route that reaches the internet.
- `rm public/icon.svg` leaving the suite green.
- A disabled-probe filter with no coverage.

Earlier in the phase the same shape produced a ranking test whose comment described a
query it never ran, a window test bound to a different clause than its name, and a
health-panel test that mounted one app so it could not tell which app opened.

**The counter-measure that worked, every time: break the line and require the test to go
red.** Reviewers ran it as a sweep; implementers ran it per fix. Where a mutation stayed
green, that was the finding.
