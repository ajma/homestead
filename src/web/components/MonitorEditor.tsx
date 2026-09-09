import type { MonitorSummary } from "@shared/monitoring.js";
import { monitorLabel } from "../lib/monitor-labels.js";
import { IconButton, StatusDot } from "./ui/index.js";

type MonitorEditorProps = {
  monitors: MonitorSummary[];
  onToggleRequired: (id: string, required: boolean) => void;
  onDelete: (id: string) => void;
};

function formatRelativeTime(timestamp: number | null): string {
  if (timestamp === null) return "never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function MonitorEditor({
  monitors,
  onToggleRequired,
  onDelete,
}: MonitorEditorProps) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {monitors.map((monitor) => (
        <li
          key={monitor.id}
          className="flex min-h-11 items-center gap-3 px-4 py-2"
        >
          <StatusDot state={monitor.state} />
          <span className="flex-1 text-sm font-medium">
            {monitorLabel(monitor.type)}
          </span>
          <span className="text-xs text-muted">
            {formatRelativeTime(monitor.lastCheckedAt)}
          </span>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={monitor.required}
              onChange={(e) => onToggleRequired(monitor.id, e.target.checked)}
              aria-label="Required"
              className="h-11 w-11"
            />
            Required
          </label>
          <IconButton
            onClick={() => onDelete(monitor.id)}
            label="Delete"
            className="h-11 w-11"
          >
            ✕
          </IconButton>
        </li>
      ))}
    </ul>
  );
}
