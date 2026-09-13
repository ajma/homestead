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
