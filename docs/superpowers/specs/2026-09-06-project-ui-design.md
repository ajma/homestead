# Homestead — Project UI Design

**Date:** 2026-09-06
**Status:** Approved for implementation planning
**Extends:** `docs/superpowers/specs/2026-09-05-homestead-design.md` (§5 project model, §6 roles, §7 Docker execution)
**Consumes:** Plan 2's server API, merged at `0b7deff`

---

## 1. Purpose and scope

The browser interface for managing Docker Compose projects: discovering what is on
disk, creating and deleting projects, editing their compose and `.env` files, running
lifecycle commands, and watching output.

It also establishes the **design system** the rest of the product will be built on —
a token layer with light and dark themes, and the scoped-override mechanism the
customizable dashboard will later use.

### In scope

- The app shell: navigation, theme toggle, sign-out, 404 route.
- Project list, project detail (overview / edit / logs), create, delete.
- A structured `.env` editor and a CodeMirror compose editor.
- Two new server routes: `POST /api/projects` and `DELETE /api/projects/:slug`.
- Full functional parity between desktop and mobile, enforced by tests.

### Not in scope

- **The dashboard / app grid.** A later plan; this plan builds the seam it needs.
- **Device management.** A separate subsystem with its own design cycle.
- **Rename**, and **named-volume deletion** — grouped together as one volume-hazard
  task set (§8).
- **Serving the built SPA from Fastify** — packaging owns that. Development runs Vite
  alongside the API.

### Plan sequence after this document

Project UI (this) → Devices → Dashboard → Packaging.

---

## 2. Design system and theming

### 2.1 Two layers

A **token** layer of semantic CSS custom properties, and a **component** layer that may
reference only tokens.

```
--color-bg          --color-text          --color-accent
--color-surface     --color-text-muted    --color-danger
--color-raised      --color-border        --color-success
--color-overlay                           --color-warning

--radius-sm|md|lg   --space-*   --font-sans|mono   --shadow-*
```

Names are semantic, never palette-derived. A component asks for `bg-surface`, never
`bg-slate-800`. Dark mode therefore requires no per-component work: only the token
values change.

### 2.2 Light and dark

Light values live on `:root`; dark overrides under `[data-theme="dark"]`. The attribute
sits on `<html>`.

Colour scheme is a **device preference, not instance configuration**: it defaults to
`prefers-color-scheme` and is overridable by a toggle persisted in `localStorage`. It
needs no server storage and is deliberately independent of the admin-controlled
dashboard styling (§2.4) — someone checking a stack at night wants dark regardless of
the household style.

### 2.3 The rule that makes it hold

**No hardcoded colour may appear in a component.** A single screen using a palette
utility stops responding to themes, and the failure is invisible until someone switches
mode.

This is enforced, not merely documented: a test scans `src/web/**/*.tsx` for raw hex
values and Tailwind palette utilities (`bg-slate-*`, `text-red-*`, …) and fails if any
appear outside the token definition.

### 2.4 The dashboard override seam

Built here, consumed by the dashboard plan.

- A stable `.hs-dashboard` wrapper element.
- A documented set of `data-hs-*` attributes as the supported styling hooks. Internal
  class names are explicitly **not** a supported surface; the attributes and the token
  variables are.
- Admin-authored customization applied as scoped custom-property declarations plus one
  scoped `<style>` block.

Customization is **instance-wide and admin-only** to write. Two consequences:

- Scoping is a safety property, not tidiness. User CSS is confined to the dashboard
  subtree and cannot reach any other screen — including whichever screen the dashboard
  plan puts the customization controls on. A stylesheet that destroys the dashboard
  therefore still leaves the page where you would go to remove it. An escape hatch that
  can lock you out is not one.
- Admin-only authorship closes an exfiltration channel. CSS is not inert — attribute
  selectors combined with `background-image: url(...)` can leak values, and
  `position: fixed` can overlay anything. That is acceptable when the author is already
  root-equivalent. It would be a vulnerability if a viewer could author CSS that renders
  in an admin's session, so viewers never can.

### 2.5 Component set

Button, IconButton, Tabs, SegmentedControl, Field/Input, Panel, StatusDot, Badge,
EmptyState, Spinner — hand-rolled against the tokens.

**Dialog** is the only primitive taken from a headless library. Focus trapping, scroll
locking, escape and back-button handling, and focus restoration are where hand-rolled
modals fail, and the destructive delete confirmation must be correctly keyboard-operable.

The plan therefore adds two runtime dependencies in total: a headless dialog, and
CodeMirror (§4.1). Everything else is hand-rolled against the tokens.

---

## 3. Screens and information architecture

### 3.1 Routes

Tab state lives in the path, so browser history and deep links work.

```
/                            dashboard placeholder (a later plan replaces this)
/projects                    list
/projects/new                create
/projects/:slug/overview
/projects/:slug/edit
/projects/:slug/logs
*                            404
```

### 3.2 App shell

Header: product name, `Dashboard | Projects` navigation, theme toggle, user menu.

The user menu carries **sign-out**, which does not currently exist anywhere in the
product — Plan 1 exported `signOut` and never called it. The **404 route** is likewise
a Plan 1 gap closed here.

### 3.3 Project list

One row per discovered directory: name, status dot, service count, compact port
summary.

Directories with no compose file appear as a muted "not a project" row rather than
being hidden. Spec §5.3 is explicit that silent disappearance is worse than a confusing
row — a user who cannot see their directory cannot act on it.

Empty state explains `HOMESTEAD_PROJECTS` and offers **New project**.

### 3.4 Project detail

**Persistent header** — back, project name, status dot, lifecycle controls
(Up / Down / Restart / Pull), and an overflow menu holding Delete.

Controls never move into a collapsible region. The distinction that governs the layout:
content is either *reference you glance at* (may be hidden) or *an action you reach for*
(must not be). Restarting a stack from a phone is the primary mobile job; it cannot live
two taps deep inside a drawer.

**Overview | Edit | Logs.** On desktop, Overview is a collapsible left sidebar and the
other two are the main panel. On phones the same content becomes three peer tabs. One
set of content, two presentations, no overlay or scroll-lock behaviour to get right on
touch.

- **Overview** — services table (name, image, state, and each published port badged
  *LAN-reachable* or *tunnel-only* from `PublishedPort.loopbackOnly`), snapshot list,
  recent operations.
- **Edit** — a segmented `Compose | .env` control. See §4.
- **Logs** — service filter, follow/pause, tail size.

### 3.5 Operation panel

Starting a lifecycle command docks a panel at the bottom, above the tabs, showing live
output. It persists across tab switches, so a four-minute `pull` does not prevent
editing or reading container logs. Full-screen on phones. Auto-collapses on success;
stays open on failure, because a failed `up` is precisely when the output matters.

### 3.6 Create

`/projects/new` asks for a slug — validated client-side against the same rules as the
server, and marked permanent, since rename is deferred — then offers a blank scaffold or
a pasted compose file, and lands the user in the editor.

### 3.7 Delete

A dialog requiring the slug to be typed. A **second confirmation** when the project was
adopted rather than created.

Spec §5.5 requires that second confirmation but the server stores no provenance flag.
The signal already exists for free: §5.2's `x-homestead.source` is written on creation,
and adopted projects have no `x-homestead` block at all. **Absence of that key is the
provenance marker** — and it identifies exactly the case where the directory is likeliest
to contain something the user cares about.

Named volumes are **not** removed; the dialog lists the orphans it is leaving behind and
how to remove them. See §8.

This requires a small server change: `ProjectModel` currently carries `projectName`,
`services` and `meta`, but not the project's top-level named volumes, so the dialog has
nothing to list. `parseCanonical` gains `volumes: string[]` from the canonical config's
top-level `volumes` keys. The Overview tab shows them too — knowing which volumes a
project owns is useful well before you delete it.

---

## 4. The editors

### 4.1 Compose — CodeMirror 6

Chosen under the constraint of full mobile parity, which rules out Monaco: its own
documentation states mobile browsers are unsupported, and it ships several megabytes
plus web workers — a poor fit for a SPA served from a NAS.

CodeMirror 6 provides YAML highlighting, bracket and indent awareness, line numbers,
search, and inline lint markers at roughly 150–200 KB.

**Phone keyboards have no Tab key, and YAML is indentation-sensitive.** A touch toolbar
above the editor therefore provides indent, outdent, and save. Without it, mobile compose
editing is theoretically available and practically impossible.

Syntax errors surface inline as you type; `POST /api/projects/:slug/validate` remains the
authoritative check on save, because only `docker compose config` knows the real schema.

### 4.2 `.env` — a structured form

`.env` is key/value data and deserves a form rather than a text editor. The form's real
advantage over a textarea is not ergonomics but **capability**: it can validate keys,
quote values correctly on write, and mask secret-looking values.

**Round-trip preservation is a hard requirement.** The file is modelled as an ordered
list of lines — comment, blank, or entry — and editing an entry leaves every other line
byte-identical. People annotate `.env` files heavily ("# get this from the Immich admin
panel"); rebuilding the file from the form's key/value pairs would delete all of it on
first save. This is the same discipline applied to compose files via `yaml`'s Document
API.

The parser must handle, per §9.2: comments, blank lines, `export` prefixes, single and
double quoting with differing interpolation semantics, inline comments on unquoted
values, and self-interpolation.

A **raw toggle** shows the file as text in CodeMirror. The form covers ordinary
key/value lines; multi-line values, exotic quoting, and anything the parser does not
model remain editable rather than becoming unreachable.

When a project has no `.env` at all — `readProjectFile` returns `null`, which the route
renders as 404 — the form shows an empty state offering to create one. The first save
writes the file; `writeProjectFile` already handles a target that does not yet exist and
correctly takes no snapshot in that case.

---

## 5. Data flow, real-time, and state

### 5.1 Queries versus streams

TanStack Query owns reads: `['projects']`, `['project', slug]`. Operation output and
container logs are append-only streams handled by `useOperationStream(id)` and
`useLogStream(slug, opts)`, writing to component state. Modelling an append-only stream
as query cache means fighting the library on every chunk.

### 5.2 The operation lifecycle

`POST /api/projects/:slug/{verb}` → `202 { operationId }` → open the SSE stream → render
into the docked panel → on the terminal event, invalidate `['project', slug]` and
`['projects']`.

**No optimistic updates.** A `pull` takes minutes; a UI claiming success before the exit
code arrives is lying.

### 5.3 Reconnection

`EventSource` reconnects automatically, and the server's registry **replays its entire
buffer** to any new subscriber. A dropped mobile connection would therefore re-deliver
everything. The stream hooks clear accumulated output on each `open` and treat the replay
as the source of truth, rather than appending to what they already have.

A reload mid-operation resolves through `GET /api/operations/:id`, which reads memory and
falls back to the database.

### 5.4 Freshness

Polling: `refetchOnWindowFocus` plus a modest interval on the list. The dashboard plan
replaces this with the Docker Engine event stream; anything cleverer built here would be
discarded.

### 5.5 Errors

| Class | Handling |
|---|---|
| 401 | Global redirect to login |
| 403 | Inline — a viewer reached an admin surface |
| 409 | "An operation is already running", surfaced in the panel |
| 5xx | Generic message plus retry; the server deliberately does not leak internals |

### 5.6 Unsaved changes

Tracked per editor, with a router blocker on navigation and a guard when switching
between `Compose` and `.env`.

---

## 6. New server routes

Both permissions already exist in Plan 1's access-control statement
(`project: [read, create, update, delete, control]`) and are admin-only.
**`src/server/auth/permissions.ts` is not modified by this plan.**

### 6.1 `POST /api/projects` `[project:create]`

Body: `{ slug, source: "blank" | "paste", content? }`.

Validates the slug through the existing `isValidSlug` boundary, returns 409 if the
directory exists, creates it, and writes the compose file.

The blank scaffold — note the comment sits *above* an explicit empty map, per §9.3:

```yaml
name: <slug>
x-homestead:
  schemaVersion: 1
  source: { kind: blank }

# Add services below, for example:
#   web:
#     image: nginx
#     ports: ["127.0.0.1:8080:80"]
services: {}
```

A pasted file is written as given and validated *afterwards*, returning
`{ slug, valid, error? }`. Invalid content is deliberately not rejected: the detail page
already surfaces `parseError`, and refusing the paste discards content the user has
nowhere else to put.

A pasted file also has `x-homestead: { schemaVersion: 1, source: { kind: paste } }`
injected, so provenance is consistent — without it a pasted project would be
indistinguishable from an adopted one and would wrongly trigger the second delete
confirmation. The injection must preserve the user's comments and formatting, which
means editing the document rather than reserialising it.

That requires `src/server/projects/doc.ts` — the comment-preserving `yaml` Document
wrapper that was written into Plan 2 and then **dropped before implementation because
nothing consumed it**. It now has a consumer, which was the stated condition for
bringing it back. It arrives here with a caller rather than ahead of one.

### 6.2 `DELETE /api/projects/:slug` `[project:delete]`

Requires the typed slug. Runs `compose down` — the wrapper's allow-list makes passing any
volume flag impossible — then removes the directory. Second confirmation when
`x-homestead` is absent.

Named volumes are retained and reported. Removing them is deferred (§8).

---

## 7. Testing

### 7.1 Parity is enforced, not asserted

Playwright runs **the same specs at two viewport projects**, desktop and phone. A layout
that breaks at 390 px fails CI rather than being discovered in use.

### 7.2 Unit (Vitest)

- **The dotenv parser**, most heavily. Its failure mode is silent destruction of user
  content, so round-tripping is table-driven against every case in §9.2: parse, edit one
  value, serialise, and assert every other byte is unchanged.
- Theme token resolution.
- Slug validation. `isValidSlug` **moves from `src/server/projects/store.ts` to
  `src/shared/projects.ts`** and both sides import it. A client-side copy "mirroring" the
  server's rules is two implementations that will drift, and a validator that drifts
  either rejects valid input or lets invalid input reach the traversal boundary. One
  implementation, imported twice.

### 7.3 Component (`@testing-library/react` + jsdom)

Two components only: the `.env` form, because its round-trip is a data-integrity
property; and the unsaved-changes guard, which is easy to get subtly wrong and tedious to
cover end-to-end.

### 7.4 End-to-end

Create → edit compose → save → `up` → watch the operation panel → observe the exit code →
open Logs. Delete with the typed-slug confirmation. A viewer denied every admin surface.

### 7.5 Design-system conformance

The scan described in §2.3.

### 7.6 Explicitly not tested

CodeMirror's own behaviour. Tests asserting that syntax highlighting works or that Tab
indents assert the library's contract, not ours. What is worth testing is the seam: that
editor content reaches `PUT .../file/compose` intact, and that the touch toolbar's indent
button produces the same result as Tab.

---

## 8. Deferred, with reasons

| Item | Why |
|---|---|
| **Rename**, and **named-volume deletion** | The same hazard wearing two hats. Both destroy named volumes when slightly wrong, because volumes are prefixed by the compose project name. One task set gets the dry-run treatment rather than two plans doing volume surgery casually. |
| Missing-variable detection | Cross-referencing `${VAR}` in compose against `.env` keys would catch the blank-password failure in §9.2. Considered and deferred; a strong candidate for the dashboard plan. |
| Secret masking in the `.env` form | Considered and deferred. |
| Snapshot restore | The detail page lists snapshots; restoring one has no route yet. |
| Dashboard customization UI | This plan builds the seam; the dashboard plan builds the controls. |

Carried in from earlier plans and still open: relax the `?service=` regex, which is
stricter than Compose itself and rejects an empty value; surface stream-level errors as
SSE `error` events rather than a silent empty stream.

---

## 9. Verified behaviours

Confirmed experimentally during design. Each is recorded because assuming it wrongly
produces a silent failure.

### 9.1 Tailwind 4 emits tokens as runtime-overridable CSS variables

With `tailwindcss@4.3.3`, an `@theme` block emits each token as a custom property and
every utility resolves through it:

```
--color-surface: #ffffff;
.bg-surface { background-color: var(--color-surface); }
```

Tailwind is otherwise a build-time tool. This is what makes runtime theming — and the
dashboard's scoped overrides — possible without recompiling CSS on the server.

### 9.2 Compose `.env` semantics

```
export EXPORTED=yes         → "yes"           (prefix stripped)
INLINE=value # trailing?    → "value"         (inline comment stripped, unquoted only)
QUOTED="has spaces"         → "has spaces"    (quotes stripped)
SINGLE='$NOTEXPANDED'       → literal $       (single quotes do not interpolate)
ESCAPED="line\nbreak"       → literal \n      (not expanded)
INTERP=${PLAIN}-suffix      → "hello-suffix"  (.env self-interpolates)
EMPTY=                      → ""
```

And the one that matters most: a variable referenced by compose but **absent from
`.env` resolves to an empty string**, with a warning emitted only to stderr —
`level=warning msg="The \"NOT_DEFINED\" variable is not set. Defaulting to a blank
string."` A database comes up with a blank password and the stack appears healthy. No
web UI surfaces stderr, which is why the deferred missing-variable check in §8 is worth
revisiting.

### 9.3 Compose scaffold validity

```
services: {}                    → valid config ("up" reports "no service selected")
(no services key)               → valid config
services: + only comments       → INVALID: "services must be a mapping"
```

The instinctive scaffold — `services:` followed by a commented-out example — parses as
`null` and produces an invalid file. The comment must sit above an explicit empty map.
