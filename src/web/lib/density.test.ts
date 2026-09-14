import {
  CARD_PADDING,
  FORM_CONTROL_MAX_WIDTH,
  FORM_LABEL,
  FORM_ROW,
  PAGE_MAX_WIDTH,
  PAGE_SHELL,
  SECTION_GAP,
  TWO_UP_GRID,
} from "@web/lib/density";
import { describe, expect, it } from "vitest";

/**
 * These are the values every screen in the desktop density pass opts into. Pinning the
 * literal strings here, not just where they're consumed, means a future edit that
 * silently narrows the scale back down (e.g. reverting `PAGE_MAX_WIDTH` to something
 * `max-w-5xl`-sized) fails in the one file that is supposed to be the single source of
 * truth, rather than only in whichever screen happened to be tested for it.
 */
describe("density scale", () => {
  it("caps page width at 1328px — 1024px of content, a 16px gap, and the 288px rail", () => {
    expect(PAGE_MAX_WIDTH).toBe("max-w-[1328px]");
  });

  it("composes the page shell from the max width plus phone-safe, md-grown padding", () => {
    expect(PAGE_SHELL).toBe("mx-auto max-w-[1328px] p-4 md:px-6 md:py-5");
    // The phone base (`p-4`) is untouched — only `md:` and up add anything.
    expect(PAGE_SHELL).toContain("p-4");
  });

  it("tightens the gap between major sections at md: and up, leaving the phone value alone", () => {
    expect(SECTION_GAP).toBe("space-y-6 md:space-y-4");
  });

  it("grows card padding only at md: and up", () => {
    expect(CARD_PADDING).toBe("p-4 md:p-5");
  });

  it("caps a form control's width unconditionally, not gated behind a breakpoint", () => {
    // Unlike every other token here, this one applies at every viewport on purpose —
    // an uncapped single-line input is wrong on a phone too, it just never shows on one.
    expect(FORM_CONTROL_MAX_WIDTH).toBe("max-w-lg");
    expect(FORM_CONTROL_MAX_WIDTH).not.toContain("lg:");
  });

  it("flips a form row from label-above-input to label-beside-input only at lg: and up", () => {
    expect(FORM_ROW).toBe("flex flex-col gap-1 text-sm lg:flex-row lg:items-start lg:gap-3");
    expect(FORM_ROW).toContain("flex-col");
    expect(FORM_ROW).toContain("lg:flex-row");
  });

  it("gives a form label a fixed width only once it sits beside its control", () => {
    expect(FORM_LABEL).toBe(
      "font-medium text-slate-900 dark:text-slate-100 lg:w-32 lg:shrink-0 lg:pt-2",
    );
  });

  it("puts two short panels side by side only at lg: and up, stacked below it", () => {
    expect(TWO_UP_GRID).toBe("grid grid-cols-1 gap-6 lg:grid-cols-2");
    expect(TWO_UP_GRID).toContain("grid-cols-1");
    expect(TWO_UP_GRID).toContain("lg:grid-cols-2");
  });
});
