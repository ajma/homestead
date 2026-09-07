import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HistoryBar } from "./HistoryBar.js";

describe("HistoryBar", () => {
  it("renders one segment per bucket", () => {
    const buckets = [
      { startedAt: 0, ratio: 1 },
      { startedAt: 1, ratio: 0 },
      { startedAt: 2, ratio: null },
    ];
    const { container } = render(<HistoryBar buckets={buckets} />);
    expect(container.querySelectorAll("rect")).toHaveLength(3);
  });

  it("distinguishes up, down and no-data", () => {
    // A fixture with no outage cannot detect a bar that never renders red, and
    // one with no gap cannot detect "no data" being drawn as an outage.
    const { container } = render(
      <HistoryBar
        buckets={[
          { startedAt: 0, ratio: 1 },
          { startedAt: 1, ratio: 0 },
          { startedAt: 2, ratio: null },
        ]}
      />,
    );
    const classes = [...container.querySelectorAll("rect")].map(
      (r) => r.getAttribute("class") ?? "",
    );
    expect(new Set(classes).size).toBe(3);
  });

  it("labels itself for screen readers rather than being a wall of rects", () => {
    render(<HistoryBar buckets={[{ startedAt: 0, ratio: 1 }]} />);
    expect(screen.getByRole("img")).toHaveAccessibleName(/history/i);
  });

  it("distinguishes partial uptime from full uptime and outages", () => {
    const { container } = render(
      <HistoryBar
        buckets={[
          { startedAt: 0, ratio: 1 },
          { startedAt: 1, ratio: 0.5 },
          { startedAt: 2, ratio: 0 },
        ]}
      />,
    );
    const classes = [...container.querySelectorAll("rect")].map(
      (r) => r.getAttribute("class") ?? "",
    );
    expect(new Set(classes).size).toBe(3);
  });
});
