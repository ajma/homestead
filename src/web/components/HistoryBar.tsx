import type { HistoryBucket } from "@shared/monitoring.js";

function bucketClass(ratio: number | null): string {
  if (ratio === null) return "fill-muted";
  if (ratio === 1) return "fill-success";
  if (ratio === 0) return "fill-danger";
  return "fill-warning";
}

export function HistoryBar({ buckets }: { buckets: HistoryBucket[] }) {
  const width = 100;
  const height = 24;
  const barWidth = width / buckets.length;

  return (
    <svg
      role="img"
      aria-label="24-hour uptime history"
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-6"
      preserveAspectRatio="none"
    >
      {buckets.map((bucket, i) => (
        <rect
          key={bucket.startedAt}
          x={i * barWidth}
          y={0}
          width={barWidth}
          height={height}
          className={bucketClass(bucket.ratio)}
        />
      ))}
    </svg>
  );
}
