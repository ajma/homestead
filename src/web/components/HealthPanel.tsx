import type { ProbeKind } from "@shared/types";
import { useAppHealth } from "@web/api/launcher";
import { Sparkline } from "@web/components/Sparkline";
import { relativeTime } from "@web/lib/relative-time";
import { useNow } from "@web/lib/use-now";
import { useEffect, useRef } from "react";

const KIND_LABEL: Record<ProbeKind, string> = {
  docker: "Docker containers",
  http_internal: "Internal HTTP",
  http_external: "External HTTP",
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * A bottom sheet on a phone and a centred panel on desktop, which Tailwind's breakpoints
 * express without a media-query hook. One component, two layouts — a JS breakpoint check
 * would re-render on every resize and disagree with CSS at the boundary.
 *
 * Two nested `div`s (backdrop, then dialog), not a native `<dialog>`. That is not a
 * workaround for anything — a native `<dialog>` would be the more spec-correct choice on
 * a browser that implements it, but `showModal`/`close` are not implemented at all by
 * jsdom 30 (confirmed: both are `undefined` on the prototype in this project's test
 * environment), so this suite could not exercise its modal behaviour. Two plain `div`s
 * with the focus handling below is the ordinary, fully-testable way to build a modal
 * without that primitive, and it is fine on its own terms.
 */
export function HealthPanel({
  appId,
  appName,
  onClose,
}: {
  appId: string;
  appName: string;
  onClose: () => void;
}) {
  const { data, isError, isPending } = useAppHealth(appId);
  const now = useNow();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Capture whatever had focus before the panel took it, and move focus into the panel
  // itself — otherwise Tab from the trigger button walks straight past this panel (it
  // has no focusable descendants until the effect below runs) into whatever card sits
  // behind the translucent backdrop.
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

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes on click; Escape (below) is the keyboard path, so it stays non-interactive.
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
        aria-label={`Health for ${appName}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="w-full rounded-t-2xl bg-white p-4 sm:max-w-md sm:rounded-2xl dark:bg-slate-900"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">{appName}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {isPending && <p className="text-sm text-slate-500">Loading health…</p>}
        {isError && (
          <p className="text-sm text-rose-600 dark:text-rose-400">Could not load health details.</p>
        )}

        {data && (
          <>
            <ul className="mb-4 flex flex-col gap-2">
              {data.signals.map((signal) => (
                <li
                  key={signal.probeId}
                  className="flex items-baseline justify-between gap-2 text-sm"
                >
                  <span className="text-slate-600 dark:text-slate-300">
                    {signal.label ?? KIND_LABEL[signal.kind]}
                  </span>
                  <span className="text-right text-slate-900 dark:text-slate-100">
                    {signal.reason}
                    {signal.since !== null && (
                      // `useNow`, not `Date.now()`: nothing else re-renders this panel, so
                      // an inline clock read freezes the moment the panel opens. Added in
                      // Task 9's fix round; see `use-now.ts` for why the interval is shared.
                      <span className="ml-1 opacity-60">· {relativeTime(signal.since, now)}</span>
                    )}
                  </span>
                </li>
              ))}
              {data.signals.length === 0 && (
                <li className="text-sm text-slate-500">No probes configured for this app.</li>
              )}
            </ul>
            <Sparkline history={data.history} />
            <p className="mt-1 text-xs text-slate-500">Last 30 days</p>
          </>
        )}
      </div>
    </div>
  );
}
