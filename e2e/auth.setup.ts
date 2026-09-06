import { expect, test as setup } from "./support/fixtures.js";
import {
  expectDrawnBorder,
  expectNoHorizontalScroll,
  expectTappable,
  PHONE,
  sweepTapTargets,
} from "./support/tap-targets.js";

const authFile = "/tmp/homestead-e2e/.auth/admin.json";

/**
 * The setup screen exists for exactly one page load in the life of an
 * instance, so this project is the only place it can be measured: once an
 * admin exists, `/setup` redirects to `/login` and neither viewport project
 * can reach the form. It was therefore the one screen no sweep covered.
 */
setup(
  "the setup screen is tappable and bordered at phone width",
  async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/setup");
    await expect(
      page.getByRole("heading", { name: "Welcome to Homestead" }),
    ).toBeVisible();

    // Three fields and a submit button; a floor, so a sweep that matched
    // nothing fails rather than passing quietly.
    expectTappable(await sweepTapTargets(page), "the setup screen", 4);
    await expectNoHorizontalScroll(page, "the setup screen");

    // `border-border` alone compiles to a colour with no width, and preflight
    // zeroes the width — the fields had no edge at all in either theme, on the
    // first screen anyone ever sees. The conformance gate cannot see this
    // because the class does resolve; the browser can.
    for (const field of ["Name", "Email", "Password"])
      await expectDrawnBorder(page.getByLabel(field), `the ${field} field`);
  },
);

setup(
  "perform first-run onboarding and save authenticated state",
  async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Welcome to Homestead" }),
    ).toBeVisible();

    await page.getByPlaceholder("Name").fill("Admin");
    await page.getByPlaceholder("Email").fill("admin@example.com");
    await page.getByPlaceholder("Password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByPlaceholder("Email").fill("admin@example.com");
    await page.getByPlaceholder("Password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByRole("heading", { name: "Dashboard" }),
    ).toBeVisible();
    await expect(page.getByText("admin@example.com")).toBeVisible();

    await page.context().storageState({ path: authFile });
  },
);

setup("verify setup is closed once admin exists", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
