import { DialogShell } from "@web/components/DialogShell";
import { useEffect, useRef } from "react";

/**
 * A `window.confirm` replacement, built on `DialogShell` so a destructive action gets the
 * same focus-trapped, themeable, non-blocking modal as the rest of the app rather than
 * browser chrome that ignores the dark theme and cannot be styled.
 *
 * `DialogShell`'s own `useDialogFocus` moves initial focus to the dialog's outer `div` —
 * fine for `AdoptDialog` and `CreateAppDialog`, where nothing in the body is destructive.
 * Here it is not enough: a dialog that opens with the destructive button one Enter away
 * turns a stray keystroke into data loss. The `useEffect` below runs after `DialogShell`'s
 * (child effects fire before a parent's in React's commit order — `DialogShell` is the
 * child here), so it always gets the last word and moves focus onto Cancel specifically.
 *
 * Both paths close the dialog: cancelling calls only `onClose`, confirming calls
 * `onConfirm` and then `onClose`, so a caller's `onConfirm` only has to run the action —
 * it never has to remember to dismiss the dialog itself.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function handleConfirm() {
    onConfirm();
    onClose();
  }

  return (
    <DialogShell title={title} onClose={onClose}>
      <p className="text-sm text-slate-700 dark:text-slate-300">{message}</p>

      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          className={
            destructive
              ? "rounded-lg bg-rose-600 px-3 py-2 text-sm text-white dark:bg-rose-500"
              : "rounded-lg bg-slate-900 px-3 py-2 text-sm text-white dark:bg-slate-100 dark:text-slate-900"
          }
        >
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
