import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Focus capture, initial focus, the Tab trap, and restore-on-close for a modal built from
 * nested `div`s rather than a native `<dialog>` — jsdom 30 does not implement
 * `HTMLDialogElement.showModal`, so a native dialog's modal behaviour could not be
 * exercised by this suite.
 *
 * Extracted from `AdoptDialog` (Task 4) when `CreateAppDialog` (Task 5) needed the exact
 * same behaviour: two dialogs reimplementing a focus trap independently is the kind of
 * duplication where the copies drift the next time either one is touched.
 *
 * `closeDisabled` gates only the Escape key here — the Tab trap itself has nothing to do
 * with dismissal and keeps working regardless.
 */
function useDialogFocus(onClose: () => void, closeDisabled: boolean) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!closeDisabled) onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;
      const insideDialog = active instanceof Node && dialog.contains(active);

      if (event.shiftKey) {
        if (!insideDialog || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!insideDialog || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, closeDisabled]);

  return dialogRef;
}

/**
 * The shared shell behind `AdoptDialog`, `CreateAppDialog` and `ConfirmDialog`: backdrop,
 * header with a title and close button, and the focus behaviour from `useDialogFocus`.
 * Callers supply the scrollable body and footer as children — this component only owns
 * what dialogs must behave identically on, not their differing content.
 *
 * `closeDisabled` defaults to `false`, so `AdoptDialog` and `CreateAppDialog` — neither of
 * which has a pending-request state to protect — are unaffected by its existence. It exists
 * for `ConfirmDialog`: while its `onConfirm` promise is pending, Escape, the backdrop click
 * and this header's close button all used to call `onClose` unconditionally, so a user could
 * dismiss the dialog mid-request and lose whatever rejection message (a 409 `job_running`,
 * for example) `ConfirmDialog` was about to render in its place. `closeDisabled={pending}`
 * closes that gap without `AdoptDialog` or `CreateAppDialog` having to know it exists — the
 * Tab trap itself is untouched, since focus containment has nothing to do with dismissal.
 */
export function DialogShell({
  title,
  onClose,
  closeDisabled = false,
  children,
}: {
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  children: React.ReactNode;
}) {
  const dialogRef = useDialogFocus(onClose, closeDisabled);

  function handleClose() {
    if (!closeDisabled) onClose();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes on click; Escape (above) is the keyboard path, so it stays non-interactive.
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center"
      onClick={handleClose}
      role="presentation"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: this handler only stops the backdrop's click-to-close from bubbling up; it adds no interaction of its own, so there is no keyboard equivalent to give it. Escape and the close button below are the real keyboard paths. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full flex-col rounded-t-2xl bg-white p-4 sm:max-w-lg sm:rounded-2xl dark:bg-slate-900"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            disabled={closeDisabled}
            className="rounded-full px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}
