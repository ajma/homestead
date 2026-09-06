# Homestead Plan 3 — Design System, Shell, Browse & Operate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser interface — working identically on desktop and phone — that lists every project, shows its services and status, runs lifecycle commands with streamed output, and follows container logs.

**Architecture:** A semantic design-token layer in Tailwind 4's `@theme`, which emits CSS custom properties so themes resolve at runtime. Components reference tokens only, enforced by a test. TanStack Query owns reads; SSE streams go to component state via hooks. Tab state lives in the URL.

**Tech Stack:** React 19, react-router-dom 7, TanStack Query 5, Tailwind 4.3, Vitest + `@testing-library/react`, Playwright at two viewports.

**Spec:** `docs/superpowers/specs/2026-09-06-project-ui-design.md`
**Product spec:** `docs/superpowers/specs/2026-09-05-homestead-design.md`
**Predecessors:** Plan 1 (`aee26d3`), Plan 2 (`0b7deff`), rename (`2a8a6c5`)

## Global Constraints

- Node LTS, pnpm, ESM. TypeScript `strict: true`, `moduleResolution: "bundler"`, `target: "ES2022"`. **TypeScript is 7.0.2.** Do not modify `tsconfig.json`.
- All gates clean before every commit: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm e2e`.
- Newest stable major of every dependency. **No RCs or betas.** `better-auth` stays pinned at exactly `1.7.2`; `src/server/db/auth-schema.ts` is hand-maintained — do not touch either.
- Biome is the only linter/formatter. Path alias `@shared/*` → `src/shared/*`.
- **Never add a `Co-Authored-By` trailer or AI-attribution line to commit messages.**
- **`src/server/auth/permissions.ts` must remain byte-identical to `aee26d3`.** A privilege escalation reached this codebase once via an unscoped edit to that file. No task in this plan has any reason to touch it.
- **No hardcoded colour in any component.** Every colour comes from a token. Task 2 ships the test that enforces this; from then on it is a gate, not a guideline.
- **Everything must work at 390 px wide.** Task 10 adds a phone viewport to Playwright; until then, check your work at that width manually.
- Server routes are already authorized. The UI must still handle 401 (redirect), 403 (inline), 409 (operation running) and 5xx (generic + retry) — never assume the happy path.

## Not in this plan

The compose editor, the `.env` form, project creation and deletion (Plan 4). Devices, the dashboard app-grid and its customization UI, and packaging — later plans. The `/` route keeps its placeholder.

Carried in and still open: relax the `?service=` regex, which rejects an empty value and names beginning `_` or `.`; surface stream errors as SSE `error` events; sweep orphaned `$HOMESTEAD_DATA/run/*.override.yml`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/web/theme.css` | `@theme` token definitions; light on `:root`, dark under `[data-theme="dark"]`. |
| `src/web/lib/theme.ts` | Resolve, apply and persist the colour scheme. |
| `src/web/lib/api.ts` | Typed `fetch` wrapper: JSON, error classes, 401 handling. |
| `src/web/lib/queries.ts` | Query keys and hooks for projects. |
| `src/web/lib/useEventStream.ts` | Shared SSE hook; replay-safe. |
| `src/web/components/ui/*` | Primitives: Button, IconButton, Panel, Badge, StatusDot, EmptyState, Spinner, Tabs, SegmentedControl. |
| `src/web/components/AppShell.tsx` | Header, nav, theme toggle, user menu. |
| `src/web/routes/ProjectList.tsx` | `/projects`. |
| `src/web/routes/ProjectDetail.tsx` | Header, lifecycle controls, tab routing. |
| `src/web/routes/project/Overview.tsx` | Services, ports, volumes, snapshots, history. |
| `src/web/routes/project/Logs.tsx` | Container log follower. |
| `src/web/components/OperationPanel.tsx` | Docked operation output. |
| `src/web/routes/NotFound.tsx` | 404. |
| `src/server/projects/model.ts` | *Modified:* add `volumes` to `ProjectModel`. |

---

### Task 1: Expose named volumes in the project model

**Files:**
- Modify: `src/shared/projects.ts`, `src/server/projects/model.ts`
- Test: `src/server/projects/model.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProjectModel.volumes: string[]` — the project's top-level named volume keys, sorted.

**Why:** Overview shows which volumes a project owns, and Plan 4's delete dialog lists the ones it will leave behind. `parseCanonical` currently returns only `projectName`, `services` and `meta`, so that information is unavailable to the client.

- [ ] **Step 1: Write the failing test**

Add to `src/server/projects/model.test.ts`:

```typescript
describe("named volumes", () => {
  it("extracts top-level volume keys, sorted", () => {
    const json = {
      name: "media",
      services: {},
      volumes: { cache: null, appdata: { driver: "local" }, backups: null },
    };
    expect(parseCanonical(json).volumes).toEqual(["appdata", "backups", "cache"]);
  });

  it("returns an empty array when there are no volumes", () => {
    expect(parseCanonical({ name: "p", services: {} }).volumes).toEqual([]);
  });

  it("ignores a volumes key that is not an object", () => {
    expect(parseCanonical({ name: "p", services: {}, volumes: "nonsense" }).volumes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/server/projects/model.test.ts`
Expected: FAIL — `volumes` is undefined.

- [ ] **Step 3: Implement**

In `src/shared/projects.ts`, add to `ProjectModel`:

```typescript
  /** Top-level named volumes this project owns, sorted. */
  volumes: string[];
```

In `src/server/projects/model.ts`, inside `parseCanonical`'s return:

```typescript
  return {
    projectName: root.name,
    services,
    volumes: Object.keys(asRecord(root.volumes)).sort(),
    meta: parseMeta(root["x-homestead"]),
  };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run src/server/projects/model.test.ts`
Expected: PASS

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/shared/projects.ts src/server/projects
git commit -m "feat: expose named volumes in the project model"
```

---

### Task 2: Design tokens, light/dark, and the conformance gate

**Files:**
- Create: `src/web/theme.css`, `src/web/lib/theme.ts`
- Modify: `src/web/index.css`, `src/web/main.tsx`, `src/web/index.html`
- Test: `src/web/lib/theme.test.ts`, `src/web/design-system.test.ts`

**Interfaces:**
- Produces:
  - `type ColorScheme = "light" | "dark" | "system"`
  - `resolveScheme(stored: string | null, prefersDark: boolean): "light" | "dark"`
  - `applyScheme(scheme: "light" | "dark"): void` — sets `data-theme` on `<html>`
  - `readStoredScheme(): ColorScheme` / `storeScheme(s: ColorScheme): void`

**Why the conformance test exists:** a theming system dies one component at a time. The first screen that reaches for `bg-slate-800` stops responding to the theme, and nothing fails until someone switches mode. Making it a test turns a convention into a gate.

- [ ] **Step 1: Write the token layer**

`src/web/theme.css`:

```css
@theme {
  --color-bg: #f8fafc;
  --color-surface: #ffffff;
  --color-raised: #f1f5f9;
  --color-border: #e2e8f0;
  --color-text: #0f172a;
  --color-muted: #64748b;
  --color-accent: #2563eb;
  --color-accent-contrast: #ffffff;
  --color-danger: #dc2626;
  --color-success: #16a34a;
  --color-warning: #d97706;
  --color-overlay: rgb(15 23 42 / 0.5);
}

[data-theme="dark"] {
  --color-bg: #0b1120;
  --color-surface: #111827;
  --color-raised: #1f2937;
  --color-border: #334155;
  --color-text: #f1f5f9;
  --color-muted: #94a3b8;
  --color-accent: #60a5fa;
  --color-accent-contrast: #0b1120;
  --color-danger: #f87171;
  --color-success: #4ade80;
  --color-warning: #fbbf24;
  --color-overlay: rgb(0 0 0 / 0.6);
}

html, body, #root { height: 100%; }
body { background-color: var(--color-bg); color: var(--color-text); }
```

`src/web/index.css` becomes:

```css
@import "tailwindcss";
@import "./theme.css";
```

Note the dark block is a plain selector, not inside `@theme` — `@theme` declares the tokens and generates the utilities; the override block only reassigns their values.

- [ ] **Step 2: Write the failing tests**

`src/web/lib/theme.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolveScheme } from "./theme.js";

describe("resolveScheme", () => {
  it("follows the OS when nothing is stored", () => {
    expect(resolveScheme(null, true)).toBe("dark");
    expect(resolveScheme(null, false)).toBe("light");
  });

  it("follows the OS when the stored value is 'system'", () => {
    expect(resolveScheme("system", true)).toBe("dark");
  });

  it("honours an explicit stored choice over the OS", () => {
    expect(resolveScheme("light", true)).toBe("light");
    expect(resolveScheme("dark", false)).toBe("dark");
  });

  it("falls back to the OS for an unrecognised stored value", () => {
    expect(resolveScheme("chartreuse", true)).toBe("dark");
  });
});
```

`src/web/design-system.test.ts`:

```typescript
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "src/web";
const ALLOWED = new Set(["src/web/theme.css"]);

/** Tailwind palette utilities — the tokens are semantic, so these must not appear. */
const PALETTE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|decoration|shadow|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(tsx|ts|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("design system conformance", () => {
  it("no component uses a Tailwind palette utility or a raw hex colour", async () => {
    const offenders: string[] = [];
    for (const file of await walk(ROOT)) {
      if (ALLOWED.has(file)) continue;
      const text = await readFile(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (PALETTE.test(line)) offenders.push(`${file}:${i + 1} palette utility: ${line.trim()}`);
        if (HEX.test(line)) offenders.push(`${file}:${i + 1} hex colour: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm vitest run src/web`
Expected: `theme.test.ts` fails (module missing). `design-system.test.ts` **fails listing the existing Plan 1 screens** — `Login.tsx`, `Setup.tsx`, `Dashboard.tsx`, `ProtectedRoute.tsx` all use `bg-slate-900`, `text-red-600` and similar. That failure is correct and expected; Step 5 fixes them.

- [ ] **Step 4: Implement the theme module**

`src/web/lib/theme.ts`:

```typescript
export type ColorScheme = "light" | "dark" | "system";

const KEY = "homestead.color-scheme";

export function resolveScheme(stored: string | null, prefersDark: boolean): "light" | "dark" {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function readStoredScheme(): ColorScheme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function storeScheme(scheme: ColorScheme): void {
  if (scheme === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, scheme);
}

export function applyScheme(scheme: "light" | "dark"): void {
  document.documentElement.dataset.theme = scheme;
}
```

In `src/web/index.html`, before the module script, add an inline script so the theme is applied before first paint and there is no flash of the wrong scheme:

```html
<script>
  try {
    var s = localStorage.getItem("homestead.color-scheme");
    var dark = s === "dark" || (s !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (_) {}
</script>
```

- [ ] **Step 5: Migrate the existing Plan 1 screens to tokens**

`Login.tsx`, `Setup.tsx`, `Dashboard.tsx` and `ProtectedRoute.tsx` currently use palette utilities. Replace them: `bg-slate-900` → `bg-accent`, `text-white` on buttons → `text-accent-contrast`, `text-slate-500` → `text-muted`, `text-red-600` → `text-danger`, `border` → `border-border`, and give inputs `bg-surface text-text`.

Change **only** the class names. Do not restructure markup, alter behaviour, or touch assertions — the e2e suite selects on roles and placeholder text and must keep passing untouched.

- [ ] **Step 6: Run and watch them pass**

Run: `pnpm vitest run src/web && pnpm e2e`
Expected: PASS, and the conformance test now reports no offenders.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/web
git commit -m "feat: add design tokens, light/dark, and a conformance gate"
```

---

### Task 3: Primitive components

**Files:**
- Create: `src/web/components/ui/{Button,IconButton,Panel,Badge,StatusDot,EmptyState,Spinner}.tsx`, `src/web/components/ui/index.ts`
- Test: `src/web/components/ui/ui.test.tsx`

**Interfaces:**
- Produces, all forwarding `className` and native props:
  - `Button({ variant?: "primary" | "secondary" | "danger" | "ghost", size?: "sm" | "md", loading?: boolean, ... })`
  - `IconButton({ label: string, ... })` — `label` becomes `aria-label`; required, not optional.
  - `Panel({ title?, actions?, children })`
  - `Badge({ tone?: "neutral" | "success" | "danger" | "warning" | "accent", children })`
  - `StatusDot({ state: "running" | "exited" | "restarting" | "unknown", label?: string })`
  - `EmptyState({ title, description?, action? })`
  - `Spinner({ size?: number })`

**Touch targets:** every interactive element is at least 44×44 CSS pixels at `size="md"`, and `size="sm"` stays at 36 px with adequate padding. This is the single most common way a desktop-built UI becomes unusable on a phone.

- [ ] **Step 1: Install the test tooling**

```bash
pnpm add -D @testing-library/react @testing-library/user-event jsdom
```

Add a `web` project to `vitest.config.ts` so DOM tests run under jsdom while server tests stay on node:

```typescript
test: {
  projects: [
    { test: { name: "server", environment: "node", include: ["src/server/**/*.test.ts", "src/shared/**/*.test.ts"] } },
    { test: { name: "web", environment: "jsdom", include: ["src/web/**/*.test.{ts,tsx}"], setupFiles: ["src/web/test-setup.ts"] } },
  ],
},
```

`src/web/test-setup.ts`:

```typescript
import "@testing-library/jest-dom/vitest";
```

Install `@testing-library/jest-dom` as well. If the `projects` key is unavailable in the installed Vitest, use `workspace` instead and note which you used in your report.

- [ ] **Step 2: Write the failing tests**

`src/web/components/ui/ui.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Badge, Button, EmptyState, IconButton, Panel, StatusDot } from "./index.js";

describe("Button", () => {
  it("calls onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Restart</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is disabled and non-interactive while loading", async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Pull</Button>);
    const btn = screen.getByRole("button", { name: /Pull/ });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("exposes busy state to assistive technology while loading", () => {
    render(<Button loading>Pull</Button>);
    expect(screen.getByRole("button", { name: /Pull/ })).toHaveAttribute("aria-busy", "true");
  });
});

describe("IconButton", () => {
  it("has an accessible name from its label", () => {
    render(<IconButton label="Collapse panel">×</IconButton>);
    expect(screen.getByRole("button", { name: "Collapse panel" })).toBeInTheDocument();
  });
});

describe("StatusDot", () => {
  it("communicates state as text, not colour alone", () => {
    render(<StatusDot state="exited" />);
    expect(screen.getByText("exited")).toBeInTheDocument();
  });
});

describe("Panel and Badge and EmptyState", () => {
  it("renders a panel title as a heading", () => {
    render(<Panel title="Services">body</Panel>);
    expect(screen.getByRole("heading", { name: "Services" })).toBeInTheDocument();
  });

  it("renders badge content", () => {
    render(<Badge tone="success">tunnel-only</Badge>);
    expect(screen.getByText("tunnel-only")).toBeInTheDocument();
  });

  it("renders an empty state with its action", () => {
    render(<EmptyState title="No projects" action={<Button>New</Button>} />);
    expect(screen.getByRole("heading", { name: "No projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm vitest run src/web/components`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 4: Implement the primitives**

Each is a small function component using only token utilities. `Button` for reference:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner.js";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:opacity-90",
  secondary: "bg-raised text-text border border-border hover:bg-surface",
  danger: "bg-danger text-accent-contrast hover:opacity-90",
  ghost: "text-text hover:bg-raised",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
  children: ReactNode;
}) {
  // 44px min target at md — below this, touch accuracy collapses.
  const sizing = size === "md" ? "min-h-11 px-4 text-sm" : "min-h-9 px-3 text-sm";
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${VARIANTS[variant]} ${sizing} ${className}`}
      {...rest}
    >
      {loading && <Spinner size={16} />}
      {children}
    </button>
  );
}
```

Build the remaining primitives in the same shape. `StatusDot` renders a coloured dot **and** the state as text — colour alone is not an accessible signal, and it is also unreadable on a sunlit phone.

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm vitest run src/web/components`
Expected: PASS (8 tests)

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/web vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat: add token-based primitive components"
```

---

### Task 4: Tabs and SegmentedControl

**Files:**
- Create: `src/web/components/ui/Tabs.tsx`, `src/web/components/ui/SegmentedControl.tsx`
- Modify: `src/web/components/ui/index.ts`
- Test: `src/web/components/ui/tabs.test.tsx`

**Interfaces:**
- `Tabs({ items: { id, label, href }[], activeId })` — renders router `NavLink`s with `role="tablist"`, since tab state lives in the URL.
- `SegmentedControl({ items: { id, label }[], value, onChange })` — local state, no routing.

**Keyboard behaviour is the whole point of building these rather than styling divs:** Left/Right (and Home/End) move between tabs, and the active tab is the only one in the tab order.

- [ ] **Step 1: Write the failing test**

`src/web/components/ui/tabs.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl, Tabs } from "./index.js";

const items = [
  { id: "overview", label: "Overview", href: "/projects/a/overview" },
  { id: "edit", label: "Edit", href: "/projects/a/edit" },
  { id: "logs", label: "Logs", href: "/projects/a/logs" },
];

function renderTabs(activeId = "overview") {
  return render(
    <MemoryRouter initialEntries={[`/projects/a/${activeId}`]}>
      <Tabs items={items} activeId={activeId} />
    </MemoryRouter>,
  );
}

describe("Tabs", () => {
  it("exposes a tablist with the active tab selected", () => {
    renderTabs();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "false");
  });

  it("keeps only the active tab in the tab order", () => {
    renderTabs();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus with arrow keys", async () => {
    renderTabs();
    screen.getByRole("tab", { name: "Overview" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveFocus();
  });

  it("wraps from the last tab to the first", async () => {
    renderTabs("logs");
    screen.getByRole("tab", { name: "Logs" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });
});

describe("SegmentedControl", () => {
  it("reports the chosen value", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        items={[{ id: "compose", label: "Compose" }, { id: "env", label: ".env" }]}
        value="compose"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: ".env" }));
    expect(onChange).toHaveBeenCalledWith("env");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/web/components/ui/tabs.test.tsx`
Expected: FAIL — components not exported.

- [ ] **Step 3: Implement**

`Tabs` renders a `div[role=tablist]` containing `NavLink`s with `role="tab"`, `aria-selected`, and `tabIndex` of `0` only for the active item. An `onKeyDown` on the tablist handles `ArrowLeft`/`ArrowRight` with wraparound plus `Home`/`End`, moving DOM focus to the target tab. `SegmentedControl` uses `role="radiogroup"` with `role="radio"` children and `aria-checked`.

Horizontal overflow at phone width scrolls rather than wrapping: `overflow-x-auto` with `scrollbar-width: none`, so three tabs never become two rows.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/web/components`
Expected: PASS (13 tests total)

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/web/components
git commit -m "feat: add accessible tabs and segmented control"
```

---

### Task 5: App shell, routing, sign-out and 404

**Files:**
- Create: `src/web/components/AppShell.tsx`, `src/web/components/ThemeToggle.tsx`, `src/web/routes/NotFound.tsx`
- Modify: `src/web/App.tsx`
- Test: `e2e/shell.spec.ts`

**Interfaces:**
- Consumes: `useSession`, `signOut` from `src/web/lib/auth-client.ts`; theme helpers from Task 2.
- Produces: `AppShell` wrapping all authenticated routes; the route table below.

```
/                     Dashboard placeholder
/projects             ProjectList          (Task 6)
/projects/:slug/*     ProjectDetail        (Task 7)
*                     NotFound
```

**Two Plan 1 gaps close here:** `signOut` has been exported and never called since Plan 1 — there is currently no way to log out of Homestead. And the initialised branch of `App.tsx` has no catch-all, so an unknown URL renders a blank page.

- [ ] **Step 1: Write the failing e2e test**

`e2e/shell.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";
import { signInAsAdmin } from "./support/auth.js";

test("nav moves between dashboard and projects", async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test("an unknown URL renders the 404 page, not a blank screen", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/nope/nowhere");
  await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
});

test("the theme toggle switches scheme and survives a reload", async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole("button", { name: /theme/i }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("sign out returns to the login screen and protects routes again", async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole("button", { name: /account/i }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
```

Extract the existing sign-in steps from `e2e/onboarding.spec.ts` into `e2e/support/auth.ts` as `signInAsAdmin(page)` and have both specs use it.

This is a permitted change to a Plan 1 file, but a narrow one: **move the steps, change nothing else.** No assertion may be relaxed, renamed, or reordered, and the spec must still cover first-run setup exactly as it does today. Twice in this project a task has quietly altered another plan's reviewed file; the review of this task will diff `onboarding.spec.ts` for anything beyond the extraction.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm e2e`
Expected: FAIL — no nav, no 404 page, no toggle, no sign-out.

- [ ] **Step 3: Implement the shell**

`AppShell` renders a sticky header — product name, `Dashboard | Projects` nav, `ThemeToggle`, and an account menu containing the signed-in email and **Sign out** — with `<Outlet />` beneath. Both menus close on Escape and on outside click, and their triggers use `aria-haspopup="menu"` / `aria-expanded`.

Sign-out calls `signOut()` then navigates to `/login`; Better-Auth clears the session cookie, so `ProtectedRoute` handles subsequent access.

At phone width the nav collapses to two icon-and-label links that stay visible — this nav has two destinations and does not warrant a hamburger.

Wire `AppShell` as a layout route around the authenticated routes in `App.tsx`, and add the catch-all.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm e2e`
Expected: PASS

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/web e2e
git commit -m "feat: add the app shell with navigation, theme toggle and sign-out"
```

---

### Task 6: API client, query hooks, and the project list

**Files:**
- Create: `src/web/lib/api.ts`, `src/web/lib/queries.ts`, `src/web/routes/ProjectList.tsx`
- Modify: `src/web/App.tsx`
- Test: `src/web/lib/api.test.ts`, `e2e/projects.spec.ts`

**Interfaces:**
- Produces:
  - `class ApiError extends Error { status: number; code?: string }`
  - `apiFetch<T>(path: string, init?: RequestInit): Promise<T | null>` — parses JSON, throws `ApiError`, and redirects to `/login` on 401. The return type includes `null` deliberately: a 204 or empty body has no JSON to parse, and typing that away as `T` would be a lie the compiler then helps you believe. Callers that know a body is guaranteed narrow it at the call site.
  - `queryKeys = { projects: ["projects"], project: (slug) => ["project", slug] }`
  - `useProjects()`, `useProject(slug)`

- [ ] **Step 1: Write the failing tests**

`src/web/lib/api.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./api.js";

const mockFetch = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  })));

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("returns parsed JSON on success", async () => {
    mockFetch(200, { projects: [] });
    expect(await apiFetch("/api/projects")).toEqual({ projects: [] });
  });

  it("throws ApiError carrying the status and server code", async () => {
    mockFetch(409, { error: "operation_in_progress" });
    await expect(apiFetch("/api/projects/a/up", { method: "POST" })).rejects.toMatchObject({
      status: 409,
      code: "operation_in_progress",
    });
  });

  it("throws ApiError for a 403 rather than resolving", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(ApiError);
  });

  it("tolerates an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await apiFetch("/api/whatever")).toBeNull();
  });
});
```

`e2e/projects.spec.ts` covers the list: a seeded project appears with its status, a directory without a compose file shows as "not a project", and the empty state appears when the projects directory is empty. Seed fixtures by writing directories under the e2e projects root before the page loads.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run src/web/lib && pnpm e2e`
Expected: FAIL on both.

- [ ] **Step 3: Implement**

`apiFetch` sends `credentials: "same-origin"`, sets `Content-Type` for bodies, and on a non-OK response reads `{ error }` into `ApiError.code`. On 401 it performs `window.location.assign("/login")` and throws — a global redirect rather than per-call handling.

`useProjects` polls at 15 s with `refetchOnWindowFocus`. `ProjectList` renders rows using the primitives: name, `StatusDot`, service count, port summary. Entries with `hasCompose === false` render muted with a "not a project" badge and no link. `EmptyState` explains `HOMESTEAD_PROJECTS`.

Rows are `min-h-11` and the whole row is the link target, not just the name — a 16 px text link is not a touch target.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run src/web && pnpm e2e`
Expected: PASS

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/web e2e
git commit -m "feat: add the API client, query hooks and the project list"
```

---

### Task 7: Project detail — header, lifecycle controls, Overview

**Files:**
- Create: `src/web/routes/ProjectDetail.tsx`, `src/web/routes/project/Overview.tsx`
- Modify: `src/web/App.tsx`, `src/web/lib/queries.ts`
- Test: `e2e/project-detail.spec.ts`

**Interfaces:**
- Consumes: `useProject(slug)`, primitives, `Tabs`.
- Produces:
  - `useLifecycle(slug)` — a mutation posting to `/api/projects/:slug/{verb}`, returning `{ operationId }` and surfacing 409 as "an operation is already running".
  - `ProjectDetail` holds `activeOperationId: string | null` in local state, set from that mutation's result and cleared on dismiss. **Task 8's `OperationPanel` receives it as a prop** — the id is not global state and not query cache, because it belongs to one project's page for the lifetime of that page. Task 7 renders the panel's placeholder slot; Task 8 fills it.

**Layout, and the rule behind it:** the header carries back, project name, `StatusDot`, and the four lifecycle buttons at every width. Overview is a collapsible left sidebar at `lg` and above, and the first of three tabs below that. Controls never live inside the collapsible region — content is either reference you glance at, which may be hidden, or an action you reach for, which may not. Restarting from a phone is the primary mobile job.

- [ ] **Step 1: Write the failing e2e test**

`e2e/project-detail.spec.ts` asserts: the header shows the project name and status; Overview lists services with image and state; a loopback-published port is badged `tunnel-only` and a `0.0.0.0` port `LAN`; named volumes appear; tabs navigate and the URL changes; a project whose compose file is malformed still renders with its `parseError` shown rather than a blank page or a crash.

That last case matters — `GET /api/projects/:slug` returns 200 with `model: null` and `parseError` set, and a UI that assumes `model` is present will throw on the exact projects a user most needs to look at.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm e2e`
Expected: FAIL — route not registered.

- [ ] **Step 3: Implement**

`ProjectDetail` reads `:slug`, renders the header and `Tabs`, and nests child routes for `overview`, `edit` and `logs`; `edit` renders a placeholder until Plan 4. Redirect a bare `/projects/:slug` to `/projects/:slug/overview`.

`Overview` renders four panels: **Services** (name, image, `StatusDot`, ports each badged from `loopbackOnly`), **Volumes** (from Task 1), **Snapshots**, **Recent operations** (from `GET /api/projects/:slug/operations`, showing kind, status, and duration).

When `parseError` is set, show it in a `danger`-toned panel above the others and render whatever the detail response still provides.

Lifecycle buttons disable while an operation is in flight for that project, so the 409 path is hard to reach by accident — but it is still handled, because another browser tab or user can start one.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm e2e`
Expected: PASS

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/web e2e
git commit -m "feat: add project detail with overview and lifecycle controls"
```

---

### Task 8: SSE hook and the operation panel

**Files:**
- Create: `src/web/lib/useEventStream.ts`, `src/web/components/OperationPanel.tsx`
- Modify: `src/web/routes/ProjectDetail.tsx`
- Test: `src/web/lib/useEventStream.test.ts`, `e2e/operations.spec.ts`

**Interfaces:**
- Produces:
  - `useEventStream<T>(url: string | null, opts?: { onEnd?: () => void }): { items: T[]; state: "idle" | "open" | "closed" | "error" }`
  - `OperationPanel({ operationId, onDismiss })`

**The reconnection subtlety this exists to handle:** `EventSource` reconnects on its own, and Plan 2's registry **replays its entire buffer** to every new subscriber. Appending on reconnect therefore duplicates the whole log. The hook clears its accumulated items on each `open` and treats the replay as the source of truth. On a phone changing networks this is not a rare path.

- [ ] **Step 1: Write the failing test**

`src/web/lib/useEventStream.test.ts` drives a fake `EventSource` installed on `globalThis`, and asserts:

```typescript
it("accumulates parsed events", /* dispatch two message events → items has both */);
it("clears accumulated items when the stream reopens", /* open, 2 events, open again, 1 event → items has exactly 1 */);
it("marks the stream errored without throwing", /* dispatch error → state === "error" */);
it("closes the EventSource on unmount", /* unmount → fake.close called */);
it("does nothing when the url is null", /* no EventSource constructed */);
```

The reopen test is the important one — it fails if the hook appends rather than resets.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run src/web/lib/useEventStream.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

The hook opens an `EventSource` when `url` is non-null, JSON-parses each `message`, and appends to state. On `open` it resets to `[]`. It closes on unmount and when `url` changes. A payload with `end: true` triggers `onEnd` and closes.

`OperationPanel` docks to the bottom above the tab bar, showing the verb, a spinner or exit code, and the output in a `font-mono` scroll region that auto-scrolls only when already at the bottom — yanking the view back down while someone is reading the failure is worse than not following. It is full-screen at phone width, collapses to a single status line on success, and stays expanded on failure. `onEnd` invalidates `['project', slug]` and `['projects']`.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run src/web && pnpm e2e`
Expected: PASS. The e2e spec starts an operation on a real project, waits for the panel to show a terminal state, and asserts the container state afterwards reflects it.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/web e2e
git commit -m "feat: add the SSE hook and the docked operation panel"
```

---

### Task 9: The Logs tab

**Files:**
- Create: `src/web/routes/project/Logs.tsx`
- Modify: `src/web/App.tsx`
- Test: `e2e/logs.spec.ts`

**Interfaces:**
- Consumes: `useEventStream`, the project model for the service list.
- Produces: the `/projects/:slug/logs` route.

- [ ] **Step 1: Write the failing e2e test**

Assert that the Logs tab streams output from a running project, that pausing stops new lines from appearing while resuming continues, that the service filter narrows output to one service, and that navigating away closes the stream.

That last assertion is the one with teeth: **`docker compose logs -f` runs until killed**, and the server only kills it on request close. A hook that leaks its `EventSource` leaks a `docker` process per visit on the user's server.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm e2e`
Expected: FAIL — route missing.

- [ ] **Step 3: Implement**

A toolbar with a service `<select>` (populated from `model.services`, plus "All"), a Follow/Pause toggle, and a tail-size selector. The stream URL is `/api/projects/:slug/logs?tail=N` plus `&service=` when a specific service is chosen — and note the carried-in caveat that the server currently rejects an *empty* `service` value, so "All" must omit the parameter entirely rather than send `service=`.

Pause detaches the stream rather than buffering invisibly; resuming reopens it, and the server's `--tail` gives back recent context. Say so in the UI, because a Pause that silently drops output while paused would be misleading.

Rendering uses a `font-mono` region with `overflow-anchor: none` and the same at-bottom auto-scroll rule as the operation panel.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm e2e`
Expected: PASS

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add src/web e2e
git commit -m "feat: add the container log viewer"
```

---

### Task 10: Enforce mobile parity in CI

**Files:**
- Modify: `playwright.config.ts`
- Test: `e2e/mobile.spec.ts`

**Interfaces:**
- Produces: two Playwright projects, `desktop` and `mobile`, running the same specs.

**Why this is a task and not a habit:** "works on mobile" decays silently. Someone builds a screen at 1440 px, never opens it at 390 px, and the regression surfaces weeks later on a phone. Running the existing specs at both viewports makes a broken narrow layout a CI failure.

- [ ] **Step 1: Add the viewport projects**

```typescript
import { defineConfig, devices } from "@playwright/test";
// ...
projects: [
  { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  { name: "mobile", use: { ...devices["Pixel 7"] } },
],
```

Keep the existing `webServer` block and the synchronous data-directory cleanup unchanged. Note the suite now runs twice — if the onboarding spec's admin-already-exists assumption breaks across projects, make its fixtures per-project rather than weakening the assertion.

- [ ] **Step 2: Write the mobile-specific test**

`e2e/mobile.spec.ts`, skipped on desktop:

```typescript
test.skip(({ isMobile }) => !isMobile, "mobile viewport only");
```

Assert: Overview appears as a third tab rather than a sidebar; the lifecycle controls are visible without opening any menu; no horizontal page scroll exists on the detail route (`document.documentElement.scrollWidth <= clientWidth`); and every control has a touch target of at least 44 px.

The horizontal-overflow check is worth more than it looks — a single unwrapped port list or long image name is the usual cause of a phone layout quietly breaking.

- [ ] **Step 3: Run both projects**

Run: `pnpm e2e`
Expected: every spec passes under `desktop` and `mobile`. Fix layout failures by making the layout responsive — **do not** hide content at narrow widths to make an assertion pass; full parity is the requirement.

- [ ] **Step 4: Verify and commit**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm e2e
git add playwright.config.ts e2e
git commit -m "test: run the e2e suite at desktop and mobile viewports"
```

---

## Definition of Done

- `pnpm typecheck`, `pnpm test`, `pnpm lint` clean; `pnpm e2e` green at **both** viewports.
- The design-system conformance test passes, and no component contains a palette utility or raw hex.
- Light and dark both render every screen; the choice survives a reload with no flash of the wrong scheme.
- Sign-out works and a signed-out user cannot reach `/projects`.
- An unknown URL renders the 404 page.
- A project with a malformed compose file still renders, showing its `parseError`.
- Starting an operation streams output; the panel shows the exit code; project state refreshes afterwards.
- Navigating away from Logs terminates the stream — verify no `docker compose logs` process survives.

## Handoff to Plan 4 (authoring)

- `apiFetch` / `ApiError`, `queryKeys`, `useProject`, `useProjects`.
- Primitives, `Tabs`, `SegmentedControl` — Plan 4 adds only `Dialog`.
- `useEventStream`, replay-safe.
- The `edit` child route exists as a placeholder, ready to be filled.
- `ProjectModel.volumes` for the delete dialog's orphan list.
- `isValidSlug` still lives in `src/server/projects/store.ts`; **Plan 4 moves it to `src/shared/projects.ts`** when the create form needs client-side validation, so one implementation serves both sides.
