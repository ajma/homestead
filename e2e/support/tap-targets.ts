import { expect, type Page } from "@playwright/test";

/**
 * The phone this suite holds itself to.
 *
 * Narrower than any Playwright `devices` phone descriptor, and deliberately
 * so: `playwright.config.ts` runs the whole suite at this width rather than at
 * a Pixel 7's 412px, so one number governs both the `mobile` project and the
 * specs that call `setViewportSize` themselves.
 */
export const PHONE = { width: 390, height: 844 };

/** A thumb is about 44px across, per WCAG 2.5.8 / the platform HIGs. */
export const TOUCH_MIN = 44;

/**
 * A control 44px tall and 8px wide is as hard to hit as one 8px tall, so both
 * dimensions are measured, and `measured` is reported alongside the offenders.
 */
export type Sweep = { offenders: string[]; measured: number };

/**
 * Measures every visible control on the page, not a hand-written list.
 *
 * An earlier version of this measured only the four lifecycle buttons, and so
 * said nothing about the operation panel's Dismiss — which shipped at 36px and
 * renders at 390px. A sweep cannot forget a control that was added later.
 *
 * It reports how many it measured, because a selector that quietly stops
 * matching turns the whole mobile safety net into a green no-op: every `for`
 * loop over an empty list passes. {@link expectTappable} is what turns that
 * count into a failure, and no caller should assert on the offenders alone.
 */
export async function sweepTapTargets(page: Page): Promise<Sweep> {
  const viewport = page.viewportSize();
  if (!viewport)
    throw new Error("sweepTapTargets needs a viewport to measure against");

  const controls = page.locator(
    'button:visible, a[href]:visible, input:visible, [role="button"]:visible, [role="tab"]:visible',
  );
  const measured = await controls.count();
  const offenders: string[] = [];
  for (let i = 0; i < measured; i++) {
    const control = controls.nth(i);
    const name = (
      await control.evaluate(
        (el) =>
          el.getAttribute("aria-label") ??
          (el as HTMLInputElement).value ??
          el.textContent ??
          "",
      )
    )
      .trim()
      .slice(0, 40);
    const box = await control.boundingBox();
    if (!box) {
      offenders.push(`${name}: no bounding box`);
      continue;
    }
    if (box.height < TOUCH_MIN)
      offenders.push(`${name}: ${Math.round(box.height)}px tall`);
    if (box.width < TOUCH_MIN)
      offenders.push(`${name}: ${Math.round(box.width)}px wide`);
    if (box.x < 0 || box.x + box.width > viewport.width)
      offenders.push(`${name}: outside the viewport`);
  }
  return { offenders, measured };
}

/**
 * Fails on an offender *and* on a sweep that found nothing to measure.
 *
 * `minControls` is a floor, never an exact count — asserting an exact number
 * would break on every legitimate addition. Pass the number of controls the
 * route cannot render without, so a selector that stops matching, or a page
 * that failed to render at all, is a red test rather than a silent pass.
 */
export function expectTappable(
  sweep: Sweep,
  when: string,
  minControls: number,
): void {
  expect(sweep.offenders, `${when}: undersized or off-screen`).toEqual([]);
  expect(
    sweep.measured,
    `${when}: the sweep matched ${sweep.measured} controls, so it proved nothing`,
  ).toBeGreaterThanOrEqual(minControls);
}

/**
 * The page does not scroll sideways.
 *
 * `click()` auto-scrolls, so no interaction assertion can see this: only a
 * layout measurement can. One unwrapped port list or long image name is the
 * usual cause, and the symptom on a phone is a page that slides under the
 * thumb with content parked off the right edge.
 */
export async function expectNoHorizontalScroll(
  page: Page,
  when: string,
): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `${when}: the page scrolls sideways (${scrollWidth}px of content in ${clientWidth}px)`,
  ).toBeLessThanOrEqual(clientWidth);
}
