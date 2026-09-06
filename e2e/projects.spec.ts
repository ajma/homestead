import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./support/fixtures.js";

/** Matches HOMESTEAD_PROJECTS in playwright.config.ts. */
const PROJECTS_ROOT = "/tmp/homestead-e2e/stacks";
const PHONE = { width: 390, height: 844 };
const TOUCH_MIN = 44;

/**
 * Every worker shares one projects root, so fixtures are uniquely named and
 * this spec asserts only on its own. Never assert on a global count and never
 * wipe the root: that would delete another worker's fixtures mid-run.
 */
const suffix = randomUUID().slice(0, 8);
const STACK = `e2e-stack-${suffix}`;
const BARE = `e2e-bare-${suffix}`;

test.beforeAll(async () => {
  await mkdir(join(PROJECTS_ROOT, STACK), { recursive: true });
  await writeFile(
    join(PROJECTS_ROOT, STACK, "compose.yaml"),
    "services:\n  web:\n    image: nginx:alpine\n",
  );
  await writeFile(join(PROJECTS_ROOT, STACK, ".env"), "TZ=UTC\n");
  // A plain directory: on a NAS the projects root also holds downloads,
  // backups and other things that are not stacks.
  await mkdir(join(PROJECTS_ROOT, BARE), { recursive: true });
});

test.afterAll(async () => {
  for (const dir of [STACK, BARE])
    await rm(join(PROJECTS_ROOT, dir), { recursive: true, force: true });
});

test("a seeded project is listed as a whole-row link", async ({ page }) => {
  await page.goto("/projects");

  const row = page.getByRole("link", { name: new RegExp(STACK) });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("href", `/projects/${STACK}`);
  // The status and the .env indicator are part of the link, not siblings.
  await expect(row).toContainText(/valid compose/i);
  await expect(row).toContainText(".env");
});

test("a directory without a compose file is shown but not linked", async ({
  page,
}) => {
  await page.goto("/projects");

  await expect(page.getByText(BARE, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(BARE) })).toHaveCount(
    0,
  );
  // The row explains itself rather than looking like a broken project.
  await expect(
    page.getByRole("listitem").filter({ hasText: BARE }),
  ).toContainText(/not a project/i);
});

test("rows stay tappable and inside a phone viewport", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/projects");

  const row = page.getByRole("link", { name: new RegExp(STACK) });
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  if (!box) throw new Error("expected the row to have a bounding box");
  expect(box.height).toBeGreaterThanOrEqual(TOUCH_MIN);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE.width);
});
