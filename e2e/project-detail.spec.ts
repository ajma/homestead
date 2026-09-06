import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./support/fixtures.js";
import {
  expectNoHorizontalScroll,
  expectTappable,
  PHONE,
  sweepTapTargets,
} from "./support/tap-targets.js";

/** Matches HOMESTEAD_PROJECTS in playwright.config.ts. */
const PROJECTS_ROOT = "/tmp/homestead-e2e/stacks";

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

  expectTappable(await sweepTapTargets(page), "the page at rest", MIN_CONTROLS);
  await expectNoHorizontalScroll(page, "the page at rest");

  // …with the operation panel open, which is where Dismiss lives.
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Operation", exact: true }),
  ).toBeVisible();
  expectTappable(
    await sweepTapTargets(page),
    "with an operation open",
    MIN_CONTROLS,
  );

  // …and with the remove confirmation open, which is the other pair.
  await page.getByRole("button", { name: "Stop & remove" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expectTappable(
    await sweepTapTargets(page),
    "with the confirmation open",
    MIN_CONTROLS,
  );
});
