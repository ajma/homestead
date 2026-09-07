import type { MonitorType, TargetStatus } from "@shared/monitoring.js";

export type MonitorLatest = {
  id: string;
  type: MonitorType;
  required: boolean;
  enabled: boolean;
  up: boolean | null;
  error: string | null;
  at: number | null;
};

export function resolveStatus(monitors: MonitorLatest[]): TargetStatus {
  // Filter to enabled monitors only — a disabled monitor is invisible
  const enabled = monitors.filter((m) => m.enabled);

  // Get only required monitors for gating logic
  const required = enabled.filter((m) => m.required);

  // No required monitors (either none enabled, or all are advisory) -> unknown
  if (required.length === 0) {
    return { state: "unknown", reason: null };
  }

  // Precedence: down > unknown > up
  // Check for any down required monitor first
  for (const mon of required) {
    if (mon.up === false) {
      // Reason names the first failing monitor (in input order)
      const reason = mon.error ? `${mon.type}: ${mon.error}` : mon.type;
      return { state: "down", reason };
    }
  }

  // Check if any required monitor hasn't reported yet (up: null)
  for (const mon of required) {
    if (mon.up === null) {
      return { state: "unknown", reason: null };
    }
  }

  // All required monitors are up
  return { state: "up", reason: null };
}
