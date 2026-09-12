# Phase 1F — carry-forward into 1G and beyond

Written at the end of Phase 1F, after the whole-branch review and two fix waves. The
per-task scratch workspace it was assembled from is git-ignored and has been deleted.

Phase 1A's through 1E's carry-forwards remain live except where noted.

## What 1F shipped

The compose editor — CodeMirror 6, a compose schema vendored at a pinned commit and walked
by our own code, three completion sources (schema, current document, sibling `.env`),
desktop-only gating, and two lint layers. And the `.env` editor — a masked table with
reveal per row, a raw mode, conflict handling, and add/delete.

This was the first phase permitted new dependencies. Four libraries are now in the tree:
`codemirror`, `@codemirror/lang-yaml`, `yaml`, and the `@codemirror/*` packages that arrive
with `codemirror` and are now declared at their resolved versions.

## Closed from the 1E carry-forward

Nothing — 1E's items were about the admin surfaces and none fell in this phase's scope.
**They are all still open**, and I am naming that explicitly because the last time I wrote
a carry-forward and then planned the next phase without reading it, four of six items were
silently dropped. **1G's plan must open by reading 1E's carry-forward as well as this one.**

## Do these in 1G or soon after

**1. The `.env` table save still receives every secret.** A table-mode save fetches the
whole file to reapply changed keys through `upsertEnv` client-side, so the browser gets
credentials it is not displaying. The audit now records *why* the read happened — the
`reason` distinguishes a save-merge from a deliberate raw reveal — but the read still
happens. The real fix is to move the merge server-side: accept a set of key/value changes
at `PUT /api/apps/:id/env` and apply them with `upsertEnv` there. `upsertEnv` already lives
in `src/shared/env-file.ts` and is importable from both zones, which is most of the work.
The implementer declined this mid-wave as too risky a contract change on the credentials
file under time pressure, which was the right call then and is not a reason to leave it.

**2. Everything in 1E's carry-forward.** `intervalSeconds` leaving `nextRunAt` stale;
`statusSince` stamped with client receipt time; `target="_blank"` from a standalone PWA;
inventory row actions and right-rail metadata; a startup sweep of `jobs` rows stuck at
`running`.

**3. The compose editor has no unsaved-changes protection for in-SPA navigation.** It
covers `beforeunload` only. Real coverage needs `createBrowserRouter` and `useBlocker`,
which is a router migration rather than a component change.

**4. A stale schema pin has no drift signal.** The vendored schema is pinned and refreshed
by hand. Nothing notices when it falls behind, and the failure mode is silent: keys compose
added upstream read as unknown and draw a warning. The current pin is fresh — it carries
`gpus`, `models` and `provider` — so this is not urgent, but it will be.

## Known gaps, consciously left

| # | Gap | Why it is acceptable |
|---|---|---|
| 1 | `pathAt` is indentation-based, so tabs and flow style defeat it | Deliberate: it must work on a document that is invalid most of the time somebody is typing, which a parser would not. Verified that every failure mode returns `[]` — the harmless direction — rather than a wrong list. |
| 2 | No completions inside long-syntax list entries (`- target: 80`) | Short syntax is the common case and is covered. |
| 3 | The `additionalProperties` branch in `compose-schema.ts` is dead | All 61 occurrences in the real schema are `false`. Deleting a defensive branch to satisfy coverage is the wrong instinct. |
| 4 | A leading tab on a block-scalar body line still mis-attributes ancestry | Already broken before the tab fix; a persisting limit of the heuristic, not a regression. |
| 5 | The per-key `.env` conflict UI uses radios where raw mode uses `ConfirmDialog` | Functional; parity is cosmetic. |
| 6 | A `value` change arriving mid-IME-composition with no later change stays unapplied | No flush on `compositionend`. Stale, not corrupting, and self-recovers on the next change. jsdom cannot test real IME, so the guard's test is an honest proxy. |
| 7 | `.env` merge-retry runs once; a second concurrent 409 falls back to the explicit UI | Correct behaviour, just not a loop. |

## Things that must not be "simplified" later

Each closes a defect that was measured, not hypothesised.

- **`yaml-lint.ts` skips the key walk entirely when `doc.errors.length > 0`.** `yaml`'s
  error recovery reparents nodes, so one tab-indentation mistake previously produced two
  syntax errors *plus* two spurious unknown-key warnings on untouched code.
- **It also skips `x-` subtrees and the `<<` merge key.** Without those, the ordinary
  shared-config idiom — `x-defaults: &defaults` with `<<: *defaults` — produced at least
  two spurious warnings on a *correct* file. A gutter that cries wolf is one people stop
  reading, which is the whole feature lost.
- **Unknown keys are a `warning`, never an `error`.** The schema is pinned at a commit, so a
  key compose added upstream is unknown *here*; calling that an error tells the user they
  made a mistake they did not make.
- **`compose-schema.ts` descends `oneOf`/`anyOf`/`allOf` and array `items`.** Without it,
  `build:` and `depends_on:` in object form — mainstream syntax — resolved to nothing, and
  `ports.0` was unknown. Verified after the fix that `nonsense-key` is *still* unknown, so
  widening the walk did not turn the warning off.
- **The curated value table is gated on `isKnownPath` and on path shape, not a bare trailing
  key.** Before the gate, a `restart: ` line inside a `command: |` shell script got the full
  restart-policy list. Exactly one service property in the whole 86 KB schema carries an
  `enum` (`cgroup`), which is why the curated table exists at all — and why it must not
  invent keys.
- **`declaredNames` is a line scan, not a parse.** It runs on every keystroke, when the
  document is invalid far more often than not. A parser throwing there removes completions
  at precisely the moment they are wanted.
- **`envCompletion` honours `$$` and quotes.** `$${` is compose's literal escape, and a
  `${` inside single quotes is never interpolated; both used to raise a popup over text that
  was not a variable.
- **`useSseText`-style discipline in `useServerValidate`: every request carries a sequence
  number and a late response is discarded.** A stale *success* clearing a real error is the
  dangerous direction. The rejection branch's guard had zero coverage until a reviewer
  mutated it.
- **It also validates the response shape at runtime.** A 200 whose body was neither
  `{valid:true}` nor `{valid:false,message}` set `message` to `undefined` and *overwrote* a
  real verdict. A malformed body is transport noise, not a verdict.
- **The server check runs once on load and then on dirty, and is skipped while layer one
  reports a syntax error.** My first version required dirty for everything, which meant a
  file that was already semantically broken — an SSH edit — never got a verdict until the
  user made an unrelated change. One spawn per tab open buys the answer they came for.
- **There is an in-flight gate.** Without it, ten seconds of typing at a 2.5 s round trip
  produced 14 requests and 4 concurrent `docker compose config` spawns.
- **`YamlEditor` maps the selection when an external value replaces the document**, keeping
  anchor and head in order and clamping to the new length. Without it, a change differing
  only by a trailing newline moved the caret to 0, and a range selection inverted to
  `{anchor: 7, head: 0}`.
- **`extraExtensions` is identity-keyed and `ComposeTab` memoises it.** A freshly-built
  array reconfigures the CodeMirror compartments on every keystroke.
- **`lintGutter()` and the diagnostics panel are both present.** With only `setDiagnostics`,
  the message text appeared nowhere in the DOM — reachable by hover, `Mod-Shift-m` or `F8`
  — so on touch, the platform CodeMirror was chosen for, a warning was unreadable.
- **`ComposeTab` and `EnvTab` are lazy-loaded behind per-tab error boundaries.** The split
  takes the initial chunk from 928 kB to 329 kB, the pre-phase baseline; the launcher a
  viewer opens must not pay 600 kB for an admin-only editor. The boundaries are per-tab with
  an `onRetry` that recreates the lazy component — a shared boundary would replay the same
  failure, and without any boundary a failed chunk load unmounts the whole root.
- **Reveal is per-key and uncached, and whole-file reveal does not go through `useQuery`.**
  Raw mode previously left every secret in the TanStack cache for five minutes and in
  component state for the tab's life, defeating per-row reveal after a single visit.
- **`handleUseDiskVersion` clears pending edits, adds and deletes.** It did not, and the
  dialog promised it did: a pending delete survived the reload and the next save silently
  removed a credential from the disk content the user had just chosen to adopt.
- **The `.env` 409 auto-merge refuses to merge a key the concurrent edit also touched or
  deleted.** Silently winning a same-key conflict on a secrets file can revert a credential
  rotation; re-appending a deleted key undoes an intentional removal.
- **The vendored schema is checked in and pinned by SHA, never fetched at runtime**, and its
  test asserts the `patternProperties` → `#/$defs/service` wiring, not just that
  `$defs.service` has properties. Upstream could restructure `services` and leave
  `$defs.service` untouched, and every other assertion would still pass while the editor
  silently offered nothing.

## Toolchain notes

Additions to the earlier lists, which all still hold.

- **pnpm's isolated linker refuses phantom imports, and that is a feature.** `YamlEditor`
  imported `@codemirror/lint`, `/state` and `/view` while only `/lang-yaml` was declared. The
  first fix was `nodeLinker: hoisted`, which resolves it by flattening every dependency in
  the project and giving up that protection permanently. Declaring what you import is the
  smaller change: no new library enters the tree, the versions are the ones the meta-package
  already resolved.
- **`minimumReleaseAgeExclude` in `pnpm-workspace.yaml` is load-bearing.** Verified by
  removing it: `pnpm install` fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` because
  `yaml@2.9.1` is newer than the policy allows.
- **Concurrent `pnpm` operations corrupt `package.json`.** Three separate agents saw it
  transiently reverted this session, twice while another agent was installing. Run no
  dependency-installing task alongside anything else.
- **Node 24 has no global `EventSource`** without `--experimental-eventsource`.
- **jsdom gives every element zero geometry**, so no assertion may depend on rendered size,
  scroll or visible lines. It also cannot exercise real IME.
- **`pnpm exec biome check . | tail -1` hides the exit code.** Redirect and check `$?`.
- **`pnpm build` is the only gate that exercises the browser bundle**, and after this phase
  it is also the only one that would notice the code split regressing.

## The failure pattern that dominated this phase

**A test that cannot discriminate the thing it is named for.** Not absent tests — present
ones, green ones, that pass equally against the code and against its removal:

- A brief-supplied comment-skip test whose comment shared the target's indent, so it was
  already excluded by a different rule.
- `use-server-validate`'s rejection-branch sequence guard: deleting it left all ten tests
  green.
- The `rawLoaded` guard keeping plaintext out of state: replacing it with `if (true)` left
  all 1095 green.
- Two "returns nothing" schema tests that passed against a constant `[]`.

The counter-measure is the one this project keeps relearning: **break the line and require
red.** Where that is impossible — as with `rawLoaded`, where nothing in the component reads
the state while the guard is false — the answer is to extract the decision into a pure
function and test it directly, which is what shipped. A guard you cannot mutate-test is a
guard you do not have.
