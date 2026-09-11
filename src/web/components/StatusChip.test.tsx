// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusChip } from "@web/components/StatusChip";
import { describe, expect, it, vi } from "vitest";

describe("StatusChip", () => {
  it("shows the cause, not just a severity word", () => {
    render(
      <StatusChip
        status="degraded"
        reason="Tunnel unreachable — app is fine"
        since={null}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText(/Tunnel unreachable/)).toBeTruthy();
    expect(screen.queryByText(/^Degraded$/)).toBeNull();
  });

  it("appends a duration when the status has a start time", () => {
    const since = Math.floor(Date.now() / 1000) - 12 * 60;
    render(
      <StatusChip status="down" reason="Containers not running" since={since} onOpen={() => {}} />,
    );
    expect(screen.getByText(/12m/)).toBeTruthy();
  });

  it("omits the duration rather than rendering a bare separator when since is null", () => {
    render(<StatusChip status="unknown" reason="Not checked yet" since={null} onOpen={() => {}} />);
    expect(screen.getByRole("button").textContent).not.toContain("·");
  });

  it("conveys status by text as well as colour", () => {
    // Spec: status is never colour alone. A colour-blind user and a screen reader must
    // both get the status without reading a CSS class.
    render(
      <StatusChip status="down" reason="Containers not running" since={null} onOpen={() => {}} />,
    );
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toContain("down");
    expect(button.textContent).toContain("Containers not running");
  });

  it("calls onOpen and stops the click reaching the card behind it", () => {
    // The whole point of the separate tap target: checking health must never launch.
    const onOpen = vi.fn();
    const cardClicked = vi.fn();
    render(
      <button type="button" onClick={cardClicked}>
        <StatusChip status="up" reason="Healthy" since={null} onOpen={onOpen} />
      </button>,
    );
    fireEvent.click(screen.getAllByRole("button")[1] as HTMLElement);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(cardClicked).not.toHaveBeenCalled();
  });
});
