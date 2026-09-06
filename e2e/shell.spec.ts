import { expect, type Locator, test } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE, signInAsAdmin } from "./support/auth.js";

const PHONE = { width: 390, height: 844 };
const TOUCH_MIN = 44;

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("expected the element to have a bounding box");
  return b;
}

test("nav moves between dashboard and projects", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test("an unknown URL renders the 404 page inside the app shell", async ({
  page,
}) => {
  await page.goto("/nope/nowhere");
  await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
  // Not a dead end: the shell's navigation is still there.
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
});

test("the theme toggle switches scheme and survives a reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /theme/i }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // The trigger reports the active scheme, and the menu marks it as checked.
  const trigger = page.getByRole("button", { name: /theme/i });
  await expect(trigger).toHaveAccessibleName(/dark/i);
  await trigger.click();
  await expect(page.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("the header fits a phone viewport with usable touch targets", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();

  // click() auto-scrolls, so only a layout measurement proves reachability.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE.width);

  const controls = [
    page.getByRole("link", { name: "Dashboard" }),
    page.getByRole("link", { name: "Projects" }),
    page.getByRole("button", { name: /theme/i }),
    page.getByRole("button", { name: /account/i }),
  ];
  for (const control of controls) {
    const b = await box(control);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
    expect(b.height).toBeGreaterThanOrEqual(TOUCH_MIN);
  }

  // The account menu is the only route to Sign out; its items must be tappable.
  await page.getByRole("button", { name: /account/i }).click();
  const signOut = await box(page.getByRole("menuitem", { name: "Sign out" }));
  expect(signOut.height).toBeGreaterThanOrEqual(TOUCH_MIN);
  expect(signOut.x + signOut.width).toBeLessThanOrEqual(PHONE.width);
});

test.describe("signed out", () => {
  // Sign-out is a server-side session delete. Consuming the shared storage
  // state here would revoke the session other spec files run against.
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test("an unknown URL redirects to the login screen", async ({ page }) => {
    await page.goto("/nope/nowhere");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("sign out returns to the login screen and protects routes again", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const account = page.getByRole("button", { name: /account/i });
    await expect(account).toBeVisible();
    await account.click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await page.goto("/projects");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
