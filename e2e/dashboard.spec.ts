import type { DashboardData } from "../src/shared/dashboard.js";
import { expect, test } from "./support/fixtures.js";
import {
  expectNoHorizontalScroll,
  expectTappable,
  PHONE,
  sweepTapTargets,
} from "./support/tap-targets.js";

test("the dashboard renders at desktop width", async ({ page }) => {
  const data: DashboardData = {
    apps: [
      {
        key: "jellyfin:web",
        source: "project",
        name: "Jellyfin",
        projectSlug: "jellyfin",
        service: "web",
        hostPort: 8096,
        hostname: "jellyfin.example.com",
        iconSlug: null,
        iconUrl: null,
        status: { state: "up", reason: null },
        tier: "verified",
      },
    ],
    devices: [],
    projectCount: 1,
  };

  await page.route("/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    }),
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Jellyfin")).toBeVisible();

  const sweep = await sweepTapTargets(page);
  expectTappable(sweep, "dashboard at desktop", 2);
  await expectNoHorizontalScroll(page, "dashboard at desktop");
});

test("the dashboard renders at phone width", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const data: DashboardData = {
    apps: [
      {
        key: "jellyfin:web",
        source: "project",
        name: "Jellyfin",
        projectSlug: "jellyfin",
        service: "web",
        hostPort: 8096,
        hostname: "jellyfin.example.com",
        iconSlug: null,
        iconUrl: null,
        status: { state: "up", reason: null },
        tier: "verified",
      },
    ],
    devices: [],
    projectCount: 1,
  };

  await page.route("/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    }),
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Jellyfin")).toBeVisible();

  const sweep = await sweepTapTargets(page);
  expectTappable(sweep, "dashboard at phone", 2);
  await expectNoHorizontalScroll(page, "dashboard at phone");
});

test("a project-backed app renders as a tile", async ({ page }) => {
  const data: DashboardData = {
    apps: [
      {
        key: "jellyfin:web",
        source: "project",
        name: "Jellyfin",
        projectSlug: "jellyfin",
        service: "web",
        hostPort: 8096,
        hostname: null,
        iconSlug: null,
        iconUrl: null,
        status: { state: "up", reason: null },
        tier: "verified",
      },
    ],
    devices: [],
    projectCount: 1,
  };

  await page.route("/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    }),
  );

  await page.goto("/");
  const tile = page.getByRole("article");
  await expect(tile).toBeVisible();
  await expect(tile.getByText("Jellyfin")).toBeVisible();
});

test("an app with no hostname renders as a non-link tile", async ({ page }) => {
  const data: DashboardData = {
    apps: [
      {
        key: "jellyfin:web",
        source: "project",
        name: "Jellyfin",
        projectSlug: "jellyfin",
        service: "web",
        hostPort: 8096,
        hostname: null,
        iconSlug: null,
        iconUrl: null,
        status: { state: "up", reason: null },
        tier: "verified",
      },
    ],
    devices: [],
    projectCount: 1,
  };

  await page.route("/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    }),
  );

  await page.goto("/");
  const tile = page.getByRole("article");
  await expect(tile).toBeVisible();
  await expect(tile.getByText("Jellyfin")).toBeVisible();
  // Should be an article, not a link
  await expect(page.getByRole("link", { name: /jellyfin/i })).not.toBeVisible();
});

test("an app with a hostname renders as a link to that hostname", async ({
  page,
}) => {
  const data: DashboardData = {
    apps: [
      {
        key: "jellyfin:web",
        source: "project",
        name: "Jellyfin",
        projectSlug: "jellyfin",
        service: "web",
        hostPort: 8096,
        hostname: "jellyfin.example.com",
        iconSlug: null,
        iconUrl: null,
        status: { state: "up", reason: null },
        tier: "verified",
      },
    ],
    devices: [],
    projectCount: 1,
  };

  await page.route("/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    }),
  );

  await page.goto("/");
  const link = page.locator('a[href="https://jellyfin.example.com"]');
  await expect(link).toBeVisible();
  await expect(link).toContainText("Jellyfin");
});

test("a non-green tile shows its tier text", async ({ page }) => {
  const data: DashboardData = {
    apps: [
      {
        key: "jellyfin:web",
        source: "project",
        name: "Jellyfin",
        projectSlug: "jellyfin",
        service: "web",
        hostPort: 8096,
        hostname: null,
        iconSlug: null,
        iconUrl: null,
        status: { state: "down", reason: null },
        tier: "degraded",
      },
    ],
    devices: [],
    projectCount: 1,
  };

  await page.route("/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    }),
  );

  await page.goto("/");
  const tile = page.getByRole("article");
  await expect(tile).toBeVisible();
  await expect(tile.getByText("Jellyfin")).toBeVisible();
  await expect(tile.getByText("degraded")).toBeVisible();
});

test("empty state: no projects at all", async ({ page }) => {
  const data: DashboardData = {
    apps: [],
    devices: [],
    projectCount: 0,
  };

  await page.route("/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    }),
  );

  await page.goto("/");
  await expect(page.getByText(/no projects yet/i)).toBeVisible();
  await expect(page.getByText(/create your first project/i)).toBeVisible();
});

test("empty state: projects exist but publish no ports", async ({ page }) => {
  const data: DashboardData = {
    apps: [],
    devices: [],
    projectCount: 3,
  };

  await page.route("/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    }),
  );

  await page.goto("/");
  await expect(page.getByText(/no apps yet/i)).toBeVisible();
  await expect(
    page.getByText(/none of your projects publishes a port/i),
  ).toBeVisible();
});
