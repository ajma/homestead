import { expect, test } from "@playwright/test";

test("first run creates an admin, then signs in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Homestead" })).toBeVisible();

  await page.getByPlaceholder("Name").fill("Admin");
  await page.getByPlaceholder("Email").fill("admin@example.com");
  await page.getByPlaceholder("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByPlaceholder("Email").fill("admin@example.com");
  await page.getByPlaceholder("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("admin@example.com")).toBeVisible();
});

test("setup is closed once an admin exists", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
