import type { StatusDeps } from "../apps/status-for.js";
import type { apps, probes } from "../db/schema.js";
import type { ContainerSummary } from "../host/types.js";

export type ProbeRow = typeof probes.$inferSelect;
export type AppRow = typeof apps.$inferSelect;

export type ProbeResult = {
  status: "up" | "degraded" | "down";
  latencyMs?: number;
  detail?: Record<string, unknown>;
  faultClass?: "app" | "network" | "config";
};

export type ProbeContext = {
  app: AppRow;
  /**
   * Every container on the host, or `null` when the Engine API call failed.
   *
   * `null` and `[]` are different answers and must stay different: an empty host means
   * nothing is running, a failed call means we do not know, and blaming the user's stack
   * for a broken socket is how a monitoring system loses trust.
   */
  containers: ContainerSummary[] | null;
  deps: StatusDeps;
};

export interface ProbeRunner {
  kind: ProbeRow["kind"];
  run(probe: ProbeRow, ctx: ProbeContext): Promise<ProbeResult>;
}
