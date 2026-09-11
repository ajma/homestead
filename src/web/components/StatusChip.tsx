import type { AppStatus } from "@shared/types";
import { relativeTime } from "@web/lib/relative-time";

/**
 * Every status pairs a colour with a distinct glyph and with text. Colour alone fails
 * for a colour-blind user and for a screen reader, and this is the only signal on the
 * screen that matters.
 */
const PRESENTATION: Record<AppStatus, { dot: string; glyph: string; text: string }> = {
  up: { dot: "bg-emerald-500", glyph: "●", text: "text-slate-500 dark:text-slate-400" },
  degraded: { dot: "bg-amber-500", glyph: "◐", text: "text-amber-700 dark:text-amber-400" },
  down: { dot: "bg-rose-500", glyph: "▲", text: "text-rose-700 dark:text-rose-400" },
  starting: { dot: "bg-sky-500", glyph: "◌", text: "text-sky-700 dark:text-sky-400" },
  unknown: { dot: "bg-slate-400", glyph: "?", text: "text-slate-500 dark:text-slate-400" },
};

export function StatusChip({
  status,
  reason,
  since,
  onOpen,
}: {
  status: AppStatus;
  reason: string;
  since: number | null;
  onOpen: () => void;
}) {
  const style = PRESENTATION[status];
  const age = since === null ? null : relativeTime(since, Math.floor(Date.now() / 1000));

  return (
    <button
      type="button"
      // The card behind this is the launch target. Without stopPropagation, checking
      // why something is down opens the thing that is down.
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      aria-label={`Status: ${status}. ${reason}. Show health details.`}
      className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-xs ${style.text} hover:bg-slate-100 dark:hover:bg-slate-800`}
    >
      <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden="true" />
      <span className="sr-only">{style.glyph}</span>
      <span className="truncate">{reason}</span>
      {age !== null && <span className="opacity-60">· {age}</span>}
    </button>
  );
}
