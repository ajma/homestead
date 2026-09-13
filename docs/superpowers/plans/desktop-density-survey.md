# Desktop density survey

Read-only survey of every screen/panel in the Homestead webapp, at the request of a user
running a 32" (2560px+) monitor who finds the desktop view "really bad, everything is too
sparse." Structural cause already established: widest container anywhere is `max-w-5xl`
(1024px), one `xl:` breakpoint total, no `2xl:`, grids top out at `lg:grid-cols-4`. This
document is the per-screen detail a grep can't give: what's deliberate, what's incidental,
what the wide layout should look like, and where vertical/horizontal space is wasted today.

No files were changed. All line numbers are current as of `main` at survey time.

---

## Launcher — `src/web/routes/Launcher.tsx`

**Outer constraint:** `<div className="mx-auto max-w-5xl p-4">` (line 54) — hard 1024px cap,
centered, on every screen size.

**Layout:** grouped sections (`space-y`/`mb-6` between category headers), each a
`grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5` (line 83).

**Vertical rhythm:** `p-4` page padding, `gap-3` grid gap, `mb-6` between category sections,
`mb-2` header-to-grid, `AppCard` itself `gap-3 p-3` (AppCard.tsx line 34).

1. **Deliberate or incidental?** Incidental. A card grid is exactly the kind of content that
   should use available width — this is not prose.
2. **Natural wide layout:** more tiles per row. The grid math already reaches
   `xl:grid-cols-5` (spec §8 literally asks for "3–5 across on desktop" — this technically
   satisfies the letter of the spec), but that's moot: with the 1024px outer cap, 5 columns
   of ~190px cards fit inside 1024px, not spread across a 2560px or 3840px screen. **The
   `max-w-5xl` wrapper is the single highest-leverage fix in this whole survey** — remove or
   raise it and add a `2xl:grid-cols-6`/`7` step, and this screen alone goes from "narrow
   column with huge margins" to using the monitor.
3. **Hidden/truncated on desktop:** nothing behaviorally hidden — this is purely a
   too-narrow-container problem, not a stacking problem.
4. **Wasted vertical space:** none notable; `gap-3`/`mb-6` are reasonable for a tile grid.

**Must not change:** the viewer's launcher must stay simple and phone-usable. Widening the
container and adding more columns doesn't touch that — mobile still gets `grid-cols-2` via
the same breakpoints, untouched. Card content, search box, and category grouping should stay
exactly as they are; only the *container width* and *max column count* are the issue.

### `AppCard` (`src/web/components/AppCard.tsx`)

No independent width constraint — it's a grid child, sized by the grid. Internally
`flex items-center gap-3 rounded-2xl border ... p-3`. Nothing to widen here; this component is
correctly sized for a tile and should stay a compact horizontal card regardless of viewport.

### `StatusChip` (`src/web/components/StatusChip.tsx`)

Inline chip, no width constraint, correctly small. Not a density concern at any viewport.

### `HealthPanel` (`src/web/components/HealthPanel.tsx`)

Bottom sheet on mobile, `sm:max-w-md` (448px) popover on desktop (line 111). **Deliberate and
correct** — this is a small fact panel (three signals + a sparkline), reading-width is right.
Widening this would actively hurt: it's meant to be glanceable, not a dashboard.

### `Sparkline` (`src/web/components/Sparkline.tsx`)

SVG with a `viewBox` of `240×32` rendered at `h-8 w-full` — scales via CSS regardless of pixel
viewBox values, so it already fills whatever container `HealthPanel` gives it. Not an offender
at any screen width.

---

## Admin inventory — `src/web/routes/AdminApps.tsx`

**Outer constraint:** `<div className="mx-auto max-w-5xl p-4">` (line 129) — same 1024px cap
as the launcher.

**Layout:** a genuine `<table>` (line 154), collapsing to block rows below `md`. Desktop
columns today: **App, Status, Directory, Last deploy, Actions** (lines 157-161).

**Vertical rhythm:** `md:px-4 md:py-3` per cell, `p-3` per mobile row block, `mb-4` header row.

1. **Deliberate or incidental?** Incidental, and worse than the launcher: this is a data
   table, and a 1024px cap on a data table is exactly the anti-pattern the brief called out.
2. **Natural wide layout:** more visible columns, at real width. **Spec §8 explicitly lists
   the columns this table should have: "name, status, exposure hostname, image-update count,
   last deploy, row actions."** The shipped table has name/status/last deploy/actions but is
   missing **exposure hostname** and **image-update count** entirely — those aren't just
   hidden by narrowness, they were never built. This is a content gap, not only a width one.
3. **Hidden on desktop purely because of phone-first design:** the `Directory` column exists
   but truncates (`truncate text-xs ... md:text-sm`, line 197) — on a 2560px display there is
   no reason a full compose directory path should ever need to truncate.
4. **Wasted space:** the table is `w-full` inside the 1024px cap, so at 2560px it's centered
   with roughly 700px of dead margin on each side while sitting nearly empty of columns for
   the width it does have.

**Recommendation:** drop or raise the outer cap for this route specifically, add the two
missing §8 columns, and stop truncating `Directory` once there's room.

**Must not change:** the mobile collapse to stacked block-rows (`block md:table-row` etc.) is
correct and orthogonal to the desktop-width problem — leave it.

---

## Edit page shell — `src/web/routes/EditApp.tsx`

**Outer constraint:** none on the page body — no `max-w` anywhere in this file. The
`<header>` is full-bleed; the `<div className="flex flex-col gap-4 p-4 lg:flex-row">`
(line 159) has no cap either, so `main` (line 160, `min-w-0 flex-1`) grows to fill whatever
width is available.

**Layout:** header (icon, name, status chip) → tab nav (line 139) → `main` (tab content) +
`aside` right rail (line 163).

**The right rail already exists** — this is worth stating plainly since spec §8's "persistent
right rail on desktop carrying actions, exposure, image updates, and metadata" reads like it
might be missing. It is not: `<aside>` at `lg:static lg:w-72 lg:shrink-0` (line 163) holds
`ActionBar`, `ImageUpdates`, and `AppMetadata` (lines 164-166), and is a fixed bottom bar
below `lg`. **What's missing from it is exposure**: spec §8 names four things the rail should
carry — actions, exposure, image updates, metadata — and the shipped rail has three of the
four. Exposure status/hostname is not surfaced here; it exists only inside the `Exposure` tab,
one click away. That is the one concrete §8 rail gap.

1. **Deliberate or incidental (rail width)?** `lg:w-72` (288px) fixed regardless of viewport
   is fine/deliberate — this is a metadata sidebar, not a data view, and 288px of key-value
   pairs and buttons doesn't need to grow just because the monitor did.
2. **Natural wide layout:** `main` already gets all the remaining width — that part is
   correct. The problem is what individual tabs do with it (see below).
3. **Hidden/truncated purely for phone:** nothing at this shell level; the tab content is
   where things stack unnecessarily (see `OverviewTab`, `ConfigTab` below).
4. **Wasted space:** none at the shell level.

**Must not change:** the `lg:` breakpoint switch between fixed-bottom-bar (mobile) and static
right rail (desktop) is the right mechanism and was deliberately built to avoid a JS media
query (see the file's own comment) — don't touch it.

---

## `OverviewTab` — `src/web/routes/edit/OverviewTab.tsx`

**Outer constraint:** none — `<div className="flex flex-col gap-6">` (line 187), a plain
vertical stack, sized by whatever `main` gives it (i.e., nearly the whole screen minus 288px
at 2560px wide).

**Layout:** single-column form — Display name, Description, Category, Icon, two checkboxes,
Save — followed by a `dl` `grid-cols-1 sm:grid-cols-2` fact block (line 276), then a danger
zone.

1. **Deliberate or incidental?** **Incidental, and the most visually broken item in this
   survey.** The text `<input>`s and `<textarea>` (lines 191-220) have no `max-w` at all, so
   at 2260px of available width (main's share at 2560px viewport) a single-line "Display
   name" field stretches to roughly that width — a single line of text in a text box nearly
   2000px wide. This is a form, not a table; it should have a reading-width cap.
2. **Natural wide layout:** a `max-w-md` (or similar) cap on the form column, with label
   beside input rather than label-above-input once there's room (currently every field is
   `flex flex-col gap-1`, label stacked above input, at every width — see point 4).
3. **Hidden/truncated on desktop:** nothing hidden; this tab actually has the opposite
   problem (unconstrained stretch).
4. **Wasted vertical space:** every field is label-above-input (`flex flex-col gap-1 text-sm`,
   e.g. line 189) regardless of viewport. On a 32" screen there is easily room for
   label-beside-input, which would cut this form's vertical footprint roughly in half. The
   `dl` block below (line 276) already does the right thing at `sm:` (2-column), but the form
   above it never does.

**Recommendation:** cap the form column (e.g. `max-w-lg`) so inputs stop stretching, and
consider a `lg:grid-cols-[auto_1fr]` label/input layout at that width to cut vertical scroll.

---

## `ContainersTab` — `src/web/routes/edit/ContainersTab.tsx`

**Outer constraint:** none; `<ul>` (line 185) fills `main`'s width.

**Layout:** one expandable row per container, each row `flex flex-col ... sm:flex-row
sm:items-center sm:gap-3` (line 197) with four free-floating fields (name, image, state,
status) — not a table, so nothing lines up in columns between rows.

1. **Deliberate or incidental?** Incidental. This is exactly the tabular data §8 has in mind
   for the admin inventory, just for one app's containers instead of all apps.
2. **Natural wide layout:** a real table (or CSS grid with fixed column templates) so name,
   image, state, and status align vertically across rows — right now each row is an
   independent flex line, so column boundaries drift row to row and a 2260px-wide row has a
   huge ragged gap after the last field.
3. **Hidden/truncated purely for phone:** `truncate` on name/image/status (lines 199-207) —
   with real column widths at desktop size these wouldn't need to truncate.
4. **Wasted space:** the expanded detail panel's `dl` is already `sm:grid-cols-2` (line 77) —
   fine — but the collapsed row itself wastes the width a table would use for alignment.

**Recommendation:** convert the row to a CSS grid with a fixed column template
(`grid-cols-[1fr_1fr_auto_auto]` or similar) at `md:`+, matching `AdminApps`' table pattern.

---

## `LogsTab` — `src/web/routes/edit/LogsTab.tsx`

**Outer constraint:** none on the wrapper; the log pane itself is `h-96` **fixed** (line 140,
384px) regardless of viewport height.

**Layout:** container `<select>` + Follow checkbox in a row, then the fixed-height `<pre>`.

1. **Deliberate or incidental?** Incidental for desktop. A fixed 384px pane made sense as a
   safe default but wastes exactly the vertical room a big monitor has plenty of.
2. **Natural wide layout:** a taller pane at `lg:`+ (e.g. `lg:h-[70vh]`) so a 32" monitor
   shows meaningfully more scrollback without scrolling.
3. **Hidden/truncated on desktop:** nothing structurally hidden, just under-sized.
4. **Wasted vertical space:** yes — concretely, `h-96` (384px) is a small fraction of a
   1440px+ tall desktop viewport.

---

## `ProbesPanel` — `src/web/routes/edit/ProbesPanel.tsx`

**Outer constraint:** none; `<ul>` (line 211) fills `main`.

**Layout:** one row per probe, `flex flex-col gap-2 ... sm:flex-row sm:items-center
sm:justify-between` (line 218) — label/reason, status chip, enabled checkbox, delete button,
spread with `justify-between`.

1. **Deliberate or incidental?** Mildly incidental — `justify-between` at 2260px spreads four
   small elements across the full row width with large gaps between them, which reads as
   sparse but is not as broken as `OverviewTab`'s inputs.
2. **Natural wide layout:** a fixed-column grid (label | kind/target | status | enabled |
   delete) the same way `AdminApps`' table lays out — would look denser and let multiple
   probes' fields align.
3. **Hidden on desktop:** nothing hidden.
4. **Wasted space:** the row-level `justify-between` spread rather than tight column widths.

**Add-probe form** (`max-w` none, line 274 `flex flex-col gap-3` card) is short (kind, target,
label) and fine to stay a compact stacked form — this one **should** stay narrow; it's a
small, occasional creation form, not a data view.

---

## `ConfigTab` (Compose + Env side by side) — `src/web/routes/edit/ConfigTab.tsx`

**Outer constraint:** none; `flex flex-col gap-4 md:flex-row` (line 45), two `min-w-0 flex-1`
panes (lines 56, 59) splitting whatever width `main` has 50/50 at `md:`+.

1. **Deliberate or incidental?** **Deliberate, and correctly so.** The file's own comment
   documents the `md:` (768px) stacking boundary as intentionally matching
   `desktop-only.ts`'s completion-gating width — this is called out in the brief as something
   that must not change, and this survey agrees: stacking below 768px is right, and the 50/50
   split above it is the correct wide layout already.
2. **Natural wide layout:** already achieved — each pane gets a genuine ~50% share of
   whatever `main` provides, so at 2560px each editor gets over 1000px, which is a real
   improvement over a phone's single column. Nothing to add here structurally.
3. Not applicable — this tab does exactly what a wide layout should already.
4. **Wasted space:** none structurally. (Inside `EnvTab`'s table, see below, there is some.)

**Must not change:** the `md:` stacking breakpoint and the 50/50 split are correct as-is.

### `ComposeTab` (`src/web/routes/edit/ComposeTab.tsx`)

No independent width cap; the `YamlEditor` fills its pane. Correct — a code editor should use
all the width it's given, and it already does via `ConfigTab`'s flex layout.

### `EnvTab` (`src/web/routes/edit/EnvTab.tsx`)

Table is `w-full border-collapse` (line 1032) inside its `ConfigTab` pane (~50% of `main`).
Reasonable already given the side-by-side layout is deliberate. One minor note: the "add
variable" mini-form (line 1152) is `flex flex-wrap items-end gap-2` with narrow fixed-content
inputs — fine, it's a two-field form, doesn't need to grow.

---

## `ExposureTab` — `src/web/routes/edit/ExposureTab.tsx`

**Outer constraint:** the expose form is explicitly `max-w-sm` (384px, line 423). The
steady-state view (hostname, Access app, drift banner, buttons) has no cap and fills `main`.

1. **Deliberate or incidental?** The `max-w-sm` on the *form* is deliberate and correct — it's
   a short sequence of labeled fields (hostname, zone, service, port, team domain), a classic
   reading-width form. **This is one of the few things in the survey that should stay
   narrow** — do not widen it.
2. **Natural wide layout:** the steady-state `dl` (hostname, Access app id) could sit next to
   the drift banner or action buttons in a wider layout, but this is a minor, low-value
   change — the content here is inherently short.
3. Nothing hidden on desktop.
4. No notable waste beyond the general absence of a right-rail exposure summary noted above
   under `EditApp`.

---

## Settings — `src/web/routes/Settings.tsx`

**Outer constraint:** `<div className="mx-auto max-w-5xl space-y-8 p-4">` (line 22) — same
1024px cap pattern as launcher/inventory.

**Layout:** three stacked `<section>`s — Host check, Cloudflare, Users — each full width of
the capped container, one after another (`space-y-8`).

1. **Deliberate or incidental?** Incidental for the page shell; the *individual* forms inside
   are correctly narrow (see below). The problem is that three independent, unrelated
   settings blocks are forced into one single vertical column even though a 32" monitor has
   room to show more than one at a time.
2. **Natural wide layout:** Host check and Cloudflare are both compact fact/action panels —
   a `lg:grid-cols-2` layout putting them side by side (Users below, full width, since it's a
   genuine data table) would cut scrolling substantially on desktop without changing either
   panel's own internal width.
3. Nothing is hidden; this is purely serial stacking that doesn't need to be serial.
4. **Wasted vertical space:** yes — the biggest offender on this page. Three sections that
   could partly sit side by side are forced to stack top to bottom, so the page scrolls much
   longer than necessary on a tall monitor with wasted horizontal room the whole time.

### `HostCheckPanel` (`src/web/routes/setup/HostCheckPanel.tsx`)

No width cap; `space-y-4` fact blocks (Compose root, Docker, Mount preflight) each a short
label+value or a small `dl`. **Correctly narrow-ish content** — nothing here benefits from
stretching to full container width; it would just leave more dead space per line. This is a
good candidate to sit in a `lg:grid-cols-2` cell rather than to be widened itself.

### `CloudflarePanel` (`src/web/routes/settings/CloudflarePanel.tsx`)

Credentials form is `max-w-sm` (line 330) — deliberate, correct, a short two-field form.
Tunnel/Monitor/Access sections below are unconstrained `dl`s and short paragraphs — same
"already narrow content" story as `HostCheckPanel`; benefits from being placed in a
multi-column settings grid rather than from being individually widened.

### `UserManager` (`src/web/components/UserManager.tsx`)

Real `<table>` (line 444), always in table form (no mobile collapse, unlike `AdminApps`),
columns Name, Role, Scope, Status, Actions. **This is a genuine data table constrained by the
same outer `max-w-5xl`** as everything else on the Settings page — same fix as `AdminApps`:
let it use real width once there's a reason to (more users, longer scopes, etc.), though with
typical household user counts this is a lower-severity instance of the pattern than
`AdminApps`.

---

## Setup wizard — `src/web/routes/setup/`

**Outer constraint:** `SetupWizard.tsx` line 261: `<div className="mx-auto max-w-lg
space-y-6 p-6">` — 512px, tighter than everything else in the app.

1. **Deliberate or incidental?** **Deliberate, and correct — leave this alone.** This is a
   strictly linear, one-decision-at-a-time onboarding flow (create admin → verify host →
   import → Cloudflare → invite users → finish). A wizard is prose-adjacent: one step, one
   focus, reading-width is exactly right, and widening it would work against the flow's own
   point (guiding attention to one decision) rather than for it. **Flagged explicitly: do
   not widen the setup wizard.**
2. Each step (`StepCreateAdmin`, `StepVerifyHost`, `StepImport`, `StepCloudflare`,
   `StepInviteUsers`) inherits this narrow column and its content (forms, `AdoptPanel`'s
   checkbox list, `UserManager` re-mounted as step 5) is appropriately compact at that width.
3. `AdoptPanel` (`src/web/routes/AdoptPanel.tsx`), reused here and in `AdoptDialog`, renders
   one checkbox row per discovered directory (line 223) inside whatever wrapper it's given —
   inside the wizard that's the 512px column, inside `AdoptDialog` it's `DialogShell`'s
   `sm:max-w-lg` (448px). Both are reasonable for a "check some boxes, click Adopt" flow; not
   worth turning into a grid.
4. No notable vertical waste — steps are short and linear by design.

---

## The shell — `AppLayout.tsx`

**Outer constraint:** none. `<header>` (line 22) is full-bleed with no `max-w`, nav links
right-aligned via `mr-auto` on the brand name. `<main>` (line 41) wraps `<Outlet>` with zero
added constraint — every width decision downstream belongs entirely to the route it renders.

1. **Deliberate or incidental?** Not applicable — this is a thin, unconstrained chrome layer
   and correctly imposes nothing on its children. Not a contributor to the sparse feeling;
   the routes it hosts are.
2. Nothing to add here — this is the right place for *no* opinion on width.

---

## Shared components that set density

### `DialogShell` (`src/web/components/DialogShell.tsx`)

`sm:max-w-lg` (line 121, 512px), bottom sheet on mobile. **Deliberate, correct.** Dialogs
(`AdoptDialog`, `CreateAppDialog`, and anything built on `ConfirmDialog`) are short,
single-purpose interactions — widening a confirmation or a create-app form to fill a 32"
monitor would look absurd and serves no one. **Do not widen.**

### `ConfirmDialog` (`src/web/components/ConfirmDialog.tsx`)

Inherits `DialogShell`'s width. A one-sentence confirmation plus two buttons. Correctly
narrow at any viewport — flagged as a "widening would actively hurt" case.

### `ActionBar` (`src/web/components/ActionBar.tsx`)

No independent width cap; sized by the right rail (`lg:w-72`, 288px). `flex flex-wrap gap-2`
buttons (Deploy/Restart/Pull/Stop) — correct at that width, nothing to change.

### `JobOutput` (`src/web/components/JobOutput.tsx`)

`<pre>` capped at `max-h-64` (line 35, 256px) regardless of viewport. Same shape of issue as
`LogsTab`'s `h-96`: a fixed small height that doesn't take advantage of vertical room on a
tall desktop viewport, most noticeable when a long-running deploy/pull job is streaming a lot
of output into a 256px window on a screen with 1000+px of unused height below it.

### `ImageUpdates` (`src/web/components/ImageUpdates.tsx`)

Card sized by the right rail (288px); `flex flex-col gap-2` list of services/digests.
Correctly narrow — this is a compact status card by design, not a data view, and 288px is
plenty for "service name → digest" lines.

### `IconPicker` (`src/web/components/IconPicker.tsx`)

No width cap; `flex flex-wrap gap-2` result chips. Sized by its parent, which in
`OverviewTab`'s case is the unconstrained (over-wide, per the finding above) form column. Once
`OverviewTab` gets a form-width cap, this inherits a sane width for free; no independent fix
needed here.

---

## §8 gaps — every place the shipped UI is less than the spec describes

Spec: `docs/superpowers/specs/2026-09-09-homestead-design.md`, §8 "Frontend".

1. **Admin inventory columns.** §8: "Dense table on desktop — name, status, **exposure
   hostname**, **image-update count**, last deploy, row actions." Shipped
   (`AdminApps.tsx` lines 157-161): App, Status, Directory, Last deploy, Actions. **Exposure
   hostname and image-update count are simply not columns anywhere in this table** — an
   admin has to open each app's Exposure/Images to learn either. This is a content gap, not
   only a width one.

2. **Right rail is missing "exposure."** §8: "persistent right rail on desktop carrying
   **actions, exposure, image updates, and metadata**." Shipped
   (`EditApp.tsx` lines 163-167): `ActionBar` (actions), `ImageUpdates`, `AppMetadata` — three
   of the four. There is no exposure summary card in the rail; exposure status only exists
   inside the `Exposure` tab itself.

3. **The right rail itself does exist and is correctly built otherwise** — worth stating as a
   non-gap since it would be easy to assume from the brief that it was never built. It uses
   the exact `lg:` static/fixed-bottom-bar split the spec implies, and two of the four named
   contents are present and correct.

4. **Launcher grid count technically meets the letter of §8** ("2-up on phone, 3–5 across on
   desktop") via `xl:grid-cols-5`, but the outer `max-w-5xl` cap means those "5 across" tiles
   never occupy more than 1024px of screen — so the *spirit* of "more tiles visible on
   desktop" is not met on anything wider than a 1024px window, which every screen wider than
   a small laptop now is. Not a literal contradiction of the column-count spec, but a gap in
   what that count was presumably meant to achieve.

5. Everything else checked against §8 (compose editor behavior, icon sourcing/caching,
   live-update SSE model, autocomplete gating, cross-cutting rules like "status is never
   colour alone") is implemented as specified and is not a density concern — not re-listed
   here as a gap.
