import type { DayBucket } from "@shared/launcher";

const WIDTH = 240;
const HEIGHT = 32;

// UTC, not the viewer's local zone: `dayStart` is a UTC day boundary, and formatting it
// in a local zone could shift the printed date across midnight and mislabel the bar.
const DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * The visual encoding (fill colour, bar height, hollow-vs-filled) distinguishes no-data
 * from fully-down from up, but only for a sighted viewer. This gives a screen reader
 * user the same distinction per bar, not just the 30-day aggregate.
 */
function dayLabel(day: DayBucket): string {
  const date = DAY_FORMATTER.format(new Date(day.dayStart * 1000));
  if (day.probeCount === 0) return `${date}: no data`;
  const upPercent = Math.round(day.upRatio * 100);
  if (upPercent === 0) return `${date}: down all day`;
  return `${date}: ${upPercent}% up`;
}

/**
 * Hand-rolled SVG rather than a charting dependency: 30 bars is not worth 40 KB, and
 * the constraint for this phase is no new dependencies.
 *
 * A day with no checks renders as a hollow full-height bar, not a filled one and not a
 * gap — an absent bar and a healthy bar are indistinguishable at this size by fill alone,
 * and "no data" is information.
 *
 * Severity is never colour alone either: each bar's height falls as its status worsens
 * (full for up, mid for degraded, short for down), so the categories stay distinguishable
 * by silhouette even for a colour-blind viewer or on a colour-stripped printout.
 */
export function Sparkline({ history }: { history: DayBucket[] }) {
  if (history.length === 0) return null;

  const barWidth = WIDTH / history.length;
  // Average the daily ratios over the days that have data. Weighting by sample count
  // would reintroduce the bias the ratios exist to remove.
  const withData = history.filter((day) => day.probeCount > 0);
  const uptime =
    withData.length === 0
      ? null
      : Math.round((withData.reduce((sum, day) => sum + day.upRatio, 0) / withData.length) * 100);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-8 w-full"
      role="img"
      aria-label={uptime === null ? "No history yet" : `${uptime}% up over 30 days`}
    >
      <title>{uptime === null ? "No history yet" : `${uptime}% up over 30 days`}</title>
      {history.map((day, index) => {
        // `probeCount === 0` is the no-data case and must stay visually distinct: the
        // ratios are 0 there too, so testing the ratios alone would paint a day nobody
        // measured the same as a day that was fully down.
        const downShare = day.degradedRatio + day.downRatio;
        const barX = index * barWidth;
        const width = Math.max(1, barWidth - 1);

        if (day.probeCount === 0) {
          // Hollow rather than filled: a shape difference from every measured day, not
          // just a different hue from the "up" green.
          return (
            <rect
              key={day.dayStart}
              x={barX}
              y={0}
              width={width}
              height={HEIGHT}
              fill="none"
              stroke="#94a3b8"
              strokeWidth={1}
            >
              <title>{dayLabel(day)}</title>
            </rect>
          );
        }

        const severe = downShare > 0.5;
        const fill = severe ? "#f43f5e" : downShare > 0 ? "#f59e0b" : "#10b981";
        // Full height for up, roughly two-thirds for degraded, roughly a quarter for
        // down — the bar gets visibly shorter as things get worse, on top of the colour.
        const height = severe ? HEIGHT * 0.25 : downShare > 0 ? HEIGHT * 0.65 : HEIGHT;
        return (
          <rect
            key={day.dayStart}
            x={barX}
            y={HEIGHT - height}
            width={width}
            height={height}
            fill={fill}
          >
            <title>{dayLabel(day)}</title>
          </rect>
        );
      })}
    </svg>
  );
}
