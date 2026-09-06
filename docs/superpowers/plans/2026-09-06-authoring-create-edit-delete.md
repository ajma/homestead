# Homestead Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator create, edit and delete Compose projects from the browser — a CodeMirror compose editor, a structured `.env` form that preserves comments, and two new server routes.

**Architecture:** Two new server routes (`POST /api/projects`, `DELETE /api/projects/:slug`) sit beside Plan 2's existing file read/write and validate endpoints. A comment-preserving `yaml` Document wrapper (`doc.ts`) injects provenance without reserialising the user's file. A pure, browser-safe `.env` line model lives in `src/shared` so the form can parse, edit and re-emit a file byte-identically apart from the entry the user touched. The UI fills the `edit` placeholder route Plan 3 left, and adds a `Dialog` primitive that also replaces Plan 3's one bespoke `alertdialog`.

**Tech Stack:** CodeMirror 6 (`codemirror` 6.0.2, `@codemirror/lang-yaml` 6.1.3, `@codemirror/commands`, `@codemirror/lint`, `@codemirror/view`, `@codemirror/state`), `yaml` ^2.9.0 (already installed), React 19.2, react-router-dom 7.18.3 (`useBlocker`), TanStack Query 5.102, Vitest, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-09-06-project-ui-design.md` — §3.6 Create, §3.7 Delete, §4 The editors, §5.5 Errors, §5.6 Unsaved changes, §6 New server routes, §9.2 `.env` semantics, §9.3 Compose scaffold validity.

**Predecessors:** Plan 1 (`aee26d3`), Plan 2 (`0b7deff`), rename (`2a8a6c5`), Plan 3 (`fd4aa03`, merged to `main` at `1eb3fe3`).

## Global Constraints

- **`src/server/auth/permissions.ts` is not modified by this plan.** Spec §6 says so explicitly. It must stay byte-identical to commit `2a8a6c5`. Viewers hold ONLY `app:read`; `project:create` and `project:delete` already exist and are admin-only. Homestead holds the Docker socket, so an admin is root-equivalent on the host — a permission widening here exposes the machine.
- `src/web/**` and `e2e/**` must never import from `src/server/**`. `src/shared/**` is the browser-safe boundary; it already carries runtime code (`src/shared/permissions.ts`), so a pure runtime module there is fine, but it must import nothing from `src/server`.
- Tokens only: no Tailwind palette utilities (`bg-slate-800`, `text-red-500`) and no raw hex in shipped components. `src/web/design-system.test.ts` bans them AND compiles the stylesheet to verify every colour utility emits a real rule. Do not weaken, skip or narrow it.
- A colour utility that resolves can still be inert: `border-border` sets `border-color` only, and Tailwind 4 preflight zeroes `border-width`. Any bordered element needs a width utility too. `expectDrawnBorder` in `e2e/support/tap-targets.ts` is the check that catches this; the conformance test structurally cannot.
- Touch targets at least **44px in both dimensions**; interactive controls need accessible names. Full desktop/mobile parity — the e2e suite runs every spec at 1440×900 and 390×844.
- `docker` is only ever spawned via `execFile` with an argument array, never a shell. `down` must never receive a volume-removal flag; the wrapper's allow-list enforces this and must not be relaxed.
- **`pnpm test` and `pnpm e2e` must start no real containers and leave no host side effects.** Import `test` from `e2e/support/fixtures.js`, never `@playwright/test` — a Biome `noRestrictedImports` rule makes that an error, and the fixture carries the context-level guard that answers every lifecycle POST in the browser.
- No `Co-Authored-By` trailers and no AI-attribution lines in commit messages.
- Four gates, all green before any task is reported done: `pnpm typecheck`, `pnpm test`, `pnpm lint` (5 pre-existing warnings are the accepted baseline), `pnpm e2e`.

## What Plan 3 hands you

Read these before Task 1; they are the surface you build on.

- `src/web/lib/api.ts` — `apiFetch<T>(path, init?): Promise<T | null>` (the `null` is deliberate; a 204 has no body), `class ApiError extends Error { status: number; code?: string; detail?: string }`. On 401 it does `window.location.assign("/login")` and throws.
- `src/web/lib/queries.ts` — `queryKeys`, `useProject(slug)`, `useProjects()`, `useProjectOperations(slug)`, `isRefusal(error)`, and `createQueryDefaults()` applied to the client in `main.tsx`. **Refusal-aware retry and window-focus behaviour are client defaults; individual hooks set neither.** Do not re-add per-hook `retry`/`refetchOnWindowFocus`.
- `src/web/components/ui/` barrel — `Badge`, `Button`, `EmptyState`, `IconButton`, `Input`, `Panel`, `SegmentedControl`, `Spinner`, `StaleNotice`, `StatusDot`, `Tabs`, and the `State` type. `Button` md is 44px; `Input` already carries `border border-border`, `min-h-11` and a focus ring.
- `src/web/lib/useEventStream.ts` — `useEventStream<T>(url, { onReopen: "replace" | "append", onEnd? })`. **`onReopen` is required on purpose**; a consumer must state the policy rather than inherit one it does not own.
- `e2e/support/fixtures.ts` — the guarded `test`. `e2e/support/auth.ts` — `signInAsAdmin`. `e2e/support/tap-targets.ts` — `PHONE`, `TOUCH_MIN`, `sweepTapTargets`, `expectTappable`, `expectDrawnBorder`, `expectNoHorizontalScroll`.
- Server: `GET/PUT /api/projects/:slug/file/:name` where `name` is `z.enum(["compose","env"])` and the PUT body is `{ content: z.string().max(1024*1024) }`; a missing file reads as 404 `{ error: "not_found" }`. `POST /api/projects/:slug/validate` returns `{ valid: true, model }` or `{ valid: false, error }`. `writeProjectFile` snapshots the previous content only when the target already existed, so a first `.env` save correctly takes no snapshot.
- `ProjectDetail.tsx:99-102` holds the `Compose editor` placeholder and `:280` a bespoke `role="alertdialog"` confirmation. Both are yours to replace.

## Verified facts you may rely on

These were probed against the real toolchain while writing this plan. Do not re-litigate them; do report if any turns out false.

- `yaml`'s Document API preserves comments through an injection. `parseDocument(src)` then `doc.setIn(["x-homestead"], doc.createNode({...}))` then `doc.toString()` kept a leading comment block, a mid-file comment and a trailing inline comment (`image: nginx # pinned deliberately`) byte-for-byte, and appended the new key at the end of the document.
- `@codemirror/commands` exports `indentMore`, `indentLess`, `defaultKeymap`, `history`, `historyKeymap`, `indentWithTab`. `@codemirror/lang-yaml` exports `yaml`, `yamlFrontmatter`, `yamlLanguage`. `@codemirror/lint` exports `linter`, `lintGutter`, `forceLinting`.
- `react-router-dom@7.18.3` exports `useBlocker`.
- Spec §9.3: `services: {}` is a valid config and `services:` followed only by comments is **invalid** (`services must be a mapping`). The scaffold's comment must sit above an explicit empty map.
- **Spec §3.7's server change is already done.** It asks for `parseCanonical` to gain `volumes: string[]` so the delete dialog has something to list. Plan 3 Task 1 shipped it as the richer `volumes: VolumeRef[]` — `{ key, name, external }` — because a bare key is not enough: `name` is what `docker volume ls` shows and cannot be reconstructed for a volume declaring an explicit `name:`, and `external: true` volumes are owned elsewhere and must never be offered for deletion. Use `VolumeRef`; do not re-add a `string[]`.
- `composeExec(ctx, verb, onOutput, docker)` returns `Promise<number>` (the exit code) and lives in `src/server/docker/compose.ts`. `src/server/routes/projects.ts` does **not** import it yet — Task 5 adds that import.

## File Structure

**Server**

| File | Responsibility |
|---|---|
| `src/shared/projects.ts` (modify) | Gains `isValidSlug` — one implementation for both sides, per Plan 3's handoff note. |
| `src/server/projects/store.ts` (modify) | Imports `isValidSlug` from shared and re-exports it, so existing server call sites are untouched. Gains `createProject` and `deleteProject`. |
| `src/server/projects/doc.ts` (create) | Comment-preserving compose Document wrapper: `injectHomesteadBlock`, `hasHomesteadBlock`, `blankScaffold`. |
| `src/server/routes/projects.ts` (modify) | Adds `POST /api/projects` and `DELETE /api/projects/:slug`. |

**Shared**

| File | Responsibility |
|---|---|
| `src/shared/env.ts` (create) | Pure ordered-line `.env` model: `parseEnv`, `serializeEnv`, `setEntryValue`, `addEntry`, `removeEntry`. Browser-safe, imports nothing. |

**Web**

| File | Responsibility |
|---|---|
| `src/web/components/ui/Dialog.tsx` (create) | Modal primitive: focus trap, Escape, restore focus, `aria-modal`. Replaces Plan 3's bespoke `alertdialog`. |
| `src/web/components/ComposeEditor.tsx` (create) | CodeMirror 6 host + mobile touch toolbar (indent / outdent / save). |
| `src/web/components/EnvEditor.tsx` (create) | Structured key/value form over `src/shared/env.ts`, with a raw CodeMirror toggle. |
| `src/web/routes/project/Edit.tsx` (create) | The `edit` tab: a `SegmentedControl` between Compose and `.env`, owning save state. |
| `src/web/routes/CreateProject.tsx` (create) | `/projects/new` — slug + blank-or-paste. |
| `src/web/components/DeleteProjectDialog.tsx` (create) | Typed-slug confirmation, second confirmation for adopted projects, orphan-volume list. |
| `src/web/lib/useUnsavedChanges.ts` (create) | `useBlocker` wrapper plus an in-page guard for the Compose/`.env` switch. |
| `src/web/lib/queries.ts` (modify) | Adds `useProjectFile`, `useSaveProjectFile`, `useCreateProject`, `useDeleteProject`, `useValidateCompose`. |
| `src/web/routes/ProjectDetail.tsx` (modify) | Renders `<Edit />` in place of the placeholder; migrates its bespoke dialog to `Dialog`; mounts the delete dialog. |
| `src/web/App.tsx` (modify) | Registers `/projects/new`. |

**Tests**

`src/shared/env.test.ts`, `src/server/projects/doc.test.ts`, `src/server/projects/store.test.ts` (extend), `src/server/routes/projects.test.ts` (extend), `src/web/components/ui/dialog.test.tsx`, `src/web/components/compose-editor.test.tsx`, `src/web/components/env-editor.test.tsx`, `src/web/routes/create-project.test.tsx`, `src/web/lib/unsaved.test.tsx`, `e2e/authoring.spec.ts`.

---

### Task 1: Move `isValidSlug` to the shared boundary

**Files:**
- Modify: `src/shared/projects.ts`
- Modify: `src/server/projects/store.ts:27-33`
- Test: `src/shared/projects.test.ts` (create)

**Interfaces:**
- Produces: `isValidSlug(slug: string): boolean` exported from `@shared/projects.js`, re-exported unchanged from `src/server/projects/store.ts`.

Plan 3's handoff records this move as the precondition for client-side slug validation. One implementation must serve both sides — a second copy in the browser would drift from the boundary the server actually enforces.

- [ ] **Step 1: Write the failing test**

`src/shared/projects.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isValidSlug } from "./projects.js";

describe("isValidSlug", () => {
  it("accepts ordinary project directory names", () => {
    for (const s of ["media", "immich", "home-assistant", "a1", "my.stack", "A_B"])
      expect(isValidSlug(s), s).toBe(true);
  });

  it("rejects anything that could escape the projects root", () => {
    for (const s of ["..", "../etc", "a/b", ".hidden", "", "-leading"])
      expect(isValidSlug(s), s).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/shared/projects.test.ts`
Expected: FAIL — `isValidSlug` is not exported from `src/shared/projects.ts`.

- [ ] **Step 3: Move the function**

Cut this from `src/server/projects/store.ts` and paste it into `src/shared/projects.ts`, unchanged:

```typescript
export function isValidSlug(slug: string): boolean {
  return (
    /^[a-z0-9][a-z0-9._-]*$/i.test(slug) &&
    !slug.startsWith(".") &&
    !slug.includes("..")
  );
}
```

In `src/server/projects/store.ts`, replace the definition with a re-export so every existing server import keeps working:

```typescript
export { isValidSlug } from "@shared/projects.js";
```

- [ ] **Step 4: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, including every existing caller of `isValidSlug` in `src/server/routes/`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/projects.ts src/shared/projects.test.ts src/server/projects/store.ts
git commit -m "refactor: move slug validation to the shared boundary"
```

---

### Task 2: The `.env` ordered-line model

**Files:**
- Create: `src/shared/env.ts`
- Test: `src/shared/env.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type EnvLine =
    | { kind: "comment"; raw: string }
    | { kind: "blank"; raw: string }
    | { kind: "entry"; raw: string; key: string; value: string;
        exported: boolean; quote: "none" | "single" | "double";
        inlineComment: string | null }
    | { kind: "other"; raw: string };

  export function parseEnv(text: string): EnvLine[];
  export function serializeEnv(lines: EnvLine[]): string;
  export function setEntryValue(lines: EnvLine[], key: string, value: string): EnvLine[];
  export function addEntry(lines: EnvLine[], key: string, value: string): EnvLine[];
  export function removeEntry(lines: EnvLine[], key: string): EnvLine[];
  export function isSecretKey(key: string): boolean;
  ```

**Why an ordered line list and not a `Record<string,string>`:** spec §4.2 makes round-trip preservation a hard requirement. People annotate `.env` files heavily — "# get this from the Immich admin panel" — and rebuilding the file from key/value pairs deletes all of it on first save. Every line the user did not touch must come back byte-identical, including ones the parser does not model, which is what `kind: "other"` is for.

- [ ] **Step 1: Write the failing tests**

`src/shared/env.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { addEntry, isSecretKey, parseEnv, removeEntry, serializeEnv, setEntryValue } from "./env.js";

const SAMPLE = `# Immich
# get this from the admin panel
API_KEY="s3cr3t value"
export EXPORTED=yes
INLINE=value # trailing
SINGLE='$NOTEXPANDED'
EMPTY=

PLAIN=hello
`;

describe("parseEnv / serializeEnv", () => {
  it("round-trips a file byte-identically when nothing is edited", () => {
    expect(serializeEnv(parseEnv(SAMPLE))).toBe(SAMPLE);
  });

  it("round-trips content the parser does not model", () => {
    const weird = 'MULTI="line one\nline two"\n}}garbage{{\n';
    expect(serializeEnv(parseEnv(weird))).toBe(weird);
  });

  it("reads the value each compose quoting form actually yields", () => {
    const byKey = Object.fromEntries(
      parseEnv(SAMPLE).flatMap((l) => (l.kind === "entry" ? [[l.key, l]] : [])),
    );
    expect(byKey.API_KEY.value).toBe("s3cr3t value");
    expect(byKey.EXPORTED.value).toBe("yes");
    expect(byKey.EXPORTED.exported).toBe(true);
    expect(byKey.INLINE.value).toBe("value");
    expect(byKey.INLINE.inlineComment).toBe(" # trailing");
    expect(byKey.SINGLE.value).toBe("$NOTEXPANDED");
    expect(byKey.EMPTY.value).toBe("");
  });

  it("preserves an inline comment when only the value changes", () => {
    const out = serializeEnv(setEntryValue(parseEnv(SAMPLE), "INLINE", "changed"));
    expect(out).toContain("INLINE=changed # trailing");
  });

  it("keeps every untouched line when one value is edited", () => {
    const out = serializeEnv(setEntryValue(parseEnv(SAMPLE), "PLAIN", "goodbye"));
    expect(out).toContain("# get this from the admin panel");
    expect(out).toContain(`SINGLE='$NOTEXPANDED'`);
    expect(out).toContain("PLAIN=goodbye");
    expect(out.split("\n").length).toBe(SAMPLE.split("\n").length);
  });

  it("quotes a value that would otherwise change meaning", () => {
    const out = serializeEnv(setEntryValue(parseEnv("A=x\n"), "A", "has spaces # and hash"));
    expect(out).toBe('A="has spaces # and hash"\n');
    expect(parseEnv(out)[0]).toMatchObject({ value: "has spaces # and hash" });
  });

  it("keeps the export prefix when the value changes", () => {
    expect(serializeEnv(setEntryValue(parseEnv("export A=1\n"), "A", "2"))).toBe("export A=2\n");
  });

  it("adds and removes entries", () => {
    expect(serializeEnv(addEntry(parseEnv("A=1\n"), "B", "2"))).toBe("A=1\nB=2\n");
    expect(serializeEnv(removeEntry(parseEnv("A=1\nB=2\n"), "A"))).toBe("B=2\n");
  });
});

describe("isSecretKey", () => {
  it("flags names that usually hold credentials", () => {
    for (const k of ["DB_PASSWORD", "API_KEY", "JWT_SECRET", "ADMIN_TOKEN"])
      expect(isSecretKey(k), k).toBe(true);
  });
  it("does not flag ordinary settings", () => {
    for (const k of ["TZ", "PUID", "UPLOAD_LOCATION"]) expect(isSecretKey(k), k).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/shared/env.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the model**

`src/shared/env.ts`. Keep `raw` on every line: it is what makes the round-trip exact, and it is the only thing returned for lines the parser does not model.

```typescript
/**
 * An ordered model of a `.env` file, per spec §4.2.
 *
 * Every line keeps its `raw` text. Editing one entry rewrites only that
 * entry's line; everything else — comments, blanks, and anything this parser
 * does not understand — is emitted byte-for-byte. Rebuilding the file from
 * key/value pairs would delete the annotations people rely on.
 */
export type EnvLine =
  | { kind: "comment"; raw: string }
  | { kind: "blank"; raw: string }
  | {
      kind: "entry";
      raw: string;
      key: string;
      value: string;
      exported: boolean;
      quote: "none" | "single" | "double";
      /** Including its leading whitespace, e.g. `" # trailing"`. Unquoted values only. */
      inlineComment: string | null;
    }
  | { kind: "other"; raw: string };

const ENTRY = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function parseValue(rest: string): Pick<
  Extract<EnvLine, { kind: "entry" }>,
  "value" | "quote" | "inlineComment"
> | null {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end === -1) return null; // unterminated — leave the line to `other`
    if (rest.slice(end + 1).trim() !== "") return null;
    return { value: rest.slice(1, end), quote: "double", inlineComment: null };
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end === -1) return null;
    if (rest.slice(end + 1).trim() !== "") return null;
    return { value: rest.slice(1, end), quote: "single", inlineComment: null };
  }
  // Unquoted: an inline comment needs whitespace before the `#`, matching
  // compose. `A=a#b` is the literal value `a#b`.
  const hash = rest.search(/\s#/);
  if (hash === -1) return { value: rest.trim(), quote: "none", inlineComment: null };
  return {
    value: rest.slice(0, hash).trim(),
    quote: "none",
    inlineComment: rest.slice(hash),
  };
}

export function parseEnv(text: string): EnvLine[] {
  return text.split("\n").map((raw): EnvLine => {
    if (raw.trim() === "") return { kind: "blank", raw };
    if (raw.trimStart().startsWith("#")) return { kind: "comment", raw };
    const m = ENTRY.exec(raw);
    if (!m) return { kind: "other", raw };
    const parsed = parseValue(m[3] as string);
    if (!parsed) return { kind: "other", raw };
    return {
      kind: "entry",
      raw,
      key: m[2] as string,
      exported: Boolean(m[1]),
      ...parsed,
    };
  });
}

export function serializeEnv(lines: EnvLine[]): string {
  return lines.map((l) => l.raw).join("\n");
}

/** Chooses the least surprising quoting that still round-trips to `value`. */
function renderEntry(line: Extract<EnvLine, { kind: "entry" }>, value: string): string {
  const prefix = `${line.exported ? "export " : ""}${line.key}=`;
  const needsQuotes = /[\s#'"]/.test(value) || value !== value.trim();
  if (line.quote === "single" && !value.includes("'"))
    return `${prefix}'${value}'`;
  if (needsQuotes || line.quote === "double")
    return `${prefix}"${value.replace(/(["\\])/g, "\\$1")}"`;
  return `${prefix}${value}${line.inlineComment ?? ""}`;
}

export function setEntryValue(lines: EnvLine[], key: string, value: string): EnvLine[] {
  return lines.map((l) =>
    l.kind === "entry" && l.key === key ? { ...l, value, raw: renderEntry(l, value) } : l,
  );
}

export function addEntry(lines: EnvLine[], key: string, value: string): EnvLine[] {
  const line: Extract<EnvLine, { kind: "entry" }> = {
    kind: "entry", raw: "", key, value, exported: false,
    quote: "none", inlineComment: null,
  };
  const withRaw = { ...line, raw: renderEntry(line, value) };
  // A parsed file ends with a trailing blank produced by the final newline;
  // inserting before it keeps the file newline-terminated.
  const last = lines.at(-1);
  if (last?.kind === "blank" && last.raw === "")
    return [...lines.slice(0, -1), withRaw, last];
  return [...lines, withRaw];
}

export function removeEntry(lines: EnvLine[], key: string): EnvLine[] {
  return lines.filter((l) => !(l.kind === "entry" && l.key === key));
}

const SECRET = /(PASSWORD|SECRET|TOKEN|_KEY|APIKEY|CREDENTIAL|PASSWD)/i;

/** Drives masking in the form. Advisory only — never a security boundary. */
export function isSecretKey(key: string): boolean {
  return SECRET.test(key);
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/shared/env.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the round-trip test can fail**

Temporarily change `serializeEnv` to `lines.map((l) => (l.kind === "entry" ? renderEntry(l, l.value) : l.raw)).join("\n")` — a plausible-looking "rebuild from the model" that discards `other` lines' exact text. Run the suite; the two round-trip tests must go red. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/shared/env.ts src/shared/env.test.ts
git commit -m "feat: add a comment-preserving .env line model"
```

---

### Task 3: The comment-preserving compose Document wrapper

**Files:**
- Create: `src/server/projects/doc.ts`
- Test: `src/server/projects/doc.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function hasHomesteadBlock(content: string): boolean;
  export function injectHomesteadBlock(content: string, source: { kind: "blank" | "paste" }): string;
  export function blankScaffold(slug: string): string;
  ```

Spec §6.1 records that this file was written into Plan 2 and dropped before implementation because nothing consumed it, on the condition it return when it had a caller. It has one now: pasted compose files need `x-homestead` injected so their provenance is not mistaken for an adopted project's.

- [ ] **Step 1: Write the failing tests**

`src/server/projects/doc.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { blankScaffold, hasHomesteadBlock, injectHomesteadBlock } from "./doc.js";

const ANNOTATED = `# My homelab media stack
# get the API key from the Immich admin panel
services:
  web:
    image: nginx   # pinned deliberately
    ports:
      - '127.0.0.1:8080:80'
`;

describe("injectHomesteadBlock", () => {
  it("keeps every comment, including inline ones", () => {
    const out = injectHomesteadBlock(ANNOTATED, { kind: "paste" });
    expect(out).toContain("# My homelab media stack");
    expect(out).toContain("# get the API key from the Immich admin panel");
    expect(out).toContain("# pinned deliberately");
  });

  it("adds the provenance block", () => {
    const out = injectHomesteadBlock(ANNOTATED, { kind: "paste" });
    expect(hasHomesteadBlock(out)).toBe(true);
    expect(out).toContain("x-homestead:");
    expect(out).toContain("kind: paste");
  });

  it("leaves an existing x-homestead block alone", () => {
    const already = "x-homestead:\n  schemaVersion: 1\n  source:\n    kind: blank\nservices: {}\n";
    expect(injectHomesteadBlock(already, { kind: "paste" })).toBe(already);
  });

  it("returns unparseable content untouched rather than throwing", () => {
    // Spec §6.1: an invalid paste is stored as given; the detail page surfaces
    // parseError. Discarding it would lose content the user has nowhere else.
    const broken = "services:\n  - this is: [not valid\n";
    expect(injectHomesteadBlock(broken, { kind: "paste" })).toBe(broken);
  });
});

describe("hasHomesteadBlock", () => {
  it("is false for an adopted project, which is the provenance signal", () => {
    expect(hasHomesteadBlock(ANNOTATED)).toBe(false);
  });
  it("is false for content it cannot parse", () => {
    expect(hasHomesteadBlock("services:\n  - [broken\n")).toBe(false);
  });
});

describe("blankScaffold", () => {
  it("puts the example comment above an explicit empty map", () => {
    // Spec §9.3: `services:` followed only by comments parses as null and is
    // an INVALID config. The empty map is what keeps the scaffold valid.
    const out = blankScaffold("media");
    expect(out).toContain("services: {}");
    expect(out.indexOf("# Add services below")).toBeLessThan(out.indexOf("services: {}"));
    expect(out).toContain("name: media");
    expect(hasHomesteadBlock(out)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/projects/doc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/projects/doc.ts`:

```typescript
import { parseDocument } from "yaml";

/**
 * Provenance, per spec §3.7: an adopted project has no `x-homestead` block at
 * all, so the *absence* of this key is what marks a directory Homestead did
 * not create — and that is exactly the case likeliest to hold something the
 * user cares about, which is why deletion asks twice.
 */
export function hasHomesteadBlock(content: string): boolean {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return false;
  return doc.has("x-homestead");
}

/**
 * Adds the provenance block while preserving comments and formatting.
 *
 * Editing the Document rather than reserialising is the whole point: a pasted
 * compose file carries the author's comments, and round-tripping through a
 * plain object would delete them.
 *
 * Unparseable content is returned unchanged. Spec §6.1 stores an invalid paste
 * as given — the detail page already surfaces `parseError`, and refusing it
 * would discard content the user has nowhere else to put.
 */
export function injectHomesteadBlock(
  content: string,
  source: { kind: "blank" | "paste" },
): string {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return content;
  if (doc.has("x-homestead")) return content;
  doc.setIn(["x-homestead"], doc.createNode({ schemaVersion: 1, source }));
  return doc.toString();
}

/**
 * The blank scaffold from spec §6.1.
 *
 * The comment sits *above* an explicit empty map on purpose: per §9.3,
 * `services:` followed only by comments parses as null and `docker compose
 * config` rejects it with "services must be a mapping".
 */
export function blankScaffold(slug: string): string {
  return `name: ${slug}
x-homestead:
  schemaVersion: 1
  source: { kind: blank }

# Add services below, for example:
#   web:
#     image: nginx
#     ports: ["127.0.0.1:8080:80"]
services: {}
`;
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/projects/doc.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/projects/doc.ts src/server/projects/doc.test.ts
git commit -m "feat: add the comment-preserving compose document wrapper"
```

---

### Task 4: `createProject` and `deleteProject` in the store

**Files:**
- Modify: `src/server/projects/store.ts`
- Test: `src/server/projects/store.test.ts`

**Interfaces:**
- Consumes: `blankScaffold`, `injectHomesteadBlock` (Task 3); `isValidSlug`, `projectPath` (existing).
- Produces:
  ```typescript
  export async function createProject(
    projectsDir: string, slug: string,
    source: { kind: "blank" } | { kind: "paste"; content: string },
  ): Promise<void>;               // throws ProjectExistsError if the directory exists
  export class ProjectExistsError extends Error {}
  export async function deleteProjectDir(projectsDir: string, slug: string): Promise<void>;
  ```

Keeping filesystem work in the store rather than the route matches how Plan 2 organised `readProjectFile` / `writeProjectFile`, and keeps the route thin enough to read.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/projects/store.test.ts`:

```typescript
describe("createProject", () => {
  it("writes a valid blank scaffold into a new directory", async () => {
    const root = await tempDir("hs-create-");
    await createProject(root, "media", { kind: "blank" });
    const content = await readProjectFile(root, "media", "compose");
    expect(content).toContain("name: media");
    expect(content).toContain("services: {}");
  });

  it("stores a pasted file with provenance injected and comments intact", async () => {
    const root = await tempDir("hs-create-");
    await createProject(root, "immich", {
      kind: "paste",
      content: "# keep me\nservices:\n  web:\n    image: nginx\n",
    });
    const content = (await readProjectFile(root, "immich", "compose")) ?? "";
    expect(content).toContain("# keep me");
    expect(content).toContain("kind: paste");
  });

  it("refuses to overwrite an existing directory", async () => {
    const root = await tempDir("hs-create-");
    await createProject(root, "media", { kind: "blank" });
    await expect(createProject(root, "media", { kind: "blank" })).rejects.toBeInstanceOf(
      ProjectExistsError,
    );
  });

  it("rejects a slug that would escape the projects root", async () => {
    const root = await tempDir("hs-create-");
    await expect(createProject(root, "../evil", { kind: "blank" })).rejects.toThrow();
  });
});

describe("deleteProjectDir", () => {
  it("removes the directory and everything in it", async () => {
    const root = await tempDir("hs-delete-");
    await createProject(root, "media", { kind: "blank" });
    await writeProjectFile(root, "media", "env", "A=1\n");
    await deleteProjectDir(root, "media");
    expect(await scanProjects(root)).toEqual([]);
  });

  it("rejects a slug that would escape the projects root", async () => {
    const root = await tempDir("hs-delete-");
    await expect(deleteProjectDir(root, "../..")).rejects.toThrow();
  });
});
```

Add `createProject`, `ProjectExistsError` and `deleteProjectDir` to the file's existing import from `./store.js`.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/projects/store.test.ts`
Expected: FAIL — the three names are not exported.

- [ ] **Step 3: Implement**

Add to `src/server/projects/store.ts` (it already imports `mkdir`, `rm`, `writeFile` siblings from `node:fs/promises` — extend that import rather than adding a second one):

```typescript
export class ProjectExistsError extends Error {
  constructor(slug: string) {
    super(`project already exists: ${slug}`);
    this.name = "ProjectExistsError";
  }
}

export async function createProject(
  projectsDir: string,
  slug: string,
  source: { kind: "blank" } | { kind: "paste"; content: string },
): Promise<void> {
  // Throws on a slug that escapes the root — the same boundary every other
  // path-taking function in this file goes through.
  const dir = projectPath(projectsDir, slug);
  try {
    await mkdir(dir, { recursive: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw new ProjectExistsError(slug);
    throw err;
  }
  const content =
    source.kind === "blank"
      ? blankScaffold(slug)
      : injectHomesteadBlock(source.content, { kind: "paste" });
  await writeFile(join(dir, "docker-compose.yml"), content, "utf8");
}

export async function deleteProjectDir(
  projectsDir: string,
  slug: string,
): Promise<void> {
  await rm(projectPath(projectsDir, slug), { recursive: true, force: true });
}
```

`mkdir` with `recursive: false` is deliberate: it is what makes "the directory already exists" an atomic `EEXIST` rather than a check-then-create race between two browser tabs.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server/projects && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/projects/store.ts src/server/projects/store.test.ts
git commit -m "feat: create and delete project directories"
```

---

### Task 5: `POST /api/projects` and `DELETE /api/projects/:slug`

**Files:**
- Modify: `src/server/routes/projects.ts`
- Test: `src/server/routes/projects.test.ts`

**Interfaces:**
- Consumes: `createProject`, `ProjectExistsError`, `deleteProjectDir`, `hasHomesteadBlock`, `readProjectFile` (Tasks 3-4); `composeExec`/`docker` runner and `requirePermission` (existing).
- Produces:
  - `POST /api/projects` `[project:create]` — body `{ slug, source: "blank" | "paste", content? }` → 201 `{ slug, valid, error? }`, 409 `{ error: "project_exists" }`, 400 `{ error: "invalid_slug" }`.
  - `DELETE /api/projects/:slug` `[project:delete]` → 200 `{ ok: true }`, 404 `{ error: "not_found" }`, 400 `{ error: "invalid_slug" }`.
  - `GET /api/projects/:slug` gains `hasHomestead: boolean` — the provenance signal Task 10's delete dialog reads.

**The permissions file is not touched.** `project: [read, create, update, delete, control]` already exists in Plan 1's statement and both verbs are admin-only.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/routes/projects.test.ts`, following the existing harness in that file:

```typescript
describe("POST /api/projects", () => {
  it("creates a blank project and reports it valid", async () => {
    const { app } = await bootAsAdmin();
    const res = await app.inject({
      method: "POST", url: "/api/projects",
      payload: { slug: "media", source: "blank" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "media", valid: true });
  });

  it("stores an invalid paste rather than rejecting it", async () => {
    // Spec §6.1: refusing the paste discards content the user has nowhere
    // else to put; the detail page surfaces parseError instead.
    const { app } = await bootAsAdmin();
    const res = await app.inject({
      method: "POST", url: "/api/projects",
      payload: { slug: "broken", source: "paste", content: "services:\n  - [nope\n" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "broken", valid: false });
    expect(res.json().error).toBeTruthy();
  });

  it("returns 409 when the directory already exists", async () => {
    const { app } = await bootAsAdmin();
    await app.inject({ method: "POST", url: "/api/projects", payload: { slug: "media", source: "blank" } });
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { slug: "media", source: "blank" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "project_exists" });
  });

  it("rejects a slug that escapes the projects root", async () => {
    const { app } = await bootAsAdmin();
    const res = await app.inject({
      method: "POST", url: "/api/projects", payload: { slug: "../evil", source: "blank" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("is refused for a viewer", async () => {
    const { app } = await bootAsViewer();
    const res = await app.inject({
      method: "POST", url: "/api/projects", payload: { slug: "media", source: "blank" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/projects/:slug", () => {
  it("brings the stack down and removes the directory", async () => {
    const { app, calls } = await bootAsAdmin();
    await app.inject({ method: "POST", url: "/api/projects", payload: { slug: "media", source: "blank" } });
    const res = await app.inject({ method: "DELETE", url: "/api/projects/media" });
    expect(res.statusCode).toBe(200);
    const down = calls.find((c) => c.includes("down"));
    expect(down).toBeTruthy();
    // The wrapper's allow-list must make a volume flag impossible.
    expect(down).not.toContain("-v");
    expect(down).not.toContain("--volumes");
    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.json().projects).toEqual([]);
  });

  it("returns 404 for a project that is not there", async () => {
    const { app } = await bootAsAdmin();
    expect((await app.inject({ method: "DELETE", url: "/api/projects/ghost" })).statusCode).toBe(404);
  });

  it("is refused for a viewer", async () => {
    const { app } = await bootAsViewer();
    expect((await app.inject({ method: "DELETE", url: "/api/projects/media" })).statusCode).toBe(403);
  });
});

describe("GET /api/projects/:slug — provenance", () => {
  it("reports hasHomestead true for a project Homestead created", async () => {
    const { app } = await bootAsAdmin();
    await app.inject({ method: "POST", url: "/api/projects", payload: { slug: "made", source: "blank" } });
    const res = await app.inject({ method: "GET", url: "/api/projects/made" });
    expect(res.json()).toMatchObject({ hasHomestead: true });
  });

  it("reports hasHomestead false for an adopted directory", async () => {
    // Absence of the x-homestead block IS the provenance marker (§3.7) — this
    // is what makes deletion ask twice for a directory we did not create.
    const { app, projectsDir } = await bootAsAdmin();
    await mkdir(join(projectsDir, "adopted"), { recursive: true });
    await writeFile(
      join(projectsDir, "adopted", "docker-compose.yml"),
      "services:\n  web:\n    image: nginx\n",
      "utf8",
    );
    const res = await app.inject({ method: "GET", url: "/api/projects/adopted" });
    expect(res.json()).toMatchObject({ hasHomestead: false });
  });
});
```

If `bootAsViewer` does not yet exist in that file, add it alongside `bootAsAdmin` by creating a user with the `viewer` role — do not change `permissions.ts` to make these pass.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/server/routes/projects.test.ts`
Expected: FAIL — 404, both routes are unregistered.

- [ ] **Step 3: Implement the routes**

First extend the file's existing imports — it currently pulls `composeConfig, composePs` from `../docker/compose.js` and `isValidSlug, listSnapshots, readProjectFile, scanProjects, writeProjectFile` from `../projects/store.js`:

```typescript
import { type ContainerState, composeConfig, composeExec, composePs } from "../docker/compose.js";
import {
  ProjectExistsError, createProject, deleteProjectDir, isValidSlug,
  listSnapshots, readProjectFile, scanProjects, writeProjectFile,
} from "../projects/store.js";
```

Then add, beside the existing handlers:

```typescript
const createBody = z.object({
  slug: z.string(),
  source: z.enum(["blank", "paste"]),
  content: z.string().max(1024 * 1024).optional(),
});

app.post(
  "/api/projects",
  { preHandler: requirePermission({ project: ["create"] }) },
  async (request, reply) => {
    const body = createBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_body" });
    const { slug, source, content } = body.data;
    if (!isValidSlug(slug)) return reply.status(400).send({ error: "invalid_slug" });

    try {
      await createProject(
        opts.projectsDir,
        slug,
        source === "blank" ? { kind: "blank" } : { kind: "paste", content: content ?? "" },
      );
    } catch (err) {
      if (err instanceof ProjectExistsError)
        return reply.status(409).send({ error: "project_exists" });
      throw err;
    }

    // Validated *after* writing, per §6.1: the file is kept either way and the
    // caller is told what it got, so an invalid paste lands in the editor
    // rather than being thrown away.
    try {
      parseCanonical(await composeConfig(ctxFor(slug), docker.run));
      return reply.status(201).send({ slug, valid: true });
    } catch (err) {
      return reply.status(201).send({
        slug,
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

app.delete<{ Params: { slug: string } }>(
  "/api/projects/:slug",
  { preHandler: requirePermission({ project: ["delete"] }) },
  async (request, reply) => {
    const { slug } = request.params;
    if (!isValidSlug(slug)) return reply.status(400).send({ error: "invalid_slug" });
    const entries = await scanProjects(opts.projectsDir);
    if (!entries.some((e) => e.slug === slug))
      return reply.status(404).send({ error: "not_found" });

    // `down` only — never a volume flag. The wrapper's allow-list makes that
    // structurally impossible; named volumes are retained and reported to the
    // user by the delete dialog (§3.7, §8).
    if (entries.find((e) => e.slug === slug)?.hasCompose) {
      try {
        await composeExec(ctxFor(slug), ["down"], () => {}, docker);
      } catch (err) {
        request.log.warn({ err, slug }, "compose down failed before delete");
      }
    }
    await deleteProjectDir(opts.projectsDir, slug);
    return { ok: true };
  },
);
```

A failing `down` is logged and the delete proceeds: the user asked for the directory to go, and a stack that will not come down — because the daemon is unreachable, or the compose file no longer parses — must not strand them with a project they cannot remove.

Then add the provenance flag to the existing `GET /api/projects/:slug` handler. It already reads the compose file's content path via `entry.hasCompose`; compute the flag from the file itself and include it in the returned object:

```typescript
const composeText = entry.hasCompose
  ? await readProjectFile(opts.projectsDir, slug, "compose")
  : null;

return {
  ...entry,
  model,
  parseError,
  states,
  statesError,
  hasHomestead: composeText === null ? false : hasHomesteadBlock(composeText),
  snapshots: await listSnapshots(opts.projectsDir, slug),
};
```

Import `hasHomesteadBlock` from `../projects/doc.js`, and add `hasHomestead: boolean` to the detail type in `src/shared/projects.ts` so the client is typed against it.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/server && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Verify the permissions file is untouched**

Run: `git diff --quiet 2a8a6c5 -- src/server/auth/permissions.ts && echo IDENTICAL`
Expected: `IDENTICAL`.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/projects.ts src/server/routes/projects.test.ts
git commit -m "feat: add project create and delete routes"
```

---

### Task 6: The `Dialog` primitive

**Files:**
- Create: `src/web/components/ui/Dialog.tsx`
- Modify: `src/web/components/ui/index.ts`
- Modify: `src/web/routes/ProjectDetail.tsx` (migrate the bespoke `role="alertdialog"` at ~line 280)
- Test: `src/web/components/ui/dialog.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  export function Dialog(props: {
    open: boolean;
    onClose: () => void;
    title: string;
    describedBy?: string;
    role?: "dialog" | "alertdialog";
    children: React.ReactNode;
  }): JSX.Element | null;
  ```

Plan 3 shipped one inline confirmation with focus placed and Escape wired but **no focus trap and no `inert`**, and recorded that a real primitive was owed before a second one appeared. Tasks 8 and 10 add two more, so it is owed now.

- [ ] **Step 1: Write the failing tests**

`src/web/components/ui/dialog.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">outside before</button>
      <Dialog open={open} onClose={() => { setOpen(false); onClose(); }} title="Confirm">
        <Button onClick={() => {}}>First</Button>
        <Button onClick={() => {}}>Second</Button>
      </Dialog>
      <button type="button">outside after</button>
    </>
  );
}

describe("Dialog", () => {
  it("moves focus into the dialog when it opens", async () => {
    render(<Harness />);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("traps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    first.focus();
    await user.tab();
    expect(second).toHaveFocus();
    await user.tab();
    // Wraps back into the dialog rather than escaping to "outside after".
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("traps Shift+Tab backwards too", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: "First" }).focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  it("closes on Escape from anywhere on the page", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    document.body.focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("restores focus to the element that had it when it opened", async () => {
    const user = userEvent.setup();
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Confirm">
            <Button onClick={() => setOpen(false)}>Done</Button>
          </Dialog>
        </>
      );
    }
    render(<Toggle />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("renders nothing when closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Confirm">
        <span>hidden</span>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("hidden")).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web/components/ui/dialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/web/components/ui/Dialog.tsx`. Use tokens only, and give the panel a real border — `border border-border`, not `border-border` alone, which sets a colour on a zero-width border and draws nothing.

```typescript
import { type ReactNode, useEffect, useId, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({
  open, onClose, title, describedBy, role = "dialog", children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => {
      // Restoring focus on close is what keeps keyboard context; without it
      // focus falls to <body> and the user loses their place entirely.
      restoreTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // On the document, not the panel: Escape must work even when focus has
    // drifted outside, which is how Plan 3's inline confirmation lost it.
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-4 sm:items-center">
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        className="w-full max-w-md rounded-lg border border-border bg-raised p-4 shadow-lg"
      >
        <h2 id={titleId} className="mb-3 font-semibold text-lg text-text">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Export it and migrate the bespoke dialog**

Add `export { Dialog } from "./Dialog.js";` to `src/web/components/ui/index.ts`, then replace the hand-rolled `role="alertdialog"` block in `src/web/routes/ProjectDetail.tsx` with `<Dialog role="alertdialog" …>`, keeping its existing copy — containers and networks are deleted, named volumes survive — and its existing tests passing unchanged.

- [ ] **Step 5: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm e2e`
Expected: PASS, including Plan 3's existing confirmation tests and the phone tap sweep with the dialog open.

- [ ] **Step 6: Prove the trap can fail**

Delete the `Tab` branch from the keydown handler. The two trap tests must go red. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/web/components/ui/Dialog.tsx src/web/components/ui/index.ts src/web/components/ui/dialog.test.tsx src/web/routes/ProjectDetail.tsx
git commit -m "feat: add a real modal dialog primitive and adopt it"
```

---

### Task 7: Authoring query hooks

**Files:**
- Modify: `src/web/lib/queries.ts`
- Test: `src/web/lib/queries.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  queryKeys.file = (slug: string, name: "compose" | "env") => ["project", slug, "file", name];
  export function useProjectFile(slug: string, name: "compose" | "env"):
    UseQueryResult<{ content: string } | null>;   // null when the file does not exist (404)
  export function useSaveProjectFile(slug: string, name: "compose" | "env"):
    UseMutationResult<void, Error, string>;
  export function useCreateProject():
    UseMutationResult<{ slug: string; valid: boolean; error?: string }, Error,
                      { slug: string; source: "blank" | "paste"; content?: string }>;
  export function useDeleteProject():
    UseMutationResult<void, Error, string>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/web/lib/queries.test.tsx`, reusing that file's existing `renderHookWithClient` helper and `mockFetch`:

```typescript
describe("useProjectFile", () => {
  it("returns null rather than throwing when the file does not exist", async () => {
    // A project with no .env is normal, and the route renders it as 404.
    // Throwing would make the editor show an error for an ordinary state.
    mockFetch(404, { error: "not_found" });
    const { result } = renderHookWithClient(() => useProjectFile("media", "env"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("returns the content on success", async () => {
    mockFetch(200, { content: "A=1\n" });
    const { result } = renderHookWithClient(() => useProjectFile("media", "env"));
    await waitFor(() => expect(result.current.data).toEqual({ content: "A=1\n" }));
  });

  it("still surfaces a 403 as an error", async () => {
    mockFetch(403, { error: "forbidden" });
    const { result } = renderHookWithClient(() => useProjectFile("media", "compose"));
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useSaveProjectFile", () => {
  it("PUTs the content to the file route", async () => {
    const fetchMock = mockFetch(200, { ok: true });
    const { result } = renderHookWithClient(() => useSaveProjectFile("media", "compose"));
    await act(async () => { await result.current.mutateAsync("services: {}\n"); });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/media/file/compose");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ content: "services: {}\n" });
  });
});

describe("useCreateProject", () => {
  it("reports an invalid paste as data, not as a failure", async () => {
    // 201 with valid:false — the project exists and the user must reach its
    // editor, so this must not land in the error branch.
    mockFetch(201, { slug: "broken", valid: false, error: "services must be a mapping" });
    const { result } = renderHookWithClient(() => useCreateProject());
    let out: unknown;
    await act(async () => {
      out = await result.current.mutateAsync({ slug: "broken", source: "paste", content: "x" });
    });
    expect(out).toMatchObject({ slug: "broken", valid: false });
  });

  it("surfaces a 409 as an ApiError carrying the code", async () => {
    mockFetch(409, { error: "project_exists" });
    const { result } = renderHookWithClient(() => useCreateProject());
    await expect(
      result.current.mutateAsync({ slug: "media", source: "blank" }),
    ).rejects.toMatchObject({ status: 409, code: "project_exists" });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web/lib/queries.test.tsx`
Expected: FAIL — the four hooks are not exported.

- [ ] **Step 3: Implement**

Add to `src/web/lib/queries.ts`. **Do not set `retry` or `refetchOnWindowFocus` on any of these** — refusal-aware behaviour is a client default, and re-adding it per hook is exactly the drift the final review of Plan 3 caught.

```typescript
export function useProjectFile(slug: string, name: "compose" | "env") {
  return useQuery({
    queryKey: queryKeys.file(slug, name),
    queryFn: async () => {
      try {
        return await apiFetch<{ content: string }>(`/api/projects/${slug}/file/${name}`);
      } catch (err) {
        // A project with no `.env` is an ordinary state, not a failure: the
        // editor offers to create one. Every other status still throws.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useSaveProjectFile(slug: string, name: "compose" | "env") {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      await apiFetch(`/api/projects/${slug}/file/${name}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.file(slug, name) });
      client.invalidateQueries({ queryKey: queryKeys.project(slug) });
    },
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: { slug: string; source: "blank" | "paste"; content?: string }) => {
      const res = await apiFetch<{ slug: string; valid: boolean; error?: string }>(
        "/api/projects",
        { method: "POST", body: JSON.stringify(body) },
      );
      if (!res) throw new Error("create returned no body");
      return res;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

export function useDeleteProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => {
      await apiFetch(`/api/projects/${slug}`, { method: "DELETE" });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}
```

Extend `queryKeys` with `file: (slug: string, name: "compose" | "env") => ["project", slug, "file", name] as const`.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/web && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/queries.ts src/web/lib/queries.test.tsx
git commit -m "feat: add query hooks for reading, saving, creating and deleting"
```

---

### Task 8: The compose editor

**Files:**
- Create: `src/web/components/ComposeEditor.tsx`
- Modify: `package.json` (add CodeMirror)
- Test: `src/web/components/compose-editor.test.tsx`

**Interfaces:**
- Consumes: `useProjectFile`, `useSaveProjectFile` (Task 7).
- Produces: `<ComposeEditor slug={string} value={string} onChange={(v: string) => void} onSave={() => void} dirty={boolean} />`.

**Why CodeMirror and not Monaco** (spec §4.1): Monaco's own documentation states mobile browsers are unsupported, and it ships several megabytes plus web workers — unacceptable for a SPA served off a NAS under a full mobile-parity requirement. CodeMirror 6 gives YAML highlighting, bracket and indent awareness, line numbers and inline lint markers at roughly 150–200 KB.

**Phone keyboards have no Tab key and YAML is indentation-sensitive.** The touch toolbar is not a nicety: without it, mobile compose editing is theoretically available and practically impossible.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm add codemirror@6 @codemirror/lang-yaml @codemirror/commands @codemirror/lint @codemirror/state @codemirror/view
```

Verified current versions: `codemirror` 6.0.2, `@codemirror/lang-yaml` 6.1.3. Verified exports: `indentMore`, `indentLess`, `defaultKeymap`, `history`, `historyKeymap`, `indentWithTab` from `@codemirror/commands`; `yaml` from `@codemirror/lang-yaml`; `linter`, `lintGutter` from `@codemirror/lint`.

- [ ] **Step 2: Write the failing tests**

`src/web/components/compose-editor.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposeEditor } from "./ComposeEditor.js";

const props = {
  slug: "media",
  value: "services:\n  web:\n    image: nginx\n",
  onChange: () => {},
  onSave: () => {},
  dirty: false,
};

describe("ComposeEditor", () => {
  it("renders the document", async () => {
    render(<ComposeEditor {...props} />);
    expect(await screen.findByText(/image: nginx/)).toBeInTheDocument();
  });

  it("offers indent, outdent and save without a physical keyboard", () => {
    // Spec §4.1: phone keyboards have no Tab key and YAML is
    // indentation-sensitive, so these must be reachable by touch.
    render(<ComposeEditor {...props} />);
    for (const name of [/indent/i, /outdent/i, /save/i])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  it("indents the current line when the toolbar button is pressed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ComposeEditor {...props} value={"a: 1\n"} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /indent/i }));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toMatch(/^\s+a: 1/);
  });

  it("calls onSave from the toolbar", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ComposeEditor {...props} dirty onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalled();
  });

  it("disables save when there is nothing to save", () => {
    render(<ComposeEditor {...props} dirty={false} />);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm vitest run src/web/components/compose-editor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/web/components/ComposeEditor.tsx`:

```typescript
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { lintGutter, linter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { parseDocument } from "yaml";
import { Button } from "./ui/index.js";

/**
 * Inline syntax errors as you type. `POST /api/projects/:slug/validate` stays
 * the authoritative check on save — only `docker compose config` knows the
 * real schema — but a YAML parse error is worth showing immediately.
 */
const yamlLint = linter((view) => {
  const text = view.state.doc.toString();
  const doc = parseDocument(text);
  return doc.errors.map((e) => ({
    from: Math.min(e.pos[0], text.length),
    to: Math.min(e.pos[1], text.length),
    severity: "error" as const,
    message: e.message,
  }));
});

export function ComposeEditor({
  value, onChange, onSave, dirty,
}: {
  slug: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  dirty: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          yaml(),
          yamlLint,
          lintGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.theme({ "&": { fontSize: "14px" }, ".cm-content": { fontFamily: "monospace" } }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Mount once. `value` is the initial document; later external changes are
    // reconciled by the effect below, because recreating the view on every
    // keystroke would destroy the cursor and the undo history.
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  const run = (command: (v: EditorView) => boolean) => () => {
    const editor = view.current;
    if (!editor) return;
    command(editor);
    editor.focus();
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Phone keyboards have no Tab key, and YAML is indentation-sensitive. */}
      <div className="flex items-center gap-2" role="toolbar" aria-label="Editor actions">
        <Button onClick={run(indentMore)} aria-label="Indent">Indent</Button>
        <Button onClick={run(indentLess)} aria-label="Outdent">Outdent</Button>
        <Button onClick={onSave} disabled={!dirty} aria-label="Save">Save</Button>
      </div>
      <div
        ref={host}
        className="overflow-auto rounded-md border border-border bg-surface"
        style={{ maxHeight: "60vh" }}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run and watch them pass**

Run: `pnpm vitest run src/web/components/compose-editor.test.tsx && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Prove the indent test can fail**

Change `run(indentMore)` to `run(indentLess)` on the Indent button. The indent test must go red. Restore.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/web/components/ComposeEditor.tsx src/web/components/compose-editor.test.tsx
git commit -m "feat: add the CodeMirror compose editor with a touch toolbar"
```

---

### Task 9: The `.env` structured editor

**Files:**
- Create: `src/web/components/EnvEditor.tsx`
- Test: `src/web/components/env-editor.test.tsx`

**Interfaces:**
- Consumes: `parseEnv`, `serializeEnv`, `setEntryValue`, `addEntry`, `removeEntry`, `isSecretKey` (Task 2); `Input`, `Button`, `IconButton`, `SegmentedControl`, `EmptyState` (Plan 3).
- Produces: `<EnvEditor value={string | null} onChange={(next: string) => void} onSave={() => void} dirty={boolean} />`. A `null` value means the file does not exist yet.

Spec §4.2: the form's real advantage over a textarea is **capability**, not ergonomics — it can validate keys, quote values correctly on write, and mask secret-looking values. The raw toggle exists so that multi-line values and exotic quoting stay editable rather than becoming unreachable.

- [ ] **Step 1: Write the failing tests**

`src/web/components/env-editor.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvEditor } from "./EnvEditor.js";

const FILE = `# get this from the admin panel
DB_PASSWORD=hunter2
TZ=Europe/London
`;

const base = { onChange: () => {}, onSave: () => {}, dirty: false };

describe("EnvEditor", () => {
  it("shows one row per entry and hides comments from the form", async () => {
    render(<EnvEditor {...base} value={FILE} />);
    expect(screen.getByDisplayValue("DB_PASSWORD")).toBeInTheDocument();
    expect(screen.getByDisplayValue("TZ")).toBeInTheDocument();
  });

  it("masks a secret-looking value until revealed", async () => {
    const user = userEvent.setup();
    render(<EnvEditor {...base} value={FILE} />);
    const secret = screen.getByLabelText("Value for DB_PASSWORD");
    expect(secret).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: /show DB_PASSWORD/i }));
    expect(secret).toHaveAttribute("type", "text");
  });

  it("does not mask an ordinary setting", () => {
    render(<EnvEditor {...base} value={FILE} />);
    expect(screen.getByLabelText("Value for TZ")).toHaveAttribute("type", "text");
  });

  it("preserves comments when a value is edited", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EnvEditor {...base} value={FILE} onChange={onChange} />);
    await user.clear(screen.getByLabelText("Value for TZ"));
    await user.type(screen.getByLabelText("Value for TZ"), "UTC");
    const next = onChange.mock.calls.at(-1)?.[0] as string;
    expect(next).toContain("# get this from the admin panel");
    expect(next).toContain("TZ=UTC");
    expect(next).toContain("DB_PASSWORD=hunter2");
  });

  it("offers to create the file when there is none", () => {
    render(<EnvEditor {...base} value={null} />);
    expect(screen.getByRole("button", { name: /create .env/i })).toBeInTheDocument();
  });

  it("keeps unmodelled lines reachable through the raw view", async () => {
    const user = userEvent.setup();
    const weird = 'MULTI="line one\nline two"\n';
    render(<EnvEditor {...base} value={weird} />);
    await user.click(screen.getByRole("radio", { name: /raw/i }));
    expect(await screen.findByText(/line two/)).toBeInTheDocument();
  });

  it("rejects a key that compose cannot use", async () => {
    const user = userEvent.setup();
    render(<EnvEditor {...base} value={"A=1\n"} />);
    await user.click(screen.getByRole("button", { name: /add variable/i }));
    const key = screen.getByLabelText(/key for the new variable/i);
    await user.type(key, "2BAD KEY");
    expect(await screen.findByText(/letters, digits and underscores/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web/components/env-editor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/web/components/EnvEditor.tsx`. Drive every edit through the Task 2 model so the round-trip guarantee holds; never rebuild the file from the rows.

```typescript
import { useState } from "react";
import {
  type EnvLine, addEntry, isSecretKey, parseEnv, removeEntry, serializeEnv, setEntryValue,
} from "@shared/env.js";
import { Button, EmptyState, IconButton, Input, SegmentedControl } from "./ui/index.js";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_HINT =
  "Keys may contain letters, digits and underscores, and may not start with a digit.";

export function EnvEditor({
  value, onChange, onSave, dirty,
}: {
  /** `null` means the project has no `.env` yet. */
  value: string | null;
  onChange: (next: string) => void;
  onSave: () => void;
  dirty: boolean;
}) {
  const [view, setView] = useState<"form" | "raw">("form");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState("");

  if (value === null)
    return (
      <EmptyState
        title="No .env file"
        body="This project has no .env yet. Creating one lets compose substitute variables into its file."
      >
        {/* The first save writes it; writeProjectFile takes no snapshot when
            the target does not exist, which is already the correct behaviour. */}
        <Button onClick={() => onChange("")}>Create .env</Button>
      </EmptyState>
    );

  const lines = parseEnv(value);
  const entries = lines.filter(
    (l): l is Extract<EnvLine, { kind: "entry" }> => l.kind === "entry",
  );
  // Every write serialises the FULL line list, so comments, blanks and lines
  // the parser does not model survive untouched. Rebuilding from `entries`
  // would delete them on first save — the failure §4.2 exists to prevent.
  const emit = (next: EnvLine[]) => onChange(serializeEnv(next));

  const keyError = newKey !== "" && !KEY_RE.test(newKey) ? KEY_HINT : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl
          name="env-view"
          value={view}
          onChange={(v) => setView(v as "form" | "raw")}
          options={[
            { value: "form", label: "Form" },
            { value: "raw", label: "Raw" },
          ]}
        />
        <Button onClick={onSave} disabled={!dirty}>Save</Button>
      </div>

      {view === "raw" ? (
        // The escape hatch §4.2 requires: multi-line values and exotic quoting
        // stay editable rather than becoming unreachable through the form.
        <textarea
          aria-label="Raw .env contents"
          className="min-h-64 rounded-md border border-border bg-surface p-2 font-mono text-sm text-text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const secret = isSecretKey(entry.key);
              const shown = revealed[entry.key] === true;
              return (
                <li key={entry.key} className="flex flex-wrap items-center gap-2">
                  <Input aria-label={`Key ${entry.key}`} value={entry.key} readOnly />
                  <Input
                    aria-label={`Value for ${entry.key}`}
                    type={secret && !shown ? "password" : "text"}
                    value={entry.value}
                    onChange={(e) => emit(setEntryValue(lines, entry.key, e.target.value))}
                  />
                  {secret ? (
                    <IconButton
                      aria-label={`${shown ? "Hide" : "Show"} ${entry.key}`}
                      onClick={() =>
                        setRevealed((r) => ({ ...r, [entry.key]: !shown }))
                      }
                    >
                      {shown ? "🙈" : "👁"}
                    </IconButton>
                  ) : null}
                  <IconButton
                    aria-label={`Remove ${entry.key}`}
                    onClick={() => emit(removeEntry(lines, entry.key))}
                  >
                    ✕
                  </IconButton>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Key for the new variable"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <Button
              disabled={newKey === "" || keyError !== null}
              onClick={() => {
                emit(addEntry(lines, newKey, ""));
                setNewKey("");
              }}
            >
              Add variable
            </Button>
          </div>
          {keyError ? (
            <p role="alert" className="text-danger text-sm">{keyError}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
```

The test for the "Add variable" flow clicks the button first and then types, so keep the button rendered (disabled) rather than hidden, and render the hint as soon as the typed key is invalid.

Every control here inherits 44px from `Button`, `IconButton` and `Input`; the raw `<textarea>` carries `border border-border`, never `border-border` alone — a colour with no width draws nothing.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/web && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Prove the preservation test can fail**

Change `onChange` to emit a file rebuilt from the rows (`rows.map(r => `${r.key}=${r.value}`).join("\n")`). The comment-preservation test must go red. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/EnvEditor.tsx src/web/components/env-editor.test.tsx
git commit -m "feat: add the structured .env editor with a raw fallback"
```

---

### Task 10: Create, delete, the Edit tab, and unsaved-change guards

**Files:**
- Create: `src/web/routes/CreateProject.tsx`, `src/web/routes/project/Edit.tsx`, `src/web/components/DeleteProjectDialog.tsx`, `src/web/lib/useUnsavedChanges.ts`
- Modify: `src/web/App.tsx`, `src/web/routes/ProjectDetail.tsx`, `src/web/routes/ProjectList.tsx`
- Test: `src/web/routes/create-project.test.tsx`, `src/web/lib/unsaved.test.tsx`, `e2e/authoring.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: the `/projects/new` route; `<Edit />` mounted at the `edit` child route; `useUnsavedChanges(dirty: boolean): { blocked: boolean; proceed: () => void; cancel: () => void }`.

- [ ] **Step 1: Write the failing tests**

`src/web/lib/unsaved.test.tsx` asserts that `useUnsavedChanges(true)` blocks a navigation and that `proceed()` releases it, and that `useUnsavedChanges(false)` never blocks.

`src/web/routes/create-project.test.tsx`:

```typescript
it("rejects an invalid slug before any request is made", async () => {
  const user = userEvent.setup();
  const fetchMock = mockFetch(201, { slug: "x", valid: true });
  renderCreate();
  await user.type(screen.getByLabelText(/name/i), "../evil");
  await user.click(screen.getByRole("button", { name: /create/i }));
  expect(await screen.findByText(/letters, digits/i)).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("says the name is permanent, because rename is deferred", () => {
  renderCreate();
  expect(screen.getByText(/cannot be changed later/i)).toBeInTheDocument();
});

it("reports a name that is already taken", async () => {
  const user = userEvent.setup();
  mockFetch(409, { error: "project_exists" });
  renderCreate();
  await user.type(screen.getByLabelText(/name/i), "media");
  await user.click(screen.getByRole("button", { name: /create/i }));
  expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
});

it("lands in the editor even when a pasted file is invalid", async () => {
  const user = userEvent.setup();
  mockFetch(201, { slug: "broken", valid: false, error: "services must be a mapping" });
  renderCreate();
  await user.type(screen.getByLabelText(/name/i), "broken");
  await user.click(screen.getByRole("radio", { name: /paste/i }));
  await user.type(screen.getByLabelText(/compose file/i), "services:\n  - [nope");
  await user.click(screen.getByRole("button", { name: /create/i }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/projects/broken/edit"));
});
```

`e2e/authoring.spec.ts` — importing `test` from `./support/fixtures.js` — covers the round trip against the real server with a UUID-suffixed slug it creates and deletes itself:

1. Create a blank project from `/projects/new`; it appears in the list.
2. Open its Edit tab, change the compose file, save, and confirm the content survives a reload.
3. Add a variable in the `.env` form, save, and confirm a hand-written comment seeded into the file is still present afterwards — the round-trip requirement, asserted end to end.
4. Navigating away with unsaved changes prompts; cancelling stays put.
5. Delete requires the typed slug, and the project disappears from the list.
6. A project created by Homestead deletes with **one** confirmation; a directory seeded on disk without an `x-homestead` block requires **two**.

Assertions must be scoped to this spec's own uniquely-named fixtures — no global counts, no wiping the projects root. Run `expectTappable` and `expectNoHorizontalScroll` on `/projects/new` and the Edit tab, since neither route is covered by an existing sweep.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web && pnpm e2e`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement `useUnsavedChanges`**

`src/web/lib/useUnsavedChanges.ts`:

```typescript
import { useBlocker } from "react-router-dom";

/**
 * Router-level guard for an editor with unsaved work.
 *
 * `Edit.tsx` also calls this for the Compose ↔ `.env` switch, which the router
 * never sees: both editors live under one route, so navigating between them is
 * an in-page state change that would otherwise discard the buffer silently.
 */
export function useUnsavedChanges(dirty: boolean) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  return {
    blocked: blocker.state === "blocked",
    proceed: () => blocker.proceed?.(),
    cancel: () => blocker.reset?.(),
  };
}
```

- [ ] **Step 4: Implement `CreateProject`**

`src/web/routes/CreateProject.tsx`. Validate with the shared `isValidSlug` **before** issuing a request, and navigate on success even when `valid === false` — storing an invalid paste is pointless if the user cannot then reach it.

```typescript
import { isValidSlug } from "@shared/projects.js";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, SegmentedControl } from "../components/ui/index.js";
import { ApiError } from "../lib/api.js";
import { useCreateProject } from "../lib/queries.js";

const SLUG_HINT =
  "Use letters, digits, dots, dashes and underscores. It must not start with a dot.";

export function CreateProject() {
  const navigate = useNavigate();
  const create = useCreateProject();
  const [slug, setSlug] = useState("");
  const [source, setSource] = useState<"blank" | "paste">("blank");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!isValidSlug(slug)) return setError(SLUG_HINT);
    setError(null);
    try {
      const res = await create.mutateAsync({
        slug, source, ...(source === "paste" ? { content } : {}),
      });
      // Navigate even when res.valid === false: the file is stored, and the
      // detail page surfaces parseError so the user can fix it in the editor.
      navigate(`/projects/${res.slug}/edit`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "project_exists")
        return setError(`A project named "${slug}" already exists.`);
      setError("Could not create the project. Please try again.");
    }
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="font-semibold text-2xl text-text">New project</h1>
      <label className="flex flex-col gap-1">
        <span className="text-muted text-sm">Name</span>
        <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
        {/* Rename is deferred (§8), so say so rather than letting someone
            discover it after they have built a stack around the name. */}
        <span className="text-muted text-sm">
          This becomes the directory on disk and cannot be changed later.
        </span>
      </label>

      <SegmentedControl
        name="create-source"
        value={source}
        onChange={(v) => setSource(v as "blank" | "paste")}
        options={[
          { value: "blank", label: "Blank" },
          { value: "paste", label: "Paste a compose file" },
        ]}
      />

      {source === "paste" ? (
        <textarea
          aria-label="Compose file"
          className="min-h-64 rounded-md border border-border bg-surface p-2 font-mono text-sm text-text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      ) : null}

      {error ? <p role="alert" className="text-danger text-sm">{error}</p> : null}
      <Button onClick={submit} disabled={create.isPending}>Create project</Button>
    </main>
  );
}
```

- [ ] **Step 5: Implement `DeleteProjectDialog` and mount everything**

`DeleteProjectDialog.tsx` uses the Task 6 `Dialog` and requires the slug typed exactly:

```typescript
const adopted = !detail.hasHomestead;   // absence of x-homestead is the marker
const orphans = detail.model?.volumes.filter((v) => !v.external) ?? [];
```

- The confirm button stays disabled until `typed === slug`.
- `orphans` are listed as **left behind**, with the `docker volume rm <name>` line needed to remove them by hand — spec §3.7 keeps named volumes and §8 defers their deletion.
- When `adopted` is true, confirming once reveals a second confirmation before the request is sent. A directory Homestead did not create is the one likeliest to hold something the user cares about, which is exactly why the provenance marker is worth reading.

`hasHomestead` already arrives on the detail response — Task 5 added it — so this task is client-only and touches no server file.

Then: register `/projects/new` in `App.tsx` inside the existing protected layout route, keeping every current registration; render `<Edit />` in place of the `Compose editor` placeholder at `ProjectDetail.tsx:99-102`; mount the delete dialog from the detail header; and add a "New project" action to `ProjectList.tsx`.

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm e2e`
Expected: PASS at both viewports.

- [ ] **Step 7: Confirm no host side effects**

```bash
docker ps -a --format '{{.ID}} {{.Names}}' | sort > /tmp/before.txt
pnpm e2e
docker ps -a --format '{{.ID}} {{.Names}}' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "no container drift"
```

Expected: no drift, and no surviving `docker compose logs` process.

- [ ] **Step 8: Commit**

```bash
git add src/web e2e
git commit -m "feat: add project creation, deletion and the edit tab"
```

---

## Definition of Done

- `pnpm typecheck`, `pnpm test`, `pnpm lint` clean; `pnpm e2e` green at **both** viewports.
- `src/server/auth/permissions.ts` byte-identical to `2a8a6c5`.
- A blank project can be created, edited and deleted entirely from a phone.
- A pasted compose file keeps its comments, gains `x-homestead`, and reaches the editor even when invalid.
- Editing one `.env` value leaves every comment, blank line and unmodelled line byte-identical.
- A `.env` that does not exist yet can be created from the form.
- Deleting asks for the typed slug, asks twice for an adopted project, and lists the named volumes it is leaving behind.
- Navigating away from an unsaved editor prompts; so does switching between Compose and `.env`.
- No test starts a real container; `docker ps -a` and `docker volume ls` are unchanged by a full run.

## Handoff to Plan 5 (Devices)

- `Dialog` is now a real primitive with a focus trap; Plan 3's bespoke `alertdialog` is gone.
- `src/shared/env.ts` and `isValidSlug` are browser-safe and available to any later screen.
- `doc.ts` is the place any future compose mutation belongs — it edits the Document, so comments survive.
- Still deferred, and still worth revisiting: **rename** and **named-volume deletion** as one volume-hazard task set (§8); the missing-`${VAR}` check (§9.2), whose absence lets a database come up with a blank password while the stack looks healthy; and the log-stream idle bound, so a forgotten background tab stops holding `docker compose logs -f` open.
