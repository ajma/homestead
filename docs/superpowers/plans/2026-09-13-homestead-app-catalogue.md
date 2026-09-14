# Homestead — App Catalogue

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creating an app can start from a catalogue of 50 popular self-hosted applications — browse or keyword-search, pick one, and get its display name, description, icon and a working compose file already filled in.

**Architecture:** A vendored JSON catalogue validated by a zod schema, served by one admin-only endpoint, consumed by a browse mode in the existing create dialog. The interesting part is not the feature — it is that **50 hand-written compose files are 50 chances to be silently wrong**, so the plan is built around mechanically verifying every claim that can be verified.

**Tech Stack:** Fastify, zod 4, React, TanStack Query, Vitest, Docker Compose 5.5.1.

## Two decisions already made by the user

**1. Minimal and correct compose files.** Image, published port, named volumes for persistent data, restart policy. Not opinionated defaults — no `PUID`/`PGID`/`TZ`, no healthchecks, no bind mounts laid out under the app directory. Fewer moving parts means fewer ways to be subtly wrong, and the compose editor is right there afterwards.

**2. `latest` tags.** Matches Homestead's own `cloudflared` scaffold. A vendored file of 50 pinned versions rots the moment it ships, and the image-update checker already exists to report drift.

**And one constraint from the user: no apps from the \*arr group.** Sonarr, Radarr, Lidarr, Readarr, Prowlarr, Bazarr, Whisparr and the rest are excluded.

## What can be verified mechanically, and what cannot

This distinction is the spine of the plan. **Everything in the first list must be checked by a script, not by reading.**

**Verifiable:**
- The compose file parses and resolves — `docker compose config`, which is available here.
- The image reference exists in its registry. A typo'd image is the most likely error and the most annoying to hit.
- The icon slug exists in `homarr-labs/dashboard-icons`, which the app already consumes at `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/metadata.json`.
- No two entries share a slug, a name, or a published port default.

**Not verifiable, and therefore where care is owed:** whether the ports, volumes and configuration are the *right* ones for that application. A compose file can be perfectly valid and still point a volume at the wrong path. **Prefer the project's own documented compose example over invention**, and where an app genuinely needs configuration to start at all, say so in the description rather than guessing at values.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`.
- Baseline **1905 tests**.
- **The catalogue must not enter the initial chunk.** It is admin-only and rarely opened; ~50 compose files is real weight. Initial chunk is 444.95 kB and `ConfigTab` is a separate ~606 kB lazy chunk — keep it that way and report after each task.
- **No test may make a network call.** The verification script does, but it is a script run by hand, not a test — the same shape as `scripts/verify-mount-preflight.sh` and `scripts/check-schema-drift.ts`, both of which this project already accepts.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, Biome clean **by exit code**:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain --untracked-files=all` empty at the end of each task; no scratch files.

---

### Task 1: The shape, and the verifier

Build the schema and the verification script **before** writing fifty entries, so every entry is checked from the moment it exists rather than audited at the end.

**Files:** create `src/shared/catalogue/schema.ts`, `src/shared/catalogue/catalogue.json`, `src/shared/catalogue/index.ts` + test, `scripts/verify-catalogue.ts`.

**Interfaces:**
```ts
export type CatalogueEntry = {
  slug: string;           // stable id, kebab-case, also the default app directory
  name: string;           // display name
  description: string;    // one sentence, what it is — not marketing
  iconRef: string;        // a homarr-labs/dashboard-icons slug
  homepage: string;       // the project's own site or repo
  categories: string[];   // for browsing; a small controlled vocabulary
  compose: string;        // the compose file, as YAML
};
```

- [ ] **Step 1: Write the failing tests**

A test over the catalogue file itself, which runs in CI-less normality and needs no network:
- Every entry parses against the zod schema.
- Slugs are unique, kebab-case, and usable as a directory name — `PathGuard` rejects path separators, and a slug with a `/` in it would fail at create time rather than here.
- Every `compose` value parses as YAML (the `yaml` package is already a dependency) and has a `services` key with at least one service.
- **No entry is from the \*arr group.** Assert it by name against an explicit exclusion list, so a later addition cannot quietly reintroduce one.
- Descriptions are one sentence and under a sensible length — this is rendered in a list.

- [ ] **Step 2: Write the verification script**

`scripts/verify-catalogue.ts`, run by hand, exits non-zero on any failure, and reports **per entry** so a failure names the app. It checks the three things a test cannot:
- `docker compose config` resolves the file. Write it to a temp directory and run the real command; do not reimplement compose's validation.
- The image exists. `src/server/apps/registry.ts` already talks to registries for the image-update checker — **read it and reuse it** rather than writing a second client.
- The icon slug exists in the dashboard-icons metadata.

Add it to `package.json` beside `check:schema-drift`, whose shape it should follow.

- [ ] **Step 3: Seed with three entries and prove the verifier bites**

Three real entries, chosen to be structurally different from each other. Then prove each check works by breaking it: a bad image name, a bad icon slug, and an invalid compose file must each fail the script with a message naming the entry. Restore.

**A verifier nobody has seen fail is not a verifier.** Report all three.

- [ ] **Step 4: Gates and commit**

---

### Task 2: Twenty-five entries

**Files:** `src/shared/catalogue/catalogue.json`.

- [ ] **Step 1: Choose and write them**

Twenty-five popular self-hosted applications, no \*arr. Spread across categories rather than clustering — media, downloads, home automation, documents and notes, development, networking, monitoring, dashboards, files and backup, passwords and identity, finance, feeds and bookmarks, communication.

For each: **find the project's own documented compose example and reduce it to the minimal correct form.** Image, published port, named volumes for anything that must persist, `restart: unless-stopped`. Nothing invented.

Where an application cannot start without configuration — a database, a secret, a required environment variable — **include what it genuinely requires** and say so plainly in the description. A catalogue entry that cannot start is worse than one that is absent.

- [ ] **Step 2: Run the verifier on every entry and report the output**

Not a sample. All of them.

- [ ] **Step 3: Gates and commit**

---

### Task 3: Twenty-five more

Same again, to fifty total. Same rules, same verification, same reporting.

**Check for overlap with Task 2's set before writing** — two entries for the same application, or two that differ only in name, is the failure mode here.

---

### Task 4: Browse, search, and create

**Files:** create `src/server/routes/catalogue.ts` + test; modify `src/web/routes/CreateAppDialog.tsx` + test, `src/web/api/` as needed.

- [ ] **Step 1: The endpoint**

One admin-only route serving the catalogue. **A viewer gets 403** — this project proves that boundary by navigation and by route, not by hiding a button.

Serve it from the server rather than importing the JSON into the client bundle, so it stays out of the initial chunk. Fifty entries with compose bodies is not enormous, but it is admin-only and opened rarely; fetch it when the browse UI opens.

- [ ] **Step 2: Browse and search in the create dialog**

`CreateAppDialog` already exists (Phase 1E) — **read it and extend it rather than building a parallel dialog.** It should offer both paths: start blank, as today, or browse the catalogue.

Keyword search over name, description and categories. Fifty entries is small enough that filtering client-side once loaded is right; do not build a server-side search for it.

Choosing an entry fills display name, description, icon and compose. **Everything stays editable before create** — the catalogue is a starting point, not a template the user is stuck with. The existing create flow already validates the directory and scaffolds the file; route the chosen compose through the same path rather than a second one.

- [ ] **Step 3: Write the failing tests**

- Browsing lists entries; searching narrows them; a search matching nothing says so rather than showing an empty box.
- Choosing an entry fills all four fields, and each remains editable.
- Creating from a catalogue entry produces an app whose compose file is the entry's — assert the file that lands on disk, not the form state.
- Starting blank still works exactly as before.
- **A viewer gets 403 from the endpoint.**

- [ ] **Step 4-6: Red, implement, green, prove a binding, gates and commit**

Report the initial chunk size.

---

## Self-Review

**1. Scope.** Four tasks: the shape and its verifier, two batches of entries, then the surface. The verifier comes first deliberately — writing fifty entries and then checking them invites a long tail of small corrections, where checking each as it is written keeps the cost per entry flat.

**2. What this does not do.** No catalogue refresh mechanism, no upstream sync, no user-contributed entries. The compose schema in this project is vendored and refreshed by hand with a drift check, and a catalogue is a weaker case for automation than a schema is — but **it will go stale**, and that belongs in the carry-forward rather than being pretended away.

**3. Type consistency.** `CatalogueEntry.slug` doubles as the default directory name, so it inherits `PathGuard`'s constraints — Task 1's test pins that. `iconRef` is the same string the existing icon system already resolves, so the catalogue adds no new icon plumbing. `compose` is a string routed through the existing create path, not a new one.

**4. The risk a reviewer should attack.** Not the code — the content. Fifty compose files will pass `docker compose config` while still being wrong in ways only someone who runs that application would notice: a volume that should be a bind mount, a port that collides with something common, a required environment variable omitted. **The verifier deliberately cannot catch these**, and the plan says so rather than implying the green check means the catalogue is good. A reviewer's best use of time is spot-checking entries against their upstream documentation, not re-reading the schema.
