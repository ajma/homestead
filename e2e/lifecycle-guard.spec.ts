import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, GUARD_MARKER, test } from "./support/fixtures.js";

/**
 * The guard's only evidence used to be "the tests passed" — and they passed
 * exactly as happily while it matched nothing and let a real
 * `docker compose restart` through. This asserts, positively, that it fires.
 *
 * The probe slug is deliberately not on disk: `POST /api/projects/:slug/:verb`
 * checks the project exists and answers 404 *before* it reaches
 * `docker compose`, so if the guard ever regresses these tests fail on the 404
 * rather than starting anything.
 *
 * Every request is issued from the page's own context, which is what the route
 * interception actually sees, and in every URL shape the app can emit.
 */
type Probe = { url: string; status: number; body: string };

async function probeEveryVerb(page: Page): Promise<Probe[]> {
  const slug = `e2e-guard-probe-${randomUUID().slice(0, 8)}`;
  return page.evaluate(async (s: string) => {
    const urls = [
      `/api/projects/${s}/up`,
      `/api/projects/${s}/down`,
      `/api/projects/${s}/restart`,
      `/api/projects/${s}/pull`,
      // The same request, spelled the other ways a caller might spell it.
      `${window.location.origin}/api/projects/${s}/up`,
      `/api/projects/${s}/pull?force=1`,
    ];
    const out: { url: string; status: number; body: string }[] = [];
    for (const url of urls) {
      const res = await fetch(url, { method: "POST" });
      out.push({ url, status: res.status, body: await res.text() });
    }
    return out;
  }, slug);
}

function expectGuarded(results: Probe[]): void {
  expect(results).toHaveLength(6);
  for (const { url, status, body } of results) {
    expect(status, `${url} was answered by the guard`).toBe(503);
    expect(body, `${url} carries the guard's marker`).toContain(GUARD_MARKER);
  }
}

test("the lifecycle guard answers every verb, not the server", async ({
  page,
}) => {
  await page.goto("/");
  expectGuarded(await probeEveryVerb(page));
});

test("the guard covers a page the test never opened itself", async ({
  context,
}) => {
  // The guard is registered on the context precisely so this holds: a
  // `page.route` would leave a popup, or any second page, going straight to
  // the daemon.
  const second = await context.newPage();
  await second.goto("/");
  expectGuarded(await probeEveryVerb(second));
  await second.close();
});
