/**
 * Homestead's shared desktop density scale.
 *
 * The app was built mobile-first and never got a desktop pass: every screen was a single
 * vertical stack capped at `max-w-5xl` (1024px) with phone-sized padding, which reads as
 * sparse on a 14" laptop just as much as on a 32" monitor. Rather than hand-picking
 * spacing per screen, every screen that wants "the desktop density pass" opts in to one
 * of the tokens below. Tuning the look later means changing a value here once, not
 * hunting through every route file that used a `max-w`.
 *
 * Every token is additive at a breakpoint (`md:`, `lg:`, `2xl:`) over an unchanged phone
 * base — none of these change anything below `md:`, so the phone layout is untouched by
 * a screen adopting one of these.
 *
 * These values are a starting point chosen for *consistency*, not for being verified
 * correct at any one viewport — no browser is reachable from the environment that wrote
 * them. They are meant to be tuned after a human looks at the real app.
 */

/**
 * Page content cap. Bounded but generous: grows well past the old 1024px `max-w-5xl`,
 * targeting the 1600–1920px band a 14"–32" desktop viewport actually benefits from,
 * without letting a table row span a 4K display edge to edge (the eye loses the line
 * past this width). An arbitrary-value class rather than a Tailwind named `max-w-*` step,
 * since no built-in step lands in that band.
 */
export const PAGE_MAX_WIDTH = "max-w-[1680px]";

/**
 * The page shell every capped route (`Launcher`, `AdminApps`, `Settings`) opts into:
 * centred, capped at `PAGE_MAX_WIDTH`, with page padding that grows slightly at `md:`
 * rather than staying at the phone's `p-4` forever.
 */
export const PAGE_SHELL = `mx-auto ${PAGE_MAX_WIDTH} p-4 md:px-6 md:py-5`;

/**
 * Vertical gap between major stacked sections on a page built from several of them (page
 * heading, panel groups, category blocks). The phone value is untouched; `md:` and up
 * tightens it, because the exact same gap that looks reasonable on a phone reads as dead
 * air once there's more width alongside it — phone-sized vertical rhythm is what makes a
 * landscape screen look empty, not full.
 */
export const SECTION_GAP = "space-y-6 md:space-y-4";

/**
 * Internal padding for a bordered content card/panel — the general-purpose "block of
 * related content in a border" used in panel and rail layouts. Explicitly not for
 * `AppCard`'s launcher tile, which the survey confirms is already correctly sized as a
 * compact tile at every viewport and is out of scope for this pass.
 */
export const CARD_PADDING = "p-4 md:p-5";

/**
 * Cap for a text input/textarea in a labeled form (e.g. `OverviewTab`'s Display
 * name/Description/Category fields). Unlike the other tokens above, this one is NOT
 * gated behind a breakpoint: a single-line field with no cap at all is wrong at every
 * viewport, not only a wide one — on a desktop it stretches to the full column width for
 * no reason, and capping it costs a phone nothing since the cap only ever binds once the
 * container is already wider than this.
 */
export const FORM_CONTROL_MAX_WIDTH = "max-w-lg";

/**
 * A labeled form row: label above control on the phone base (unchanged), label beside
 * control from `lg:` up. On a form with several fields, switching the axis at `lg:`
 * recovers most of the vertical space label-above-input wastes once there's room to lay
 * the two side by side instead — exactly what a 14" laptop is short of.
 */
export const FORM_ROW = "flex flex-col gap-1 text-sm lg:flex-row lg:items-start lg:gap-3";

/** Paired with `FORM_ROW`: gives the label a fixed column width once it sits beside the
 *  control, rather than stretching with the text. `lg:pt-2` lines its baseline up with
 *  the control's own `py-2` padding now that they sit side by side instead of stacked. */
export const FORM_LABEL =
  "font-medium text-slate-900 dark:text-slate-100 lg:w-32 lg:shrink-0 lg:pt-2";

/**
 * Two short, unrelated panels (a fact-and-action block, not a table) placed side by
 * side once there's room, stacked below it. For `Settings`' Host check/Cloudflare pair —
 * a table-shaped section (like `Settings`' own `UserManager`) should stay full width
 * rather than opt into this.
 */
export const TWO_UP_GRID = "grid grid-cols-1 gap-6 lg:grid-cols-2";
