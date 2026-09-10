import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Db } from "../db/client.js";
import { checkResults, probes } from "../db/schema.js";
import { applyTransition } from "./transition.js";
import type { ProbeResult, ProbeRow } from "./types.js";

export type PersistedTransition = {
  probeId: string;
  appId: string;
  status: "up" | "degraded" | "down" | "starting" | "unknown";
  faultClass: "app" | "network" | "config" | null;
  changed: boolean;
};

/**
 * Writes the sample and the denormalised copy on the probe row **together**.
 *
 * The launcher reads the denormalised columns with one indexed query and no aggregation.
 * That is only safe because exactly one writer — the scheduler — maintains them, and
 * because these two writes cannot separate: a sample without its rollup, or a rollup
 * without its sample, is a status the timeline cannot explain.
 */
export async function persistResult(
  db: Db,
  probe: ProbeRow,
  result: ProbeResult,
  opts: { now: number; graceUntil: number | null; failureThreshold: number },
): Promise<PersistedTransition> {
  const transition = applyTransition({
    state: {
      lastStatus: probe.lastStatus,
      consecutiveFailures: probe.consecutiveFailures,
      statusSince: probe.statusSince,
    },
    observed: result.status,
    now: opts.now,
    graceUntil: opts.graceUntil,
    failureThreshold: opts.failureThreshold,
  });

  await db.transaction(async (tx) => {
    await tx.insert(checkResults).values({
      id: ulid(),
      probeId: probe.id,
      status: transition.status,
      faultClass: result.faultClass ?? null,
      latencyMs: result.latencyMs ?? null,
      detail: result.detail ?? null,
      checkedAt: opts.now,
    });

    await tx
      .update(probes)
      .set({
        lastStatus: transition.status,
        lastLatencyMs: result.latencyMs ?? null,
        lastDetail: result.detail ?? null,
        lastFaultClass: result.faultClass ?? null,
        lastCheckedAt: opts.now,
        statusSince: transition.statusSince,
        consecutiveFailures: transition.consecutiveFailures,
      })
      .where(eq(probes.id, probe.id));
  });

  return {
    probeId: probe.id,
    appId: probe.appId,
    status: transition.status,
    faultClass: result.faultClass ?? null,
    changed: transition.changed,
  };
}
