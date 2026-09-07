import { expect, test } from "./support/fixtures.js";
import {
  expectNoHorizontalScroll,
  expectTappable,
  PHONE,
  sweepTapTargets,
} from "./support/tap-targets.js";

const DEVICE_ID = "dev-test-1";

test("the devices list renders at desktop width", async ({ page }) => {
  await page.route("/api/devices", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        devices: [
          {
            id: DEVICE_ID,
            name: "Test iPhone",
            kind: "phone",
            hidden: false,
            tailscaleNodeId: "n123",
            connectedToControl: true,
            lastSeen: null,
            os: "iOS",
            status: { state: "up", reason: null },
          },
        ],
      }),
    }),
  );

  await page.goto("/devices");
  await expect(page.getByText("Test iPhone")).toBeVisible();

  const sweep = await sweepTapTargets(page);
  expectTappable(sweep, "devices list at desktop", 2);
  await expectNoHorizontalScroll(page, "devices list at desktop");
});

test("the devices list renders at phone width", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.route("/api/devices", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        devices: [
          {
            id: DEVICE_ID,
            name: "Test iPhone",
            kind: "phone",
            hidden: false,
            tailscaleNodeId: "n123",
            connectedToControl: true,
            lastSeen: null,
            os: "iOS",
            status: { state: "up", reason: null },
          },
        ],
      }),
    }),
  );

  await page.goto("/devices");
  await expect(page.getByText("Test iPhone")).toBeVisible();

  const sweep = await sweepTapTargets(page);
  expectTappable(sweep, "devices list at phone", 2);
  await expectNoHorizontalScroll(page, "devices list at phone");
});

test("the device detail renders at desktop width", async ({ page }) => {
  await page.route("/api/devices", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        devices: [
          {
            id: DEVICE_ID,
            name: "Test iPhone",
            kind: "phone",
            hidden: false,
            tailscaleNodeId: "n123",
            connectedToControl: true,
            lastSeen: null,
            os: "iOS",
            status: { state: "up", reason: null },
          },
        ],
      }),
    }),
  );

  await page.route(`/api/devices/${DEVICE_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        device: {
          id: DEVICE_ID,
          name: "Test iPhone",
          kind: "phone",
          hidden: false,
          tailscaleNodeId: "n123",
          connectedToControl: true,
          lastSeen: null,
          os: "iOS",
          status: { state: "up", reason: null },
        },
        monitors: [
          {
            id: "mon-1",
            type: "tailscale",
            required: true,
            enabled: true,
            state: "up",
            lastCheckedAt: Date.now() - 60000,
            error: null,
          },
        ],
        uptime: [
          { windowMs: 86_400_000, ratio: 0.99 },
          { windowMs: 604_800_000, ratio: 0.95 },
          { windowMs: 2_592_000_000, ratio: 0.9 },
        ],
        history: Array.from({ length: 48 }, (_, i) => ({
          startedAt: Date.now() - i * 1800000,
          ratio: Math.random() > 0.1 ? 1 : 0,
        })),
      }),
    }),
  );

  await page.goto(`/devices/${DEVICE_ID}`);
  await expect(page.getByText("Test iPhone")).toBeVisible();
  await expect(page.getByText("tailscale")).toBeVisible();

  const sweep = await sweepTapTargets(page);
  expectTappable(sweep, "device detail at desktop", 2);
  await expectNoHorizontalScroll(page, "device detail at desktop");
});

test("the device detail renders at phone width", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.route("/api/devices", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        devices: [
          {
            id: DEVICE_ID,
            name: "Test iPhone",
            kind: "phone",
            hidden: false,
            tailscaleNodeId: "n123",
            connectedToControl: true,
            lastSeen: null,
            os: "iOS",
            status: { state: "up", reason: null },
          },
        ],
      }),
    }),
  );

  await page.route(`/api/devices/${DEVICE_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        device: {
          id: DEVICE_ID,
          name: "Test iPhone",
          kind: "phone",
          hidden: false,
          tailscaleNodeId: "n123",
          connectedToControl: true,
          lastSeen: null,
          os: "iOS",
          status: { state: "up", reason: null },
        },
        monitors: [
          {
            id: "mon-1",
            type: "tailscale",
            required: true,
            enabled: true,
            state: "up",
            lastCheckedAt: Date.now() - 60000,
            error: null,
          },
        ],
        uptime: [
          { windowMs: 86_400_000, ratio: 0.99 },
          { windowMs: 604_800_000, ratio: 0.95 },
          { windowMs: 2_592_000_000, ratio: 0.9 },
        ],
        history: Array.from({ length: 48 }, (_, i) => ({
          startedAt: Date.now() - i * 1800000,
          ratio: Math.random() > 0.1 ? 1 : 0,
        })),
      }),
    }),
  );

  await page.goto(`/devices/${DEVICE_ID}`);
  await expect(page.getByText("Test iPhone")).toBeVisible();
  await expect(page.getByText("tailscale")).toBeVisible();

  const sweep = await sweepTapTargets(page);
  expectTappable(sweep, "device detail at phone", 2);
  await expectNoHorizontalScroll(page, "device detail at phone");
});
