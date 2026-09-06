import { mkdirSync, rmSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// D1: Clean and recreate e2e data directory synchronously before config export
// This ensures the directory is ready before Playwright starts any servers
// Use process.env guard to ensure it only happens once even if config is loaded multiple times
if (!process.env.E2E_CLEANUP_DONE) {
  rmSync("/tmp/homestacks-e2e", { recursive: true, force: true });
  mkdirSync("/tmp/homestacks-e2e/stacks", { recursive: true });
  process.env.E2E_CLEANUP_DONE = "1";
}

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:5173" },
  webServer: [
    {
      // D2: Use non-watch server script for e2e to avoid file-watcher restarts
      command: "pnpm dev:server:once",
      port: 7420,
      env: {
        HOMESTACKS_DATA: "/tmp/homestacks-e2e",
        HOMESTACKS_PROJECTS: "/tmp/homestacks-e2e/stacks",
        HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173",
      },
      reuseExistingServer: false,
    },
    { command: "pnpm dev:web", port: 5173, reuseExistingServer: false },
  ],
});
