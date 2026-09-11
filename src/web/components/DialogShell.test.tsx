// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { DialogShell } from "@web/components/DialogShell";
import { describe, expect, it, vi } from "vitest";

/**
 * jsdom does not move focus on a synthetic `keyDown` the way a real browser does, so
 * asserting `document.activeElement` after dispatching a Tab key passes just as well
 * against no trap at all — that exact vacuous test was caught in Phase 1D. These tests
 * instead assert what `useDialogFocus`'s handler actually does: call `preventDefault()`
 * and an explicit `.focus()` on the element it computed as the wrap target.
 */
function dispatchTab(options: { shiftKey?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: options.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

function dispatchEscape() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

function Content({ withThird = false }: { withThird?: boolean }) {
  return (
    <>
      <button type="button">First</button>
      <button type="button">Second</button>
      {withThird && <button type="button">Third</button>}
    </>
  );
}

function mount(onClose = vi.fn(), withThird = false) {
  return {
    onClose,
    ...render(
      <DialogShell title="Test dialog" onClose={onClose}>
        <Content withThird={withThird} />
      </DialogShell>,
    ),
  };
}

describe("DialogShell", () => {
  it("moves initial focus inside the dialog", () => {
    mount();
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("wraps Tab from the last focusable element to the first", () => {
    mount();
    // Focusable order is: close button, First, Second — the close button lives before
    // the children in DOM order.
    const buttons = screen.getAllByRole("button");
    const first = buttons[0] as HTMLElement;
    const last = buttons[buttons.length - 1] as HTMLElement;
    last.focus();
    const focusSpy = vi.spyOn(first, "focus");

    const event = dispatchTab();

    expect(event.defaultPrevented).toBe(true);
    expect(focusSpy).toHaveBeenCalled();
  });

  it("wraps Shift+Tab from the first focusable element to the last", () => {
    mount();
    const buttons = screen.getAllByRole("button");
    const first = buttons[0] as HTMLElement;
    const last = buttons[buttons.length - 1] as HTMLElement;
    first.focus();
    const focusSpy = vi.spyOn(last, "focus");

    const event = dispatchTab({ shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(focusSpy).toHaveBeenCalled();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    mount(onClose);

    dispatchEscape();

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on a backdrop click but not on a click inside the dialog", () => {
    const onClose = vi.fn();
    mount(onClose);

    screen.getByRole("dialog").click();
    expect(onClose).not.toHaveBeenCalled();

    screen.getByRole("presentation").click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener on unmount", () => {
    const onClose = vi.fn();

    function Wrapper({ show }: { show: boolean }) {
      return (
        <>
          <button type="button">Opener</button>
          {show && (
            <DialogShell title="Test dialog" onClose={onClose}>
              <Content />
            </DialogShell>
          )}
        </>
      );
    }

    const { rerender } = render(<Wrapper show={false} />);
    const opener = screen.getByText("Opener");
    opener.focus();
    expect(document.activeElement).toBe(opener);

    rerender(<Wrapper show={true} />);
    expect(document.activeElement).not.toBe(opener);

    rerender(<Wrapper show={false} />);
    expect(document.activeElement).toBe(opener);
  });

  it("includes an element added after mount in the trap", () => {
    // `focusableElements` is called fresh inside the keydown handler rather than cached
    // at mount, so an element appearing mid-life — e.g. an error banner's link — must be
    // picked up.
    const { rerender, onClose } = mount(vi.fn(), false);
    rerender(
      <DialogShell title="Test dialog" onClose={onClose}>
        <Content withThird={true} />
      </DialogShell>,
    );

    const buttons = screen.getAllByRole("button");
    const first = buttons[0] as HTMLElement;
    const third = buttons[buttons.length - 1] as HTMLElement;
    expect(third.textContent).toBe("Third");
    third.focus();
    const focusSpy = vi.spyOn(first, "focus");

    const event = dispatchTab();

    expect(event.defaultPrevented).toBe(true);
    expect(focusSpy).toHaveBeenCalled();
  });
});
