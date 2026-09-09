import { test as base, expect } from "@playwright/test";

/**
 * A RegExp, not a glob.
 *
 * Playwright's URL globs understand `*`, `**`, `?` and `{a,b}` — they do
 * **not** understand shell extglob `@(a|b)`. This guard was first written as
 * `"**"+"/api/projects/*"+"/@(up|down|restart|pull)"`, which matched nothing,
 * and every test passed exactly as happily while a real `docker compose
 * restart` went to the daemon. A route pattern that matches nothing fails
 * open and silently, which is why `lifecycle-guard.spec.ts` asserts, from the
 * page's own context, that this actually fires.
 */
export const LIFECYCLE_ROUTE =
  /\/api\/projects\/[^/]+\/(up|stop|down|restart|pull)(\?|$)/;

/** The body the guard answers with, so a test can recognise its own guard. */
export const GUARD_MARKER = "e2e_lifecycle_guard";

/**
 * The Playwright `test` every spec in this suite must import.
 *
 * `POST /api/projects/:slug/:verb` runs `docker compose up -d` (or `stop`, or
 * `restart`, or `pull`) against the real daemon this suite shares with the
 * developer's machine. `down` is kept in the pattern although no route serves
 * it: a guard is cheap and a stale one that stops matching is not. Compose reconciles by project-name label, not by
 * directory, so a stray verb can adopt — or tear down — a stack that is not
 * ours. An earlier plan's suite left `media-web-1` running on a real machine
 * for exactly this reason.
 *
 * So no spec may reach that route. The guard is:
 *
 * - **automatic**, so a new spec file is covered without remembering anything;
 * - on the **context**, not the page, so a popup or a second page opened by a
 *   test is covered too — `page.route` would not be;
 * - **overridable per test** by a `page.route` for the same URL, because page
 *   routes take precedence over context routes. Tests that need a specific
 *   202 or 409 register their own handler and still never reach the server.
 *
 * It is deliberately not a server-side flag. A production code path whose job
 * is to refuse real work is a footgun in the environment this ships to: set by
 * accident it silently breaks the app, and misread it is a bypass. A test-only
 * guard belongs in the test layer.
 */
export const test = base.extend<{ lifecycleGuard: null }>({
  lifecycleGuard: [
    async ({ context }, use) => {
      await context.route(LIFECYCLE_ROUTE, (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: GUARD_MARKER }),
        }),
      );
      await use(null);
    },
    { auto: true },
  ],
});

export { expect };
