import { expect, test } from "@playwright/test";

test("nav moves between dashboard and projects", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test("an unknown URL renders the 404 page, not a blank screen", async ({ page }) => {
  await page.goto("/nope/nowhere");
  await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
});

test("the theme toggle switches scheme and survives a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /theme/i }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("sign out returns to the login screen and protects routes again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /account/i }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
