import type {
  ExposureSummary,
  TunnelRuntime,
} from "../src/shared/cloudflare.js";
import { expect, test } from "./support/fixtures.js";
import {
  expectNoHorizontalScroll,
  expectTappable,
  PHONE,
  sweepTapTargets,
} from "./support/tap-targets.js";

// Typed stub payloads to catch contract drift at compile time
const EXPOSURE_STUB: ExposureSummary = {
  id: "1",
  projectSlug: "traefik",
  serviceName: "web",
  hostPort: 8080,
  hostname: "traefik.example.com",
  scheme: "https",
  noTlsVerify: false,
  label: null,
  enabled: true,
  accessEnabled: true,
};

const RUNTIME_DEPLOYED: TunnelRuntime = {
  kind: "deployed",
  projectSlug: "cloudflared",
};

const RUNTIME_NONE: TunnelRuntime = {
  kind: "none",
};

type CloudflareStatusStub = {
  configured: boolean;
  accountId: string | null;
  tunnelId: string | null;
  runtime: TunnelRuntime;
  idpId: string | null;
  syncState: string;
};

const STATUS_CONFIGURED: CloudflareStatusStub = {
  configured: true,
  accountId: "acc123",
  tunnelId: "tun123",
  runtime: RUNTIME_DEPLOYED,
  idpId: "idp123",
  syncState: "synced",
};

const STATUS_UNCONFIGURED: CloudflareStatusStub = {
  configured: false,
  accountId: null,
  tunnelId: null,
  runtime: RUNTIME_NONE,
  idpId: null,
  syncState: "synced",
};

test.describe("Exposures", () => {
  test("renders the list when Cloudflare is configured", async ({ page }) => {
    await page.route("**/api/exposures", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exposures: [EXPOSURE_STUB] }),
      }),
    );

    await page.route("**/api/cloudflare/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STATUS_CONFIGURED),
      }),
    );

    await page.goto("/exposures");

    await expect(
      page.getByRole("heading", { name: "Exposures", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("traefik.example.com")).toBeVisible();
  });

  test("shows setup prompt when Cloudflare is not configured", async ({
    page,
  }) => {
    await page.route("**/api/exposures", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exposures: [] }),
      }),
    );

    await page.route("**/api/cloudflare/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STATUS_UNCONFIGURED),
      }),
    );

    await page.goto("/exposures");

    await expect(
      page.getByText("Cloudflare Tunnel is not configured yet"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /configure cloudflare/i }),
    ).toHaveAttribute("href", "/cloudflare/setup");
  });

  test("exposures list is tappable on mobile", async ({ page }) => {
    await page.setViewportSize(PHONE);

    await page.route("**/api/exposures", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exposures: [EXPOSURE_STUB] }),
      }),
    );

    await page.route("**/api/cloudflare/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STATUS_CONFIGURED),
      }),
    );

    await page.goto("/exposures");

    await expect(page.getByText("traefik.example.com")).toBeVisible();

    const sweep = await sweepTapTargets(page);
    expectTappable(sweep, "exposures list at 390px", 4);
  });

  test("exposures list has no horizontal scroll on mobile", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);

    await page.route("**/api/exposures", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exposures: [EXPOSURE_STUB] }),
      }),
    );

    await page.route("**/api/cloudflare/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STATUS_CONFIGURED),
      }),
    );

    await page.goto("/exposures");

    await expect(page.getByText("traefik.example.com")).toBeVisible();
    await expectNoHorizontalScroll(page, "exposures list at 390px");
  });
});

test.describe("Cloudflare Setup", () => {
  test("renders the wizard token step", async ({ page }) => {
    await page.route("**/api/cloudflare/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STATUS_UNCONFIGURED),
      }),
    );

    await page.goto("/cloudflare/setup");

    await expect(
      page.getByRole("heading", {
        name: /configure cloudflare tunnel/i,
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.getByPlaceholder(/api token/i)).toBeVisible();
  });

  test("wizard is tappable on mobile", async ({ page }) => {
    await page.setViewportSize(PHONE);

    await page.route("**/api/cloudflare/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STATUS_UNCONFIGURED),
      }),
    );

    await page.goto("/cloudflare/setup");

    await expect(page.getByPlaceholder(/api token/i)).toBeVisible();

    const sweep = await sweepTapTargets(page);
    expectTappable(sweep, "cloudflare setup at 390px", 2);
  });

  test("wizard has no horizontal scroll on mobile", async ({ page }) => {
    await page.setViewportSize(PHONE);

    await page.route("**/api/cloudflare/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STATUS_UNCONFIGURED),
      }),
    );

    await page.goto("/cloudflare/setup");

    await expect(page.getByPlaceholder(/api token/i)).toBeVisible();
    await expectNoHorizontalScroll(page, "cloudflare setup at 390px");
  });
});
