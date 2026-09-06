import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.js";

/** Matches HOMESTEAD_PROJECTS in playwright.config.ts. */
const PROJECTS_ROOT = "/tmp/homestead-e2e/stacks";
const PHONE = { width: 390, height: 844 };
const TOUCH_MIN = 44;

/**
 * Every worker shares one projects root, one database and one Docker daemon,
 * so the fixtures are uniquely named, only they are removed, and nothing here
 * asserts on a global count.
 */
const suffix = randomUUID().slice(0, 8);
const STACK = `e2e-detail-${suffix}`;
const BROKEN = `e2e-broken-${suffix}`;

const LIFECYCLE = ["Start", "Stop & remove", "Restart", "Pull"] as const;

test.beforeAll(async () => {
  await mkdir(join(PROJECTS_ROOT, STACK), { recursive: true });
  await writeFile(
    join(PROJECTS_ROOT, STACK, "compose.yaml"),
    [
      "services:",
      "  web:",
      "    image: nginx:alpine",
      "    ports:",
      // Loopback: reachable through the tunnel but not from the LAN (§7.4).
      '      - "127.0.0.1:18096:80"',
      '      - "0.0.0.0:18097:81"',
      "    volumes:",
      "      - data:/data",
      "volumes:",
      "  data: {}",
      "",
    ].join("\n"),
  );

  // A compose file `docker compose config` refuses: the server answers 200
  // with model: null and parseError set, and this is the project a user most
  // needs to be able to open.
  await mkdir(join(PROJECTS_ROOT, BROKEN), { recursive: true });
  await writeFile(
    join(PROJECTS_ROOT, BROKEN, "compose.yaml"),
    'services:\n  web:\n    image: nginx:alpine\n    ports: "not-a-list"\n',
  );
});

test.afterAll(async () => {
  for (const dir of [STACK, BROKEN])
    await rm(join(PROJECTS_ROOT, dir), { recursive: true, force: true });
});

test("the header names the project and shows its status", async ({ page }) => {
  await page.goto(`/projects/${STACK}`);

  await expect(
    page.getByRole("heading", { name: STACK, level: 1 }),
  ).toBeVisible();
  // Nothing was ever brought up, and the page says so rather than guessing.
  await expect(page.getByText("No containers")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /back to projects/i }),
  ).toHaveAttribute("href", "/projects");
});

test("a bare project URL redirects to the overview", async ({ page }) => {
  await page.goto(`/projects/${STACK}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${STACK}/overview$`));
});

test("the overview lists each service with its image and state", async ({
  page,
}) => {
  await page.goto(`/projects/${STACK}/overview`);

  const services = page.getByRole("region", { name: "Services" });
  await expect(services.getByText("web", { exact: true })).toBeVisible();
  await expect(services.getByText("nginx:alpine")).toBeVisible();
  await expect(services.getByText("No container")).toBeVisible();
});

test("a loopback port is badged tunnel-only and a wildcard port LAN", async ({
  page,
}) => {
  await page.goto(`/projects/${STACK}/overview`);

  // `li li` is the port row rather than the service row that contains both.
  const ports = page.getByRole("region", { name: "Services" }).locator("li li");
  await expect(ports.filter({ hasText: "18096" })).toContainText("tunnel-only");
  await expect(ports.filter({ hasText: "18097" })).toContainText("LAN");
});

test("named volumes appear in the overview", async ({ page }) => {
  await page.goto(`/projects/${STACK}/overview`);

  const volumes = page.getByRole("region", { name: "Volumes" });
  await expect(volumes.getByText(`${STACK}_data`)).toBeVisible();
});

test("the tabs navigate and the URL follows", async ({ page }) => {
  await page.goto(`/projects/${STACK}/overview`);

  await page.getByRole("tab", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${STACK}/edit$`));
  await expect(page.getByText(/not available yet/i)).toBeVisible();

  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${STACK}/overview$`));
  await expect(page.getByRole("region", { name: "Services" })).toBeVisible();
});

test("a malformed compose file still renders, with its parse error", async ({
  page,
}) => {
  await page.goto(`/projects/${BROKEN}/overview`);

  // Not a blank page and not a crash: the header, the controls and the parse
  // error are all there.
  await expect(
    page.getByRole("heading", { name: BROKEN, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/must be a/i)).toBeVisible();
  for (const name of LIFECYCLE)
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Snapshots" })).toBeVisible();
});

test("starting a stack opens the operation slot and dismissing closes it", async ({
  page,
}) => {
  // Answered in the browser. A page route beats the shared context-level
  // guard in e2e/support/fixtures.ts, so this handler wins and the server is
  // still never reached.
  let posted = 0;
  await page.route(`**/api/projects/${STACK}/restart`, (route) => {
    posted++;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ operationId: "e2e-op-1" }),
    });
  });

  await page.goto(`/projects/${STACK}/overview`);
  await page.getByRole("button", { name: "Restart", exact: true }).click();

  const panel = page.getByRole("region", { name: "Operation", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-operation-id", "e2e-op-1");
  expect(posted).toBe(1);

  await panel.getByRole("button", { name: /dismiss/i }).click();
  await expect(panel).toBeHidden();
});

test("removing containers asks first, and cancelling posts nothing", async ({
  page,
}) => {
  let posted = 0;
  await page.route(`**/api/projects/${STACK}/down`, (route) => {
    posted++;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ operationId: "e2e-op-down" }),
    });
  });

  await page.goto(`/projects/${STACK}/overview`);
  // The label says what `docker compose down` does, so the tap is informed.
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Stop & remove" }).click();

  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(/deletes its containers and networks/i);
  expect(posted, "nothing is posted before confirming").toBe(0);

  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(posted, "cancelling posts nothing").toBe(0);

  await page.getByRole("button", { name: "Stop & remove" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /yes, stop and remove/i })
    .click();
  await expect(
    page.getByRole("region", { name: "Operation", exact: true }),
  ).toBeVisible();
  expect(posted).toBe(1);
});

test("a 409 from another tab is reported, not swallowed", async ({ page }) => {
  await page.route(`**/api/projects/${STACK}/up`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "operation_in_progress",
        detail: "an operation is already running",
      }),
    }),
  );

  await page.goto(`/projects/${STACK}/overview`);
  await page.getByRole("button", { name: "Start", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText(/already running/i);
});

/**
 * How many controls the page must have for the sweep to mean anything.
 *
 * Back, four lifecycle buttons and three tabs is eight before anything else,
 * so this is a floor, not a count — asserting an exact number would break on
 * every legitimate addition.
 */
const MIN_CONTROLS = 8;

/**
 * A thumb needs 44px in both directions: a control 44px tall and 8px wide is
 * as hard to hit as one 8px tall.
 */
type Sweep = { offenders: string[]; measured: number };

/**
 * Every visible control, not a hand-written list.
 *
 * The previous version measured only the four lifecycle buttons, and so said
 * nothing about the operation panel's Dismiss — which shipped at 36px and
 * renders at 390px. A sweep cannot forget a control that was added later.
 *
 * It reports how many it measured, because a selector that quietly stops
 * matching turns the whole mobile safety net into a green no-op. An empty
 * sweep must fail loudly, not pass.
 */
async function sweepTapTargets(page: Page): Promise<Sweep> {
  const controls = page.locator(
    'button:visible, a[href]:visible, input:visible, [role="button"]:visible, [role="tab"]:visible',
  );
  const measured = await controls.count();
  const offenders: string[] = [];
  for (let i = 0; i < measured; i++) {
    const control = controls.nth(i);
    const name = (
      await control.evaluate(
        (el) =>
          el.getAttribute("aria-label") ??
          (el as HTMLInputElement).value ??
          el.textContent ??
          "",
      )
    )
      .trim()
      .slice(0, 40);
    const box = await control.boundingBox();
    if (!box) {
      offenders.push(`${name}: no bounding box`);
      continue;
    }
    if (box.height < TOUCH_MIN)
      offenders.push(`${name}: ${Math.round(box.height)}px tall`);
    if (box.width < TOUCH_MIN)
      offenders.push(`${name}: ${Math.round(box.width)}px wide`);
    if (box.x < 0 || box.x + box.width > PHONE.width)
      offenders.push(`${name}: outside the viewport`);
  }
  return { offenders, measured };
}

/** Fails on an offender *and* on a sweep that found nothing to measure. */
function expectTappable(sweep: Sweep, when: string): void {
  expect(sweep.offenders, `${when}: undersized or off-screen`).toEqual([]);
  expect(
    sweep.measured,
    `${when}: the sweep matched ${sweep.measured} controls, so it proved nothing`,
  ).toBeGreaterThanOrEqual(MIN_CONTROLS);
}

test("every control on the page is tappable at phone width", async ({
  page,
}) => {
  await page.route(`**/api/projects/${STACK}/restart`, (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ operationId: "e2e-op-tap" }),
    }),
  );
  await page.setViewportSize(PHONE);
  await page.goto(`/projects/${STACK}/overview`);
  await expect(
    page.getByRole("heading", { name: STACK, level: 1 }),
  ).toBeVisible();

  // The four lifecycle controls are present at phone width, by name.
  for (const name of LIFECYCLE)
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();

  expectTappable(await sweepTapTargets(page), "the page at rest");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE.width);

  // …with the operation panel open, which is where Dismiss lives.
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Operation", exact: true }),
  ).toBeVisible();
  expectTappable(await sweepTapTargets(page), "with an operation open");

  // …and with the remove confirmation open, which is the other pair.
  await page.getByRole("button", { name: "Stop & remove" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expectTappable(await sweepTapTargets(page), "with the confirmation open");
});
