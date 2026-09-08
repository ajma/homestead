# Project Identity — Design

**Status:** approved for implementation
**Amends:** §4 of `2026-09-05-homestead-design.md`, on where project metadata lives

---

## 1. Purpose

A project is presented by its directory name and nothing else. There is no way
to give it a readable name, say what it is for, or show an icon — and the
fields to do so (`x-homestead.displayName`, `.description`, `.icon`) are parsed
and typed but read by nothing and written by nothing.

This adds project **identity**: a display name, a description, and an icon, set
from the project and shown wherever the project appears.

### 1.1 Not in scope

- **App tile identity.** The dashboard hardcodes `iconSlug: null` for every
  project-backed tile and uses the bare service name. That is a separate gap
  with a separate source of truth (`homestead.app.*` service labels), and it is
  the more visible of the two. Deliberately left for its own change.
- **Icon upload.** Slug and URL cover the cases; uploads bring size and type
  limits and storage, and SVGs must be refused outright since they execute
  script same-origin.
- Project rename, which does not exist yet and which identity would need to
  follow.

---

## 2. Where identity lives, and why not the compose file

**Identity is stored in SQLite, keyed by project slug.** This amends §4, which
places project metadata in the compose file's `x-homestead` block so that it
travels with the directory.

The reason for the change is a collision that only appears when you try to
write that block. `hasHomestead` — literally "does this file contain an
`x-homestead` key" — is also the **provenance marker** the delete dialog reads:
a project without the block was adopted rather than created by Homestead, which
makes it the case likeliest to hold something the operator cares about, so it
asks for confirmation twice (§3.7).

Setting an icon on an adopted project would create that block as a side effect,
flip `hasHomestead` to true, and silently downgrade a safety confirmation.
Naming a project must not make it easier to delete.

**The cost is accepted and stated:** identity no longer travels with the
directory. Copy a stack to another machine, or restore it from a backup that
does not include `homestead.db`, and the name, description and icon are gone.
The compose file remains the source of truth for everything that describes the
*stack*; identity describes the *presentation*, which is instance-level.

An alternative — recording `source: { kind: "adopted" }` and having the delete
dialog read `source.kind` instead of the block's existence — would have kept
metadata in the file. It was considered and not chosen: it rewrites a user's
compose file for something cosmetic.

### 2.1 Schema

```
project_identity(
  slug          text primary key,
  display_name  text,
  description   text,
  icon_slug     text,
  icon_url      text,
  updated_at    integer not null
)
```

Every field but the key is nullable: identity is partial by nature, and an
absent row is the same as an empty one. Deleting a project deletes its row —
otherwise a directory recreated under the same slug would silently inherit a
stranger's description.

---

## 3. Icons

Resolved against **dashboard-icons**, the set the existing app-icon resolver
already uses, cached to `$HOMESTEAD_DATA/icons/`.

The set is searchable via a manifest, verified live:

```
https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/tree.json
200 · 204 KB · { png: [...], svg: [...], webp: [...] } · 2798 png entries
```

Cached to `$HOMESTEAD_DATA/icons/tree.json` and refreshed when older than seven
days. A box with no outbound internet keeps the picker it last had; a box that
has never fetched it gets an empty picker and the URL field, which still works.

**The slug usually is the project name** — `metube` → `metube.png` — so the
form suggests a match on the project's slug before the operator types anything.

The existing resolver points at `walkxcode/dashboard-icons`. The repository
moved to `homarr-labs/dashboard-icons`; both resolve today only because jsDelivr
follows the rename. Pinned to the current owner as part of this work rather
than left depending on a redirect.

---

## 4. Surfaces

| Where | Shows |
|---|---|
| Project list | icon, display name falling back to the slug, description |
| Project detail header | display name as the heading, slug beneath it |
| Overview | a **Project** section with the three fields and an Edit action |

The slug never disappears. It is what `docker compose` uses, what the
directory is called, and what an operator types to delete a project — a display
name that replaced it everywhere would make those unmatchable.

---

## 5. API

| Endpoint | Notes |
|---|---|
| `GET /api/projects` | each entry gains `identity` |
| `GET /api/projects/:slug` | gains `identity` |
| `PUT /api/projects/:slug/identity` | `project: ["update"]`, admin-only |
| `GET /api/icons?q=` | searches the cached manifest |
| `GET /api/icons/:slug` | serves the cached image |

The icon endpoints are generic rather than project-scoped, so the deferred
app-tile work uses the same two rather than growing a parallel pair.

`identity` is a distinct field from `model.meta`, which remains the compose
file's `x-homestead` block. Two things named `meta` on one response would be
read wrong exactly once and then be wrong forever.

---

## 6. Testing

- Setting identity on an adopted project leaves the compose file byte-identical
  and `hasHomestead` false. This is the whole reason for §2 and is the easiest
  thing to regress.
- Deleting a project deletes its identity row; a project recreated under the
  same slug starts empty.
- The icon manifest is never fetched in a test. Search is a pure function over
  a supplied list.
- A missing manifest yields an empty picker rather than an error: the URL field
  must keep working on a box that has never reached the internet.
- The project list renders the slug when no display name is set.

---

## 7. Handoff

- App tile identity remains unbuilt; the dashboard still shows bare service
  names with no icons. Recorded in `docs/backlog.md`.
- Identity does not survive moving a project directory between machines. If
  that becomes a problem, the answer is an export/import of the identity table
  rather than moving the data back into the compose file, which §2 rules out.
