import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">outside before</button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        title="Confirm"
      >
        <Button onClick={() => {}}>First</Button>
        <Button onClick={() => {}}>Second</Button>
      </Dialog>
      <button type="button">outside after</button>
    </>
  );
}

describe("Dialog", () => {
  it("moves focus into the dialog when it opens", async () => {
    render(<Harness />);
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("traps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    first.focus();
    await user.tab();
    expect(second).toHaveFocus();
    await user.tab();
    // Wraps back into the dialog rather than escaping to "outside after".
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("traps Shift+Tab backwards too", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: "First" }).focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("closes on Escape from anywhere on the page", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const outside = screen.getByRole("button", { name: "outside before" });
    outside.focus();
    expect(outside).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("restores focus to the element that had it when it opened", async () => {
    const user = userEvent.setup();
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Confirm">
            <Button onClick={() => setOpen(false)}>Done</Button>
          </Dialog>
        </>
      );
    }
    render(<Toggle />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("renders nothing when closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Confirm">
        <span>hidden</span>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("hidden")).toBeNull();
  });

  it("traps Tab when the dialog contains no focusable elements", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">outside before</button>
        <Dialog open={true} onClose={() => {}} title="Confirm">
          <p>Just text, no buttons.</p>
        </Dialog>
        <button type="button">outside after</button>
      </>,
    );
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(dialog).toHaveFocus();
  });

  it("traps Tab when all focusable elements are disabled", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">outside before</button>
        <Dialog open={true} onClose={() => {}} title="Confirm">
          <Button disabled={true}>Disabled</Button>
        </Dialog>
        <button type="button">outside after</button>
      </>,
    );
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(dialog).toHaveFocus();
  });
});
