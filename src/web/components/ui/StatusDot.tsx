import type { HTMLAttributes } from "react";

type State = "running" | "exited" | "restarting" | "unknown";

const STATE_STYLES: Record<State, string> = {
  running: "bg-success",
  exited: "bg-muted",
  restarting: "bg-warning",
  unknown: "bg-muted",
};

export function StatusDot({
  state,
  label,
  className = "",
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  state: State;
  label?: string;
}) {
  const displayText = label ?? state;
  return (
    <span
      className={`inline-flex items-center gap-2 text-sm ${className}`}
      {...rest}
    >
      <span
        className={`w-2 h-2 rounded-full ${STATE_STYLES[state]}`}
        aria-hidden="true"
      />
      <span className="text-text">{displayText}</span>
    </span>
  );
}
