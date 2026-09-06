import type { HTMLAttributes } from "react";

/**
 * The closed set of tints this dot can draw. Exported so that anything mapping
 * a free-form Docker state into it is checked by the compiler rather than
 * guessing at strings.
 */
export type State = "running" | "exited" | "restarting" | "unknown";

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
      {/* No colour of its own: the dot carries the state, and the label takes
          the colour of the row it sits in — a muted row stays muted. */}
      <span>{displayText}</span>
    </span>
  );
}
