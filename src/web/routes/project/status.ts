import type { ContainerState } from "@shared/projects.js";
import type { State } from "../../components/ui/index.js";

/**
 * Docker's state vocabulary, narrowed to the four tints `StatusDot` can draw.
 *
 * `ContainerState.state` is whatever the daemon reports — `created`, `paused`,
 * `dead` and `removing` all exist beyond the four below — so the map is
 * explicit and everything else falls back to `unknown`. Indexing a partial
 * record either yields `undefined` and renders an unstyled dot, or silently
 * borrows a neighbouring key's colour and paints a dead container the same
 * green as a healthy one, which defeats the entire point of the indicator.
 */
const KNOWN: Record<string, State> = {
  running: "running",
  exited: "exited",
  restarting: "restarting",
};

export function dockerStateToStatus(state: string): State {
  return KNOWN[state] ?? "unknown";
}

/** One dot for a whole stack, and the words that go beside it. */
export function projectStatus(states: ContainerState[]): {
  state: State;
  label: string;
} {
  if (states.length === 0) return { state: "unknown", label: "No containers" };

  const mapped = states.map((s) => dockerStateToStatus(s.state));
  if (mapped.includes("restarting"))
    return { state: "restarting", label: "Restarting" };
  if (mapped.every((s) => s === "running"))
    return { state: "running", label: "Running" };
  if (mapped.some((s) => s === "running"))
    // Never rounded up to "Running": that is how a user concludes the stack is
    // fine while the one container that matters has exited.
    return { state: "unknown", label: "Partially running" };
  return { state: "exited", label: "Stopped" };
}

/** How long an operation took, in the units a person reads at a glance. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
