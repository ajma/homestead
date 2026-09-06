import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl, Tabs } from "./index.js";

const items = [
  { id: "overview", label: "Overview", href: "/projects/a/overview" },
  { id: "edit", label: "Edit", href: "/projects/a/edit" },
  { id: "logs", label: "Logs", href: "/projects/a/logs" },
];

function renderTabs(activeId = "overview") {
  return render(
    <MemoryRouter initialEntries={[`/projects/a/${activeId}`]}>
      <Tabs items={items} activeId={activeId} />
    </MemoryRouter>,
  );
}

describe("Tabs", () => {
  it("exposes a tablist with the active tab selected", () => {
    renderTabs();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("keeps only the active tab in the tab order", () => {
    renderTabs();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  /**
   * More than one key, every time.
   *
   * These tabs use manual activation, so focus and the active tab diverge on
   * the very first press — and every one of these assertions passed while the
   * component was computing each move from `activeId`, because a single press
   * from the active tab is the one case where focus and the URL agree. The
   * bug lived entirely in the second keystroke: a keyboard user could not
   * reach Logs at all. A scenario that cannot reach the second press cannot
   * express the defect, however correct its assertion.
   */
  it("walks the whole tablist, one arrow at a time", async () => {
    renderTabs();
    screen.getByRole("tab", { name: "Overview" }).focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: "Logs" }),
      "a second ArrowRight must keep moving",
    ).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });

  it("walks back from wherever focus has got to, not from the URL", async () => {
    renderTabs();
    screen.getByRole("tab", { name: "Overview" }).focus();

    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(
      screen.getByRole("tab", { name: "Edit" }),
      "ArrowLeft must step back one, not jump to the far end",
    ).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });

  it("moves from a focused tab that is not the active one", async () => {
    // Focus can start anywhere: Tab into the tablist lands on the active tab,
    // but a click moves focus without this component's key handler running.
    renderTabs("overview");
    screen.getByRole("tab", { name: "Edit" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });

  it("takes Home and End from anywhere in the list", async () => {
    renderTabs();
    screen.getByRole("tab", { name: "Overview" }).focus();
    await userEvent.keyboard("{ArrowRight}{End}");
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });

  it("wraps from the last tab to the first", async () => {
    renderTabs("logs");
    screen.getByRole("tab", { name: "Logs" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });
});

describe("SegmentedControl", () => {
  const SEGMENTS = [
    { id: "compose", label: "Compose" },
    { id: "env", label: ".env" },
  ];

  it("reports the chosen value", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl items={SEGMENTS} value="compose" onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("radio", { name: ".env" }));
    expect(onChange).toHaveBeenCalledWith("env");
  });

  it("keeps one stable radio group name across renders", async () => {
    // `Math.random()` in the render body produced a new group name, a new
    // input id and a new htmlFor on every render, and a different one in each
    // of StrictMode's paired renders. Nothing consumes this component yet, so
    // the symptom would first be met by whoever debugs the compose editor.
    const items = SEGMENTS;
    const { rerender } = render(
      <SegmentedControl items={items} value="compose" onChange={vi.fn()} />,
    );
    const first = screen.getByRole("radio", { name: "Compose" });
    const name = first.getAttribute("name");
    expect(name).toBeTruthy();
    expect(first.id).toBeTruthy();

    rerender(<SegmentedControl items={items} value="env" onChange={vi.fn()} />);
    const after = screen.getByRole("radio", { name: "Compose" });
    expect(after.getAttribute("name"), "the group name must not change").toBe(
      name,
    );
    expect(after.id, "the input id must not change").toBe(first.id);
  });

  it("does not put two controls in the same radio group", async () => {
    // Two instances on one page must be independent, or choosing in one
    // unchecks the other.
    render(
      <>
        <SegmentedControl items={SEGMENTS} value="compose" onChange={vi.fn()} />
        <SegmentedControl items={SEGMENTS} value="env" onChange={vi.fn()} />
      </>,
    );
    const [a, b] = screen.getAllByRole("radio", { name: "Compose" });
    expect(a?.getAttribute("name")).not.toBe(b?.getAttribute("name"));
  });
});
