import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./support/fixtures.js";
import {
  expectNoHorizontalScroll,
  expectTappable,
  PHONE,
  sweepTapTargets,
  TOUCH_MIN,
} from "./support/tap-targets.js";

/** Matches HOMESTEAD_PROJECTS in playwright.config.ts. */
const PROJECTS_ROOT = "/tmp/homestead-e2e/stacks";

/**
 * Every worker shares one projects root, one database and one Docker daemon,
 * so the fixture is uniquely named, only it is removed, and nothing here
 * asserts on a global count.
 */
const suffix = randomUUID().slice(0, 8);
const BUSY = `e2e-mobile-${suffix}`;

const LIFECYCLE = ["Start", "Stop", "Restart", "Pull"] as const;

/**
 * The widths each viewport project must actually be emulating.
 *
 * This is the tripwire for the whole file. Everything below is gated on
 * `isMobile`, and a gate that is false everywhere is indistinguishable from a
 * passing suite: flip `isMobile` off in `playwright.config.ts` and every
 * assertion in this spec silently stops running while `pnpm e2e` stays green.
 * So this one test is deliberately *not* skipped — it runs under both
 * projects, and it fails if the project it is running under is not configured
 * the way the rest of this file assumes.
 */
const VIEWPORTS: Record<string, { width: number; mobile: boolean }> = {
  desktop: { width: 1440, mobile: false },
  mobile: { width: PHONE.width, mobile: true },
};

test("each viewport project emulates the device its name claims", async ({
  page,
  isMobile,
}, testInfo) => {
  const expected = VIEWPORTS[testInfo.project.name];
  expect(
    expected,
    `${testInfo.project.name} is not a known viewport project — add it to VIEWPORTS, or the mobile assertions below may never run`,
  ).toBeDefined();
  if (!expected) return;

  expect(page.viewportSize()?.width, "the configured viewport width").toBe(
    expected.width,
  );
  // The `isMobile` fixture is what `test.skip` below reads, so it is the thing
  // that decides whether this file tests anything at all.
  expect(isMobile, "the isMobile fixture").toBe(expected.mobile);

  // …and that the browser is really emulating it, not merely that a config key
  // was set. `use.isMobile` without `hasTouch` would leave a phone-shaped
  // window with a mouse behind it.
  await page.goto("/");
  const emulated = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    touch: navigator.maxTouchPoints > 0,
  }));
  expect(emulated.innerWidth, "the browser's own viewport width").toBe(
    expected.width,
  );
  expect(emulated.touch, "the browser reports a touchscreen").toBe(
    expected.mobile,
  );
});

test.describe("at phone width", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile viewport only");

  /**
   * The service name, as it appears in the fixture and on screen.
   *
   * Underscores, not hyphens. A hyphen is a line-break opportunity under
   * UAX #14, so `reverse-proxy-and-certificate-renewal-sidecar` wraps happily
   * inside 390px and proves nothing — the first draft of this fixture was
   * written that way, and the overflow assertion below stayed green even with
   * the layout's `truncate` deleted. Only a run with no break opportunity in
   * it exercises the thing the check exists for.
   */
  const SERVICE = "media_library_transcoder_and_metadata_indexer";

  /** 64 hex characters, unbreakable, and how a pinned deployment really reads. */
  const DIGEST = `sha256:${"9b1c2f4e".repeat(8)}`;

  /** Compose prefixes the project name, so the rendered name is longer still. */
  const VOLUME = "application_state_for_the_media_library_and_its_thumbnails";

  /**
   * Deliberately hostile fixture data.
   *
   * A horizontal-overflow check that only ever sees `nginx:alpine` and one
   * port proves nothing: short strings fit anything. What actually breaks a
   * phone layout is a token the browser cannot wrap — a digest-pinned image
   * reference, an underscored service or volume name — or a service that
   * publishes a long list of ports. This project has all four.
   */
  test.beforeAll(async () => {
    const ports = Array.from(
      { length: 9 },
      (_, i) =>
        `      - "127.0.0.1:${18200 + i}:${8000 + i}"\n` +
        `      - "0.0.0.0:${18300 + i}:${9000 + i}/udp"\n`,
    ).join("");
    await mkdir(join(PROJECTS_ROOT, BUSY), { recursive: true });
    await writeFile(
      join(PROJECTS_ROOT, BUSY, "compose.yaml"),
      [
        "services:",
        `  ${SERVICE}:`,
        `    image: ghcr.io/homestead/mediaserver@${DIGEST}`,
        "    ports:",
        ports.trimEnd(),
        "    volumes:",
        `      - ${VOLUME}:/var/lib/app`,
        "volumes:",
        `  ${VOLUME}: {}`,
        "",
      ].join("\n"),
    );
  });

  test.afterAll(async () => {
    await rm(join(PROJECTS_ROOT, BUSY), { recursive: true, force: true });
  });

  test("the overview is a third tab, not a sidebar", async ({ page }) => {
    await page.goto(`/projects/${BUSY}/overview`);

    // Three peers in one tab list. At `lg` and above Overview is a rail that
    // stays put while the other tabs change; on a phone there is no room for
    // a rail, so it has to be reachable the same way Edit and Logs are.
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveText(["Overview", "Edit", "Logs"]);
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const overview = page.getByRole("complementary", { name: "Overview" });
    await expect(overview).toBeVisible();
    await expect(page.getByRole("region", { name: "Services" })).toBeVisible();

    // The sidebar's own affordance is meaningless when Overview is a tab, and
    // its absence is what distinguishes the two layouts.
    await expect(page.getByRole("button", { name: /overview/i })).toHaveCount(
      0,
    );

    // Switching tabs replaces it, rather than leaving it docked alongside —
    // which is precisely what "a tab, not a sidebar" means.
    await page.getByRole("tab", { name: "Edit" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${BUSY}/edit$`));
    await expect(
      page.getByRole("region", { name: "Edit project files" }),
    ).toBeVisible();
    await expect(overview).toBeHidden();
  });

  test("the lifecycle controls need no menu opening first", async ({
    page,
  }) => {
    await page.goto(`/projects/${BUSY}/overview`);

    const toolbar = page.getByRole("toolbar", { name: "Lifecycle controls" });
    await expect(toolbar).toBeVisible();

    // Nothing was clicked to get here. Restarting a stack from a phone is the
    // primary mobile job, so it must not be a tap behind an overflow menu.
    expect(
      await toolbar
        .locator("xpath=ancestor-or-self::*[@aria-expanded]")
        .count(),
      "the toolbar sits inside a disclosure that has to be opened first",
    ).toBe(0);

    const viewport = page.viewportSize();
    if (!viewport) throw new Error("expected a viewport");
    for (const name of LIFECYCLE) {
      const button = toolbar.getByRole("button", { name, exact: true });
      await expect(
        button,
        `${name} is visible without opening a menu`,
      ).toBeVisible();
      const box = await button.boundingBox();
      if (!box) throw new Error(`${name} has no bounding box`);
      expect(
        box.height,
        `${name} clears the touch minimum`,
      ).toBeGreaterThanOrEqual(TOUCH_MIN);
      expect(
        box.x,
        `${name} starts inside the viewport`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        box.x + box.width,
        `${name} ends inside the viewport`,
      ).toBeLessThanOrEqual(viewport.width);
    }
  });

  test("the detail route does not scroll sideways", async ({ page }) => {
    await page.goto(`/projects/${BUSY}/overview`);
    // The long image name and the eighteen published ports are on screen, so
    // the measurement below is taken against the content that would break it.
    await expect(page.getByText(SERVICE, { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Volumes" })
        .getByText(`${BUSY}_${VOLUME}`, { exact: true }),
    ).toBeVisible();
    const ports = page
      .getByRole("region", { name: "Services" })
      .locator("li li");
    await expect(ports).toHaveCount(18);
    await expectNoHorizontalScroll(page, "the overview tab");

    // The Edit tab is the other half of the route: the parse-error panel and
    // the editor render there, and the overview rail does not.
    await page.getByRole("tab", { name: "Edit" }).click();
    await expect(
      page.getByRole("region", { name: "Edit project files" }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page, "the edit tab");
  });

  test("every control on the detail route meets the touch minimum", async ({
    page,
  }) => {
    await page.goto(`/projects/${BUSY}/overview`);
    await expect(
      page.getByRole("heading", { name: BUSY, level: 1 }),
    ).toBeVisible();

    // Back, four lifecycle buttons and three tabs is nine before the shell's
    // own nav — a floor, not a count.
    expectTappable(await sweepTapTargets(page), "the detail route", 9);
  });
});
