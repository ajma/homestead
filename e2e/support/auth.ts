import { expect, type Page } from "@playwright/test";

/**
 * Shared e2e auth helpers.
 *
 * The `setup` project (`e2e/auth.setup.ts`) performs first-run onboarding once
 * and saves the admin's storage state, which every authenticated project
 * reuses. These credentials mirror the ones it creates.
 */
export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "correct-horse-battery";

/** Where the setup project writes the shared authenticated storage state. */
export const ADMIN_STORAGE_STATE = "/tmp/homestead-e2e/.auth/admin.json";

/** A context that starts signed out, for specs that mint their own session. */
export const SIGNED_OUT_STORAGE_STATE = { cookies: [], origins: [] };

/**
 * Sign in as the admin, minting a **fresh** session.
 *
 * Better-Auth's sign-out deletes the session row for the presented token, so
 * any spec that signs out must own the session it destroys rather than
 * consuming the shared storage state — otherwise it revokes the session other
 * workers are using concurrently. Pair this with
 * `test.use({ storageState: SIGNED_OUT_STORAGE_STATE })` inside a describe
 * block.
 */
export async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(ADMIN_EMAIL);
  await page.getByPlaceholder("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}
