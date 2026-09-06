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

  it("moves focus with arrow keys", async () => {
    renderTabs();
    screen.getByRole("tab", { name: "Overview" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveFocus();
  });

  it("wraps from the last tab to the first", async () => {
    renderTabs("logs");
    screen.getByRole("tab", { name: "Logs" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });
});

describe("SegmentedControl", () => {
  it("reports the chosen value", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        items={[
          { id: "compose", label: "Compose" },
          { id: "env", label: ".env" },
        ]}
        value="compose"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: ".env" }));
    expect(onChange).toHaveBeenCalledWith("env");
  });
});
