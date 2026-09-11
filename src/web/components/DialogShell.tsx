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
 */
function useDialogFocus(onClose: () => void) {
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
        onClose();
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
  }, [onClose]);

  return dialogRef;
}

/**
 * The shared shell behind `AdoptDialog` and `CreateAppDialog`: backdrop, header with a
 * title and close button, and the focus behaviour from `useDialogFocus`. Callers supply
 * the scrollable body and footer as children — this component only owns what both
 * dialogs must behave identically on, not their differing content.
 */
export function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useDialogFocus(onClose);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes on click; Escape (above) is the keyboard path, so it stays non-interactive.
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center"
      onClick={onClose}
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
            onClick={onClose}
            aria-label="Close"
            className="rounded-full px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}
