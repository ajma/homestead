// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { describe, expect, it, vi } from "vitest";

function mount(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      title="Delete app"
      message="Delete Jellyfin? This cannot be undone."
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onConfirm, onClose };
}

describe("ConfirmDialog", () => {
  it("names the thing being confirmed in the body", () => {
    mount();
    expect(screen.getByText("Delete Jellyfin? This cannot be undone.")).toBeTruthy();
  });

  it("puts initial focus on Cancel, not the confirm action", () => {
    mount();
    const dialog = screen.getByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
  });

  it("does nothing at all when cancelled", () => {
    const { onConfirm, onClose } = mount();
    const dialog = screen.getByRole("dialog");

    within(dialog).getByRole("button", { name: "Cancel" }).click();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs the action and closes when confirmed", () => {
    const { onConfirm, onClose } = mount();
    const dialog = screen.getByRole("dialog");

    within(dialog).getByRole("button", { name: "Delete" }).click();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
