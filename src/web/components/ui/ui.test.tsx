import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Panel,
  StatusDot,
} from "./index.js";

describe("Button", () => {
  it("calls onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Restart</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is disabled and non-interactive while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Pull
      </Button>,
    );
    const btn = screen.getByRole("button", { name: /Pull/ });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("exposes busy state to assistive technology while loading", () => {
    render(<Button loading>Pull</Button>);
    expect(screen.getByRole("button", { name: /Pull/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

describe("IconButton", () => {
  it("has an accessible name from its label", () => {
    render(<IconButton label="Collapse panel">×</IconButton>);
    expect(
      screen.getByRole("button", { name: "Collapse panel" }),
    ).toBeInTheDocument();
  });
});

describe("StatusDot", () => {
  it("communicates state as text, not colour alone", () => {
    render(<StatusDot state="exited" />);
    expect(screen.getByText("exited")).toBeInTheDocument();
  });

  it.each([
    ["running", "bg-success"],
    ["exited", "bg-muted"],
    ["restarting", "bg-warning"],
    ["unknown", "bg-muted"],
  ] as const)("tints the %s dot with %s", (state, tint) => {
    const { container } = render(<StatusDot state={state} />);
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain(tint);
  });

  it("lets its label inherit colour so a muted row stays muted", () => {
    render(
      <p className="text-muted">
        <StatusDot state="unknown" label="No compose file" />
      </p>,
    );
    // jsdom has no cascade, so inheritance is asserted structurally: pinning a
    // colour on the label is what stops the "not a project" row looking muted.
    expect(screen.getByText("No compose file").className).not.toMatch(
      /\btext-(text|muted|accent|danger|success|warning)\b/,
    );
  });
});

describe("Panel and Badge and EmptyState", () => {
  it("renders a panel title as a heading", () => {
    render(<Panel title="Services">body</Panel>);
    expect(
      screen.getByRole("heading", { name: "Services" }),
    ).toBeInTheDocument();
  });

  it("renders badge content", () => {
    render(<Badge tone="success">tunnel-only</Badge>);
    expect(screen.getByText("tunnel-only")).toBeInTheDocument();
  });

  it("renders an empty state with its action", () => {
    render(<EmptyState title="No projects" action={<Button>New</Button>} />);
    expect(
      screen.getByRole("heading", { name: "No projects" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });
});
