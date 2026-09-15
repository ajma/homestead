import { UserManager } from "@web/components/UserManager";
import { PAGE_SHELL, SECTION_GAP } from "@web/lib/density";
import { CloudflarePanel } from "@web/routes/settings/CloudflarePanel";
import { HostCheckPanel } from "@web/routes/setup/HostCheckPanel";

/**
 * The three sections this page has, in the order both the nav and the content column
 * render them. Single source of truth for both: a `SETTINGS_SECTIONS.map` builds the nav
 * links, and every `id` here must exist on a `<section>` below — the test file checks the
 * correspondence in both directions, since a link to a missing anchor (or a section with
 * no link) is the failure mode a hand-maintained pair of lists invites.
 */
const SETTINGS_SECTIONS = [
  { id: "host-check", label: "Host check" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "users", label: "Users" },
] as const;

/**
 * `/settings`, a `Placeholder` for six phases while the users CRUD API (Phase 1A) sat
 * unreachable from any browser. `App.tsx`'s own route guard already keeps this whole
 * subtree admin-only — a viewer is redirected to `/` before this ever mounts — so
 * nothing here re-checks role.
 *
 * The host check reuses `HostCheckPanel` verbatim from `StepVerifyHost` (setup step 2)
 * — same query, same Re-check behaviour, no footer since there is no wizard step to
 * complete here. Setup's own `completedAt` is one-way and `finish` has no gate on which
 * steps ran, so an admin who continued past a failing mount preflight during setup, then
 * fixed it, had no way to confirm the fix short of a hand-crafted API call. Spec §9's
 * "can be completed later from settings" promise covers this the same way it covers
 * Cloudflare — `CloudflarePanel` below is that promise kept for the credentials half of
 * it (Phase 2A Task 3); everything else §6 promises is a later sub-phase's job.
 *
 * Phase 1C (settings-nav): three sections stacked in one long page, on one screen, was
 * fine when there were only three — it stops being fine at scroll-past-a-screenful, so
 * this adds a left nav of real anchors (`<a href="#host-check">`) rather than splitting
 * into sub-routes. Staying one page keeps `/settings/*` a single unconditional route in
 * `App.tsx` (no new path for the viewer guard to have to cover) and keeps
 * `CloudflarePanel`'s in-flight job state, `UserManager`'s row state, etc. mounted
 * continuously rather than remounted on navigation.
 *
 * Host check and Cloudflare used to sit side by side in `TWO_UP_GRID` — reasonable when
 * the content column was the full page width, but the nav column here takes some of that
 * width back, and two short panels squeezed into what's left read as cramped rather than
 * efficient. Both now stack full width in the content column, same as `Users` already
 * did.
 */
export function Settings() {
  return (
    <div className={`${PAGE_SHELL} ${SECTION_GAP}`}>
      <h1 className="text-lg font-semibold">Settings</h1>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/*
         * A real `<nav>` of real `<a href="#...">` anchors, not a `<div onClick>` list —
         * native anchors are keyboard-operable, middle-clickable, and back/forward-able
         * for free. `sticky top-4` keeps it visible as the content column scrolls past
         * it; unconditional (not `lg:sticky`) because it costs nothing while the nav is
         * stacked above the content on a phone either. `bg-white`/`dark:bg-slate-950`
         * matches `body`'s own background (`index.css`) so stuck content doesn't show
         * through the pills as the page scrolls under them.
         */}
        <nav
          aria-label="Settings sections"
          className="sticky top-4 z-10 bg-white py-1 dark:bg-slate-950 lg:w-48 lg:shrink-0"
        >
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:flex-nowrap lg:gap-1">
            {SETTINGS_SECTIONS.map((section) => (
              <li key={section.id}>
                {/*
                 * No `preventDefault` — the click still updates the URL hash and lands
                 * in browser history, exactly what a real anchor is for. The explicit
                 * `.focus()` here is what actually moves keyboard focus to the section
                 * (paired with `tabIndex={-1}` on each `<section>` below): a sighted
                 * mouse user's viewport following the jump is not the same as a keyboard
                 * user's focus following it, and without this a keyboard user would
                 * arrow past nav items whose section long since scrolled off screen.
                 */}
                <a
                  href={`#${section.id}`}
                  onClick={() => document.getElementById(section.id)?.focus()}
                  className="block rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={`min-w-0 flex-1 ${SECTION_GAP}`}>
          <section id="host-check" tabIndex={-1}>
            <h2 className="mb-2 text-base font-semibold">Host check</h2>
            <p className="mb-4 text-sm text-slate-500">
              Re-run the Docker and mount checks from setup — useful after fixing a bind mount setup
              warned about.
            </p>
            <HostCheckPanel />
          </section>
          <section id="cloudflare" tabIndex={-1}>
            <h2 className="mb-2 text-base font-semibold">Cloudflare</h2>
            <p className="mb-4 text-sm text-slate-500">
              Store the Cloudflare account and API token used to expose apps through a tunnel. The
              token is never shown again once saved — only its last four characters.
            </p>
            <CloudflarePanel />
          </section>
          <section id="users" tabIndex={-1}>
            <UserManager />
          </section>
        </div>
      </div>
    </div>
  );
}
