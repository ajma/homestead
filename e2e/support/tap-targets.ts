import { expect, type Locator, type Page } from "@playwright/test";

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
    // WCAG 2.5.8's inline exception: a link inside a sentence is sized by the
    // text around it, and there is no honest way to give it 44px — padding it
    // to an inline-block tears holes in the paragraph, and a 44px line-height
    // wrecks the whole block. Prose links are read, not aimed at, and the
    // sentence they sit in is the affordance.
    //
    // Narrow on purpose: it needs the anchor to render `display: inline` AND
    // its parent to hold text the link does not, so a lone `<a>` in a <p> —
    // which is a button wearing prose clothing — is still measured.
    const isProseLink = await control.evaluate((el) => {
      if (el.tagName !== "A") return false;
      if (getComputedStyle(el).display !== "inline") return false;
      const parent = el.parentElement;
      if (!parent) return false;
      const around = (parent.textContent ?? "").trim().length;
      const own = (el.textContent ?? "").trim().length;
      return around > own;
    });

    if (!isProseLink) {
      if (box.height < TOUCH_MIN)
        offenders.push(`${name}: ${Math.round(box.height)}px tall`);
      if (box.width < TOUCH_MIN)
        offenders.push(`${name}: ${Math.round(box.width)}px wide`);
    }
    // Off-screen is a defect whatever the control is: a link running past the
    // right edge cannot be read, let alone tapped.
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
 * The control actually has an edge drawn around it.
 *
 * This exists because of a defect the design-system conformance gate is
 * structurally unable to see. `border-border` is a *valid* utility: it
 * compiles to `border-color: var(--color-border)` and the gate's resolution
 * check passes it. But Tailwind v4's preflight sets `border: 0 solid` on every
 * element, so a colour with no width companion paints nothing — the sign-in
 * and setup fields were invisible boxes on both themes. A static rule can see
 * the colour class but not whether a width class is applied to the same
 * element: widths come from siblings in other template literals (`border-b-2`
 * next to `border-transparent`), from a shared constant, or from a primitive.
 * Only the rendered page knows. So this asks the browser.
 *
 * Both halves matter: a border of zero width is invisible, and so is one
 * painted in the background colour.
 */
export async function expectDrawnBorder(
  control: Locator,
  what: string,
): Promise<void> {
  const drawn = await control.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      width: Number.parseFloat(s.borderTopWidth),
      style: s.borderTopStyle,
      color: s.borderTopColor,
      background: s.backgroundColor,
    };
  });
  expect(
    drawn.width,
    `${what}: border-width is 0, so nothing is drawn`,
  ).toBeGreaterThan(0);
  expect(drawn.style, `${what}: border-style is none`).not.toBe("none");
  expect(
    drawn.color,
    `${what}: the border is painted in the field's own background colour`,
  ).not.toBe(drawn.background);
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
