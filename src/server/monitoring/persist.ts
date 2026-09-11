import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Db } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
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

  // A route's transaction (probe adoption is one) can win the same instant the scheduler
  // opens this one — see `db/retry.ts`. A retry here is cheaper than losing the sample.
  await retryOnBusy(() =>
    db.transaction(async (tx) => {
      // The SAMPLE records what was OBSERVED, not the debounced status.
      //
      // Spec §3 calls `check_results` "every sample", and that is what makes 48 hours of
      // raw data worth keeping: a probe flapping fail/recover/fail/recover never confirms
      // a transition, so storing the held status would record it as uninterrupted `up`
      // and uptime would read 100% for an app failing every other minute. The debounced
      // view — the one the launcher shows — lives on the probe row below.
      //
      // A consequence worth knowing: a deploy's grace window shows `starting` on the
      // probe row while the samples record the `down` that was actually observed, so a
      // restart does count against uptime. That is honest — the app was unreachable —
      // and the rollup has only up/degraded/down buckets, so there is nowhere to put
      // `starting`.
      await tx.insert(checkResults).values({
        id: ulid(),
        probeId: probe.id,
        status: result.status,
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
    }),
  );

  // `transition.changed` alone drives `statusSince` above and is left untouched. But a
  // fault class can move — the docker probe going from "containers not running" (app) to
  // "Docker is unreachable" (network) — with the debounced status staying `down` the
  // whole time. That is a different machine to go and look at, so it has to publish even
  // though the status itself did not change. `changed` here is therefore "publish-worthy",
  // not "status changed" — the meaning `EventBus.publish` and the scheduler's listener
  // loop actually consume it for.
  const faultClassChanged = (result.faultClass ?? null) !== (probe.lastFaultClass ?? null);

  return {
    probeId: probe.id,
    appId: probe.appId,
    status: transition.status,
    faultClass: result.faultClass ?? null,
    changed: transition.changed || faultClassChanged,
  };
}
