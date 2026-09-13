# Homestead — Desktop Density Pass

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Homestead good to use on a laptop or a monitor, not merely survivable there.

**The actual problem, in the user's words:** *"I don't need it to make full usage of the 32" space. I might use it on a 14" laptop as well. The current layout is just bad on any desktop/laptop."*

That is the brief, and it is narrower and more useful than "use the big monitor". The app was built mobile-first and **never got a desktop pass**. Every screen is a single vertical stack with phone-sized padding and label-above-input forms. On any landscape screen that reads as sparse — and it reads that way at 1280px just as much as at 2560px. The `max-w-5xl` cap is a symptom, not the disease.

**So the target is 1280–1920px**, which is where a 14" laptop and a comfortably-windowed monitor both live. Wider than that should degrade gracefully rather than be the design centre.

**Survey:** `docs/superpowers/plans/desktop-density-survey.md`, which catalogues every screen. Read it before Task 1.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` §8. It already describes desktop affordances that were never built; the survey lists them.

## Global Constraints

- **Add no npm dependencies.** Do not run `pnpm add`, `pnpm install`, `pnpm install --force`. Tailwind v4 is already configured.
- **Mobile must not regress.** The app is used on a phone and that is a first-class case. Every change is additive at a breakpoint — `md:`, `lg:`, `2xl:` — with the base (phone) styles left alone unless the survey specifically calls one out as wrong everywhere.
- Baseline **1875 tests**.
- **The viewer's launcher must stay simple.** It is the screen a housemate sees; density there means more tiles visible, not more information per tile.
- **jsdom gives every element zero geometry**, so no test may assert a rendered width. Test layout the way `ConfigTab` does — by asserting the class strings that encode the decision.
- **TanStack's `notifyManager` defers re-renders through `setTimeout(0)` and RTL's `act()` can mask it.** If a binding check comes back green, suspect the harness and say so.
- Every gate: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm build` succeeding, Biome clean **by exit code**:
  ```bash
  pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"; tail -3 /tmp/biome.out
  ```
- `git status --porcelain --untracked-files=all` empty at the end of each task.
- **Report the initial chunk size** after each task — 442.97 kB, with `ConfigTab` a separate ~606 kB lazy chunk.

## Do not widen these — the survey checked, and narrow is right

The setup wizard (`max-w-lg`, a deliberate linear flow), `DialogShell` and `ConfirmDialog` (`sm:max-w-lg`), the `ExposureTab` form (`max-w-sm`), the `HealthPanel` popover (`sm:max-w-md`), and `ConfigTab`'s 768px stack point. Widening any of them makes the app worse.

## An honest limitation, to be stated in the report

**I cannot see the result.** No browser is reachable from this environment, so every judgement here is made from code. That has two consequences the implementer must respect:

1. **Make the density decisions in one place wherever the framework allows**, so the user can tune them after looking. A scattered set of hand-picked paddings is much harder to adjust than a small shared scale.
2. **Do not invent visual flourishes.** Change spacing, widths and the axis things lay out on. Do not change colours, borders, typography or component structure beyond what density requires.

---

### Task 1: A shared density scale, and the page shell

The single highest-leverage change, because every screen inherits it.

**Files:** `src/web/components/AppLayout.tsx`; a new shared module for the scale if one does not exist; `src/web/routes/Launcher.tsx`, `AdminApps.tsx`, `Settings.tsx`.

- [ ] **Step 1: Decide the scale and write it down**

Define, in **one** place, the handful of values every screen uses: page horizontal padding, the gap between major sections, card padding, and the page's maximum content width. Express them as responsive Tailwind class strings so a screen opts in with one token rather than five hand-picked classes.

The maximum width is **bounded but generous** — the user's choice. Around 1600–1920px, then centred. Content should grow well past today's 1024px but a table row should never span a whole 4K display, because the eye loses the line.

**Say in your report what values you chose.** That list is what the user will tune.

- [ ] **Step 2: Apply it to the three capped screens**

`Launcher.tsx:54`, `AdminApps.tsx:129` and `Settings.tsx:22` all carry `mx-auto max-w-5xl`. Replace with the shared token.

- [ ] **Step 3: Tighten the vertical rhythm**

This is the part that fixes a 14" laptop. Phone-sized `space-y` and padding between sections is what makes a landscape screen look empty. Reduce it **at `md:` and up**, leaving the phone values alone.

- [ ] **Step 4: Test the decisions, not the pixels**

jsdom has no geometry. Assert the class strings, as `ConfigTab.test.tsx` already does for its breakpoint. One test per decision that a future change would silently undo.

- [ ] **Step 5: Prove a binding.** Revert one screen to `max-w-5xl` → its test fails. Restore.

- [ ] **Step 6: Gates and commit**

---

### Task 2: The two screens that are looked at most

**Files:** `src/web/routes/Launcher.tsx` and `AppCard`; `src/web/routes/AdminApps.tsx`.

- [ ] **Step 1: The launcher grid**

It already declares `xl:grid-cols-5` (`Launcher.tsx:83`) which **never fires**, because the 1024px cap stops the container before the breakpoint matters. With Task 1's cap lifted it will. Add a `2xl:` step.

Density here means **more tiles visible**, not more text per tile. Do not add information to `AppCard`.

- [ ] **Step 2: The inventory table**

Today: App, Status, Directory, Last deploy, Actions. §8 requires two more that were never built — **exposure hostname** and **image-update count**. Add them, and make the row padding suit a data table rather than a touch target at `md:` and up.

Check whether the data is already on the admin DTO before adding a server field; `runningJobId` and `lastDeployAt` are already carried, so exposure may be too. **If a server change is needed, say so rather than smuggling it in.**

On a phone the table must remain usable — it is already responsive; keep whatever mechanism does that and add the new columns only at a breakpoint where they fit.

- [ ] **Step 3-5: Test the decisions, prove a binding, gates and commit**

---

### Task 3: Forms and the edit page

Where the sparseness is worst per the survey, and where the fix is partly the *opposite* of widening.

**Files:** `src/web/routes/edit/OverviewTab.tsx`, `EditApp.tsx`, `src/web/routes/Settings.tsx`, `UserManager.tsx`.

- [ ] **Step 1: Stop inputs stretching, and put labels beside them**

`OverviewTab.tsx:187-220` — the text inputs and textarea have **no max-width**, so on a wide screen a single-line "Display name" field runs nearly the full window. That is its own kind of bad. Cap the controls.

Then the vertical win: these are label-above-input at every size. At `lg:` and up, put the label beside the control. On a form with several fields that recovers a great deal of height, which is exactly what a 14" laptop is short of.

- [ ] **Step 2: Settings side by side**

`Settings.tsx:22` stacks Host check, Cloudflare and Users in one column via `space-y-8`. The first two are short fact-and-action panels. Put them in a `lg:grid-cols-2`; leave Users full width, since it is a table.

- [ ] **Step 3: Exposure in the right rail**

`EditApp.tsx:163` — the rail exists and carries actions, image updates and metadata. §8 names **four** things and exposure is the missing one. Add a compact exposure summary — hostname and state, linking to the tab. Not a second copy of the form.

- [ ] **Step 4-6: Test the decisions, prove a binding, gates and commit**

---

## Self-Review

**1. Scope.** Three tasks, ordered by leverage: the shared scale and the page shell, then the two most-viewed screens, then forms and the edit page. Each is independently reviewable and independently revertable, which matters for visual work nobody in this loop can see.

**2. What this deliberately does not do.** No colour, typography, border or component-structure changes. No new information on the launcher tile. No widening of the six surfaces the survey confirmed should stay narrow. Those constraints exist because an unreviewable visual change should be as small and as reversible as it can be while still fixing the complaint.

**3. Type consistency.** Task 2 may need `exposure` on the admin DTO if it is not already carried; that is a server change and the plan requires it be called out, not smuggled into a component. Nothing else here touches a type.

**4. The honest risk.** Every judgement in this plan is made from reading Tailwind classes, not from looking at the app. The values in Task 1 are a starting point chosen to be *consistent* rather than *correct*, because consistency is what makes them tunable. **The user will have to look at the result and say what is still wrong**, and the plan is shaped so that the answer is usually one number in one file.
