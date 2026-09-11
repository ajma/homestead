import type { ProbeKind } from "@shared/types";
import { useAppHealth } from "@web/api/launcher";
import { Sparkline } from "@web/components/Sparkline";
import { relativeTime } from "@web/lib/relative-time";
import { useNow } from "@web/lib/use-now";
import { useEffect } from "react";

const KIND_LABEL: Record<ProbeKind, string> = {
  docker: "Docker containers",
  http_internal: "Internal HTTP",
  http_external: "External HTTP",
};

/**
 * A bottom sheet on a phone and a centred panel on desktop, which Tailwind's breakpoints
 * express without a media-query hook. One component, two layouts — a JS breakpoint check
 * would re-render on every resize and disagree with CSS at the boundary.
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes on click; Escape (above) is the keyboard path, so it stays non-interactive.
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the backdrop's click-to-close from firing inside the panel; Escape (above) is the keyboard path. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Health for ${appName}`}
        onClick={(event) => event.stopPropagation()}
        className="w-full rounded-t-2xl bg-white p-4 sm:max-w-md sm:rounded-2xl dark:bg-slate-900"
      >
        <h2 className="mb-3 font-semibold text-slate-900 dark:text-slate-100">{appName}</h2>

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
