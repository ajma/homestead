import type { Locator } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE, signInAsAdmin } from "./support/auth.js";
import { expect, test } from "./support/fixtures.js";
import {
  expectDrawnBorder,
  expectNoHorizontalScroll,
  expectTappable,
  sweepTapTargets,
} from "./support/tap-targets.js";

const PHONE = { width: 390, height: 844 };
const TOUCH_MIN = 44;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: Locator): Promise<Box> {
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
  await expect(
    page.getByRole("menuitemradio", { name: "Dark" }),
  ).toHaveAttribute("aria-checked", "true");
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
    ["Dashboard", page.getByRole("link", { name: "Dashboard" })],
    ["Projects", page.getByRole("link", { name: "Projects" })],
    ["Theme", page.getByRole("button", { name: /theme/i })],
    ["Account", page.getByRole("button", { name: /account/i })],
  ] as const;

  const measured: { name: string; b: Box }[] = [];
  for (const [name, control] of controls) {
    const b = await box(control);
    expect(b.x, `${name} starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(
      b.x + b.width,
      `${name} ends inside the viewport`,
    ).toBeLessThanOrEqual(PHONE.width);
    expect(b.height, `${name} clears the touch minimum`).toBeGreaterThanOrEqual(
      TOUCH_MIN,
    );
    measured.push({ name, b });
  }

  // Containment alone cannot see controls stacked on top of each other: drop
  // the responsive collapse and every box still fits inside 390px while Theme
  // sits on top of Projects. Overlap is the invariant that actually breaks.
  const overlaps: string[] = [];
  for (let i = 0; i < measured.length; i++) {
    for (let j = i + 1; j < measured.length; j++) {
      const a = measured[i] as { name: string; b: Box };
      const z = measured[j] as { name: string; b: Box };
      if (
        a.b.x < z.b.x + z.b.width &&
        z.b.x < a.b.x + a.b.width &&
        a.b.y < z.b.y + z.b.height &&
        z.b.y < a.b.y + a.b.height
      )
        overlaps.push(`${a.name} overlaps ${z.name}`);
    }
  }
  expect(overlaps).toEqual([]);

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

  /**
   * The screen no sweep reached.
   *
   * `sweepTapTargets` and `expectNoHorizontalScroll` were called on `/`,
   * `/projects` and `/projects/:slug` only, so the two screens a first-run
   * user actually meets were the two the mobile-parity gate did not cover —
   * and they shipped with ~40px controls and, because `border-border` carries
   * a colour and no width, fields with no border at all in either theme.
   *
   * This runs under both viewport projects, so it holds at 1440 and at 390.
   */
  test("the sign-in screen is tappable, bordered and does not scroll sideways", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // Two fields and a submit button is the floor; a sweep that matched
    // nothing would otherwise pass.
    expectTappable(await sweepTapTargets(page), "the sign-in screen", 3);
    await expectNoHorizontalScroll(page, "the sign-in screen");

    // The conformance gate cannot see this: `border-border` resolves to a real
    // rule, it just draws nothing without a width, and preflight zeroes the
    // width. Only the browser can answer whether the field has an edge.
    await expectDrawnBorder(page.getByLabel("Email"), "the email field");
    await expectDrawnBorder(page.getByLabel("Password"), "the password field");
  });

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
