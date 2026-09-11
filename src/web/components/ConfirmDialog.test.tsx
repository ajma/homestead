// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** A promise the test controls the settlement of, for exercising the pending window. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it("closes once a resolving async onConfirm settles", async () => {
    const { promise, resolve } = deferred<void>();
    const { onClose } = mount({ onConfirm: () => promise });
    const dialog = screen.getByRole("dialog");

    within(dialog).getByRole("button", { name: "Delete" }).click();
    expect(onClose).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the dialog open and shows the message when onConfirm rejects", async () => {
    const { promise, reject } = deferred<void>();
    const { onClose } = mount({ onConfirm: () => promise });
    const dialog = screen.getByRole("dialog");

    within(dialog).getByRole("button", { name: "Delete" }).click();
    reject(new Error("job_running"));

    await waitFor(() => expect(screen.getByText("job_running")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables both buttons while onConfirm is pending", async () => {
    const { promise, resolve } = deferred<void>();
    const { onClose } = mount({ onConfirm: () => promise });
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(within(dialog).getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(
      true,
    );

    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("fires onConfirm only once when Confirm is clicked twice while pending", async () => {
    const { promise, resolve } = deferred<void>();
    const onConfirm = vi.fn(() => promise);
    const { onClose } = mount({ onConfirm });
    const dialog = screen.getByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: "Delete" });

    confirmButton.click();
    confirmButton.click();
    confirmButton.click();

    expect(onConfirm).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("does not let Escape dismiss the dialog while onConfirm is pending", async () => {
    // The gap DialogShell's closeDisabled prop closes: without it, Escape mid-request
    // dismissed the dialog and lost whatever rejection (a 409 job_running, say) was about
    // to render in its place.
    const { promise, reject } = deferred<void>();
    const { onClose } = mount({ onConfirm: () => promise });
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();

    reject(new Error("job_running"));
    await waitFor(() => expect(screen.getByText("job_running")).toBeTruthy());
  });

  it("still closes immediately for a synchronous onConfirm that returns void", () => {
    // Covered above by "runs the action and closes when confirmed" too — restated here
    // because the async widening is exactly the change that could have broken it.
    const { onConfirm, onClose } = mount();
    const dialog = screen.getByRole("dialog");

    within(dialog).getByRole("button", { name: "Delete" }).click();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
