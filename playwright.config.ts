import { mkdirSync, rmSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// D1: Clean and recreate e2e data directory synchronously before config export
// This ensures the directory is ready before Playwright starts any servers
// Use process.env guard to ensure it only happens once even if config is loaded multiple times
if (!process.env.E2E_CLEANUP_DONE) {
  rmSync("/tmp/homestead-e2e", { recursive: true, force: true });
  mkdirSync("/tmp/homestead-e2e/stacks", { recursive: true });
  mkdirSync("/tmp/homestead-e2e/.auth", { recursive: true });
  process.env.E2E_CLEANUP_DONE = "1";
}

/** Where `setup` writes the session every other project reuses. */
const STORAGE_STATE = "/tmp/homestead-e2e/.auth/admin.json";

/**
 * 390×844, not `devices["Pixel 7"]`.
 *
 * A Pixel 7 is 412px wide, which is *more* forgiving than the 390px the
 * tap-target and overflow sweeps in `shell`, `projects`, `logs`, `operations`
 * and `project-detail` already call `setViewportSize` with. Adopting it would
 * lower the bar this project exists to hold, and leave the CI viewport
 * disagreeing with the constant those specs hardcode. Anything that fits 390
 * fits 412.
 *
 * `isMobile` and `hasTouch` are set explicitly because they are what the app
 * is emulated as, not decoration: `isMobile` turns on Chromium's mobile
 * viewport emulation (so `<meta name="viewport">` is honoured), and it is also
 * the fixture `e2e/mobile.spec.ts` reads in its `test.skip`.
 */
const PHONE = { width: 390, height: 844 };

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:5173" },
  /**
   * `setup` runs once and is *not* duplicated per viewport.
   *
   * First-run onboarding is a one-shot against one SQLite database: the second
   * run of `auth.setup.ts` would find an initialised instance and fail. So the
   * two viewport projects are peers that both depend on the single `setup` and
   * both reuse its storage state — they are not two independent stacks.
   */
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "desktop",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: STORAGE_STATE,
      },
    },
    {
      name: "mobile",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: PHONE,
        isMobile: true,
        hasTouch: true,
        storageState: STORAGE_STATE,
      },
    },
  ],
  webServer: [
    {
      // D2: Use non-watch server script for e2e to avoid file-watcher restarts
      command: "pnpm dev:server:once",
      port: 7420,
      env: {
        HOMESTEAD_DATA: "/tmp/homestead-e2e",
        HOMESTEAD_PROJECTS: "/tmp/homestead-e2e/stacks",
        HOMESTEAD_TRUSTED_ORIGINS: "http://localhost:5173",
      },
      reuseExistingServer: false,
    },
    { command: "pnpm dev:web", port: 5173, reuseExistingServer: false },
  ],
});
