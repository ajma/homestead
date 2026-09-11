import type { AppStatus } from "@shared/types";
import { relativeTime } from "@web/lib/relative-time";
import { useNow } from "@web/lib/use-now";

/**
 * Every status pairs a colour with a distinct glyph shape, and with text. Colour alone
 * fails for a colour-blind user; the glyph is the visible indicator itself (not a
 * hidden echo of it), so it has to carry both.
 */
const PRESENTATION: Record<AppStatus, { glyph: string; glyphColor: string; text: string }> = {
  up: { glyph: "●", glyphColor: "text-emerald-500", text: "text-slate-500 dark:text-slate-400" },
  degraded: {
    glyph: "◐",
    glyphColor: "text-amber-500 dark:text-amber-400",
    text: "text-amber-700 dark:text-amber-400",
  },
  down: {
    glyph: "▲",
    glyphColor: "text-rose-500 dark:text-rose-400",
    text: "text-rose-700 dark:text-rose-400",
  },
  starting: {
    glyph: "◌",
    glyphColor: "text-sky-500 dark:text-sky-400",
    text: "text-sky-700 dark:text-sky-400",
  },
  unknown: { glyph: "?", glyphColor: "text-slate-400", text: "text-slate-500 dark:text-slate-400" },
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
  /**
   * Omitted where there is no health panel to open — the admin inventory, for one.
   * Rendering a `<button>` with an aria-label promising "Show health details" for a
   * click that does nothing sends a keyboard user chasing an action that isn't there;
   * a `<span>` with the same visuals says the same thing honestly.
   */
  onOpen?: () => void;
}) {
  const style = PRESENTATION[status];
  const now = useNow();
  const age = since === null ? null : relativeTime(since, now);

  const className = `flex items-center gap-1.5 rounded-full px-2 py-1 text-xs ${style.text} hover:bg-slate-100 dark:hover:bg-slate-800`;
  const content = (
    <>
      <span
        className={`inline-block w-4 shrink-0 text-center text-sm leading-none ${style.glyphColor}`}
        aria-hidden="true"
      >
        {style.glyph}
      </span>
      <span className="truncate">{reason}</span>
      {age !== null && <span className="opacity-60">· {age}</span>}
    </>
  );

  if (onOpen === undefined) {
    return (
      <span role="status" aria-label={`Status: ${status}. ${reason}.`} className={className}>
        {content}
      </span>
    );
  }

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
      className={className}
    >
      {content}
    </button>
  );
}
