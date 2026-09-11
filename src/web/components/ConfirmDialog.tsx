import { DialogShell } from "@web/components/DialogShell";
import { useEffect, useRef, useState } from "react";

function isPromiseLike(value: unknown): value is Promise<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describeError(error: unknown, formatError?: (error: unknown) => string): string {
  if (formatError) return formatError(error);
  return error instanceof Error ? error.message : String(error);
}

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
 * `onConfirm` may return `void` or a `Promise<void>`, because some callers confirm an
 * action that can fail asynchronously after the dialog would otherwise have closed — for
 * example a stack stop whose `POST .../actions/down` can answer 409 `job_running` because
 * the server's mutex rejected a second job, or a probe delete's own request. For those,
 * closing unconditionally and reporting failure elsewhere on the page would be an
 * after-the-fact banner divorced from the confirmation the admin just gave. Instead:
 *
 * - While `onConfirm`'s promise is pending, the dialog stays open and both buttons are
 *   disabled, so a second click on Confirm cannot fire a second request — for `down`,
 *   that second request is exactly the 409 this whole mechanism exists to avoid.
 * - If it resolves, the dialog closes, same as the synchronous path below.
 * - If it rejects, the dialog stays open, buttons re-enable, and the rejection is
 *   rendered in the dialog body. By default that's the rejection's own `message`;
 *   a caller wanting different wording (a friendlier string than a raw `Error#message`,
 *   or one that reads a non-`Error` rejection) passes `formatError`.
 *
 * A synchronous `onConfirm` that returns `void` behaves exactly as before — it runs, then
 * the dialog closes immediately, with no intervening render — because the return value is
 * checked for being a promise before anything async is awaited; a plain `undefined` takes
 * the synchronous close path unchanged. `OverviewTab`'s existing delete confirmation, whose
 * `onConfirm` fires-and-forgets a mutation and returns nothing, keeps working unmodified.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose,
  formatError,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  formatError?: (error: unknown) => string;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // A ref alongside the `pending` state: the guard in `handleConfirm` must see the
  // in-flight request on the very next click even if that click lands before React has
  // re-rendered with the disabled buttons (both `disabled` attributes are a courtesy for
  // real pointer input — nothing stops a second `click` event from reaching the handler
  // itself, so the actual once-only guarantee lives here).
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function handleConfirm() {
    if (pendingRef.current) return;

    const result = onConfirm();
    if (!isPromiseLike(result)) {
      onClose();
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError(null);

    result.then(
      () => {
        pendingRef.current = false;
        onClose();
      },
      (err: unknown) => {
        pendingRef.current = false;
        setPending(false);
        setError(describeError(err, formatError));
      },
    );
  }

  return (
    <DialogShell title={title} onClose={onClose} closeDisabled={pending}>
      <p className="text-sm text-slate-700 dark:text-slate-300">{message}</p>

      {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onClose}
          disabled={pending}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:opacity-50 dark:border-slate-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={pending}
          className={
            destructive
              ? "rounded-lg bg-rose-600 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-rose-500"
              : "rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          }
        >
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
