import { CARD_PADDING, PAGE_MAX_WIDTH, PAGE_SHELL, SECTION_GAP } from "@web/lib/density";
import { describe, expect, it } from "vitest";

/**
 * These are the values every screen in the desktop density pass opts into. Pinning the
 * literal strings here, not just where they're consumed, means a future edit that
 * silently narrows the scale back down (e.g. reverting `PAGE_MAX_WIDTH` to something
 * `max-w-5xl`-sized) fails in the one file that is supposed to be the single source of
 * truth, rather than only in whichever screen happened to be tested for it.
 */
describe("density scale", () => {
  it("caps page width well past the old 1024px max-w-5xl, but bounded", () => {
    expect(PAGE_MAX_WIDTH).toBe("max-w-[1680px]");
  });

  it("composes the page shell from the max width plus phone-safe, md-grown padding", () => {
    expect(PAGE_SHELL).toBe("mx-auto max-w-[1680px] p-4 md:px-6 md:py-5");
    // The phone base (`p-4`) is untouched — only `md:` and up add anything.
    expect(PAGE_SHELL).toContain("p-4");
  });

  it("tightens the gap between major sections at md: and up, leaving the phone value alone", () => {
    expect(SECTION_GAP).toBe("space-y-6 md:space-y-4");
  });

  it("grows card padding only at md: and up", () => {
    expect(CARD_PADDING).toBe("p-4 md:p-5");
  });
});
