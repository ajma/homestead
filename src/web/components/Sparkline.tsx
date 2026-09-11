import type { DayBucket } from "@shared/launcher";

const WIDTH = 240;
const HEIGHT = 32;

/**
 * Hand-rolled SVG rather than a charting dependency: 30 bars is not worth 40 KB, and
 * the constraint for this phase is no new dependencies.
 *
 * A day with no checks renders as a full-height neutral bar, not a gap — an absent bar
 * and a healthy bar are indistinguishable at this size, and "no data" is information.
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
        const fill =
          day.probeCount === 0
            ? "#cbd5e1"
            : downShare > 0.5
              ? "#f43f5e"
              : downShare > 0
                ? "#f59e0b"
                : "#10b981";
        return (
          <rect
            key={day.dayStart}
            x={index * barWidth}
            y={0}
            width={Math.max(1, barWidth - 1)}
            height={HEIGHT}
            fill={fill}
          />
        );
      })}
    </svg>
  );
}
