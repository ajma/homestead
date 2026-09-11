// @vitest-environment jsdom
import type { DayBucket } from "@shared/launcher";
import { render } from "@testing-library/react";
import { Sparkline } from "@web/components/Sparkline";
import { describe, expect, it } from "vitest";

const day = (i: number, upRatio: number, downRatio: number): DayBucket => ({
  dayStart: i * 86_400,
  upRatio,
  degradedRatio: 0,
  downRatio,
  probeCount: 1,
});
/** A day nobody measured. Ratios are 0 here too, which is exactly the trap. */
const noData = (i: number): DayBucket => ({
  dayStart: i * 86_400,
  upRatio: 0,
  degradedRatio: 0,
  downRatio: 0,
  probeCount: 0,
});

describe("Sparkline", () => {
  it("draws one bar per day", () => {
    const history = Array.from({ length: 30 }, (_, i) => day(i, 1, 0));
    const { container } = render(<Sparkline history={history} />);
    expect(container.querySelectorAll("rect").length).toBe(30);
  });

  it("renders nothing rather than dividing by zero on an empty history", () => {
    const { container } = render(<Sparkline history={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("survives a day with no checks without producing NaN coordinates", () => {
    // A no-data day is the normal case for a probe added last week, and NaN in a
    // `height` attribute silently renders nothing at all.
    const history = [noData(0), day(1, 0.8, 0.2)];
    const { container } = render(<Sparkline history={history} />);
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("paints a day nobody measured differently from a day that was fully down", () => {
    // Both have upRatio 0. Only `probeCount` tells them apart, and conflating them
    // reports an outage for every day before a probe existed.
    const { container } = render(<Sparkline history={[noData(0), day(1, 0, 1)]} />);
    const [none, down] = [...container.querySelectorAll("rect")];
    expect(none?.getAttribute("fill")).not.toBe(down?.getAttribute("fill"));
  });

  it("gives a fully-down day a visibly different bar from a fully-up day", () => {
    const { container } = render(<Sparkline history={[day(0, 1, 0), day(1, 0, 1)]} />);
    const [first, second] = [...container.querySelectorAll("rect")];
    expect(first?.getAttribute("fill")).not.toBe(second?.getAttribute("fill"));
  });

  it("carries a text summary, since a bar chart alone is not accessible", () => {
    const { container } = render(<Sparkline history={[day(0, 1, 0)]} />);
    expect(container.querySelector("title")?.textContent).toMatch(/%/);
  });

  it("varies bar height by severity, so status is not colour alone for a colour-blind viewer", () => {
    const degradedDay: DayBucket = {
      dayStart: 86_400,
      upRatio: 0.5,
      degradedRatio: 0.5,
      downRatio: 0,
      probeCount: 1,
    };
    const { container } = render(<Sparkline history={[day(0, 1, 0), degradedDay, day(2, 0, 1)]} />);
    const [up, degraded, down] = [...container.querySelectorAll("rect")];
    const heights = [up, degraded, down].map((rect) => Number(rect?.getAttribute("height")));
    expect(new Set(heights).size).toBe(3);
    expect(heights[0]).toBeGreaterThan(heights[1] as number);
    expect(heights[1]).toBeGreaterThan(heights[2] as number);
  });

  it("renders a no-data day as hollow, a shape distinct from every filled day", () => {
    const { container } = render(<Sparkline history={[noData(0), day(1, 1, 0)]} />);
    const [none, up] = [...container.querySelectorAll("rect")];
    expect(none?.getAttribute("fill")).toBe("none");
    expect(up?.getAttribute("fill")).not.toBe("none");
  });
});
