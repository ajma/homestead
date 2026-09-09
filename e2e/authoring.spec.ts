import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.js";
import {
  expectDrawnBorder,
  expectNoHorizontalScroll,
  expectTappable,
  sweepTapTargets,
} from "./support/tap-targets.js";

/** Matches HOMESTEAD_PROJECTS in playwright.config.ts. */
const PROJECTS_ROOT = "/tmp/homestead-e2e/stacks";

/**
 * Every worker — and both viewport projects — share one projects root, one
 * database and one Docker daemon. So each fixture is uniquely named, only what
 * this file created is removed, nothing here asserts on a global count, and
 * the root itself is never wiped.
 *
 * Nothing in this spec starts a container. `POST /api/projects` runs
 * `docker compose config`, which only reads, and `DELETE` runs `down`, which
 * removes nothing that was never brought up. `docker ps -a` and
 * `docker volume ls` are unchanged either side of a full run.
 */
const suffix = randomUUID().slice(0, 8);
/** Created through the UI, so the create path is exercised end to end. */
const CREATED = `e2e-created-${suffix}`;
/** Seeded on disk rather than created through the UI. */
const SEEDED = `e2e-seeded-${suffix}`;
/** The editing fixture, with a hand-written `.env` that must survive a save. */
const EDITED = `e2e-edited-${suffix}`;

const ALL = [CREATED, SEEDED, EDITED];

/** A comment is what an editor is likeliest to eat, so it is what proves a save left the rest alone. */
const SEEDED_COMPOSE = [
  "# hand-written, keep me",
  "services:",
  "  web:",
  "    image: nginx:alpine",
  "",
].join("\n");

/**
 * A comment, a blank line and a second variable — the three things a
 * rebuild-from-entries editor silently eats. The spec's round-trip
 * requirement is asserted against these exact bytes on disk.
 */
const SEEDED_ENV = "# written by hand, keep me\n\nTZ=UTC\nPUID=1000\n";

async function seed(slug: string, compose: string, env?: string) {
  await mkdir(join(PROJECTS_ROOT, slug), { recursive: true });
  await writeFile(join(PROJECTS_ROOT, slug, "compose.yaml"), compose);
  if (env !== undefined)
    await writeFile(join(PROJECTS_ROOT, slug, ".env"), env);
}

test.beforeAll(async () => {
  await seed(SEEDED, SEEDED_COMPOSE);
  await seed(EDITED, SEEDED_COMPOSE, SEEDED_ENV);
});

test.afterAll(async () => {
  // Only this spec's own directories, including the one the UI was meant to
  // have deleted — a failed test must not leave a fixture behind.
  for (const slug of ALL)
    await rm(join(PROJECTS_ROOT, slug), { recursive: true, force: true });
});

const row = (page: Page, slug: string) =>
  page.getByRole("listitem").filter({ hasText: slug });

test("creates a blank project and lands in its editor", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("link", { name: "New project" }).first().click();
  await expect(page).toHaveURL(/\/projects\/new$/);

  // Rename is deferred, so the screen has to say so before the name is fixed.
  await expect(page.getByText(/cannot be changed later/i)).toBeVisible();

  await page.getByLabel("Name").fill(CREATED);
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${CREATED}/edit$`));
  await expect(
    page.getByRole("region", { name: "Edit project files" }),
  ).toBeVisible();

  await page.goto("/projects");
  await expect(
    page.getByRole("link", { name: new RegExp(CREATED) }),
  ).toBeVisible();
});

test("refuses an invalid name without creating anything", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel("Name").fill(".hidden");
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("alert")).toContainText(/letters, digits/i);
  // Still on the form: nothing was created and nothing navigated.
  await expect(page).toHaveURL(/\/projects\/new$/);
});

test("the create screen is tappable and bordered at this viewport", async ({
  page,
}) => {
  await page.goto("/projects/new");
  await expect(page.getByLabel("Name")).toBeVisible();

  // Name field, two source radios, Create and Cancel, plus the shell's own
  // controls. A floor, so a sweep that matched nothing fails loudly.
  expectTappable(await sweepTapTargets(page), "the create screen", 5);
  await expectNoHorizontalScroll(page, "the create screen");
  await expectDrawnBorder(page.getByLabel("Name"), "the Name field");
});

test("an edited compose file survives a reload", async ({ page }) => {
  await page.goto(`/projects/${EDITED}/edit`);
  const editor = page.getByRole("textbox").first();
  await expect(editor).toContainText("nginx:alpine");

  // Ctrl+End rather than a click position: CodeMirror puts the cursor where
  // the pointer landed, which is not a fixed place at two viewport widths.
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("# edited by the authoring spec");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox").first()).toContainText(
    "# edited by the authoring spec",
  );

  // And on disk, which is the only place that actually matters.
  const onDisk = await readFile(
    join(PROJECTS_ROOT, EDITED, "compose.yaml"),
    "utf8",
  );
  expect(onDisk).toContain("# edited by the authoring spec");
  // The rest of the file is untouched, comments included.
  expect(onDisk).toContain("# hand-written, keep me");
  expect(onDisk).toContain("image: nginx:alpine");
});

test("adding a variable leaves the hand-written .env intact", async ({
  page,
}) => {
  await page.goto(`/projects/${EDITED}/edit`);
  await page.getByRole("radio", { name: ".env" }).click();

  await expect(page.getByLabel("Value for TZ")).toHaveValue("UTC");
  await page.getByLabel("Key for the new variable").fill("PGID");
  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Value for PGID").fill("1001");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  const onDisk = await readFile(join(PROJECTS_ROOT, EDITED, ".env"), "utf8");
  // The whole round-trip requirement in one assertion: the comment, the blank
  // line and the untouched variables are byte-identical, and the new one is
  // appended rather than the file rebuilt.
  expect(onDisk).toBe(
    "# written by hand, keep me\n\nTZ=UTC\nPUID=1000\nPGID=1001\n",
  );
});

test("the edit tab is tappable and does not scroll sideways", async ({
  page,
}) => {
  await page.goto(`/projects/${EDITED}/edit`);
  await expect(
    page.getByRole("region", { name: "Edit project files" }),
  ).toBeVisible();

  // Two file radios, three editor toolbar buttons, the three page tabs.
  expectTappable(await sweepTapTargets(page), "the edit tab", 8);
  await expectNoHorizontalScroll(page, "the edit tab");
});

test("leaving with unsaved changes prompts, and cancelling stays put", async ({
  page,
}) => {
  await page.goto(`/projects/${EDITED}/edit`);
  await page.getByRole("radio", { name: ".env" }).click();

  const tz = page.getByLabel("Value for TZ");
  await expect(tz).toHaveValue("UTC");
  await tz.fill("Europe/Oslo");

  await page.getByRole("link", { name: "Back to projects" }).click();

  const dialog = page.getByRole("alertdialog", {
    name: /discard unsaved changes/i,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();

  // The assertion that matters is the URL, not the dialog: a guard that
  // rendered a prompt and let the navigation through would still show one.
  await expect(page).toHaveURL(new RegExp(`/projects/${EDITED}/edit$`));
  await expect(page.getByLabel("Value for TZ")).toHaveValue("Europe/Oslo");

  // And nothing reached the disk while the user was deciding.
  const onDisk = await readFile(join(PROJECTS_ROOT, EDITED, ".env"), "utf8");
  expect(onDisk).not.toContain("Europe/Oslo");
});

test("switching between Compose and .env prompts too", async ({ page }) => {
  await page.goto(`/projects/${EDITED}/edit`);
  await page.getByRole("radio", { name: ".env" }).click();
  await page.getByLabel("Value for TZ").fill("Europe/Oslo");

  // The router never sees this one, so it needs its own guard.
  await page.getByRole("radio", { name: "Compose" }).click();
  await expect(
    page.getByRole("alertdialog", { name: /discard unsaved changes/i }),
  ).toBeVisible();
});

test("deleting needs the slug typed, and takes the project off the list", async ({
  page,
}) => {
  await page.goto(`/projects/${CREATED}/overview`);
  await page.getByRole("button", { name: "Delete project…" }).click();

  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "Delete project" });
  await expect(confirm).toBeDisabled();

  // A near miss stays locked — this field exists to stop a mis-tap.
  await dialog.getByLabel(/to confirm/i).fill(CREATED.slice(0, -1));
  await expect(confirm).toBeDisabled();

  await dialog.getByLabel(/to confirm/i).fill(CREATED);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(
    page.getByRole("link", { name: new RegExp(CREATED) }),
  ).toHaveCount(0);
  // Scoped to this spec's own fixture: no global count, no wiped root.
  await expect(row(page, SEEDED)).toHaveCount(1);
});

test("a project deletes on one confirmation", async ({ page }) => {
  // Deletion used to ask twice for a directory Homestead had not created,
  // decided by the presence of an `x-homestead` block. Both are gone: typing
  // the exact slug is the whole gate, for every project.
  await page.goto(`/projects/${SEEDED}/overview`);
  await page.getByRole("button", { name: "Delete project…" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).not.toContainText(/homestead did not create/i);
  await expect(dialog.getByRole("button", { name: "Continue" })).toHaveCount(0);

  const confirm = dialog.getByRole("button", { name: "Delete project" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/to confirm/i).fill(SEEDED);
  await confirm.click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(row(page, SEEDED)).toHaveCount(0);
});
