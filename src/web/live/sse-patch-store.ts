import type { LauncherApp } from "@shared/launcher";
import { rollUpProbes } from "@shared/status-phrase";
import type { AppStatus, FaultClass } from "@shared/types";

export type PendingPatch = {
  appId: string;
  status: AppStatus;
  faultClass: FaultClass | null;
  statusSince: number;
  patchedAt: number;
};

/**
 * SSE patches applied to the launcher cache, keyed by probe id.
 *
 * A launcher refetch that was already in flight when a transition landed reads the row
 * as it stood *before* the transition, and TanStack Query overwrites whatever the SSE
 * handler just wrote with that stale response the moment the fetch resolves — a real
 * green-tile-for-a-down-app race, not a hypothetical one, since `onOpen` invalidates on
 * every reconnect and the query is `refetchOnMount: "always"`.
 *
 * Two fixes were on the table: versioning each tile so a stale response can be detected
 * and discarded, or recording the patch here and re-applying it in the query's own
 * `queryFn` against anything the fetch could not yet have seen. This module takes the
 * second path — it needs no change to the server payload shape, and the merge lives
 * beside the one function (`rollUpProbes`) that already knows how to turn a patched
 * probe list back into a tile.
 */
const pending = new Map<string, PendingPatch>();

/** Called by `useEventStream` right after it patches the cache for one probe. */
export function recordPatch(probeId: string, patch: PendingPatch): void {
  pending.set(probeId, patch);
}

/**
 * Re-applies any patch the given fetch could not have seen, and drops any patch the
 * fetch is guaranteed to already reflect.
 *
 * `fetchStartedAt` — not the time the response arrived — is what a patch is compared
 * against: a patch recorded while the fetch was already in flight is exactly the one a
 * server read from *before* the transition cannot contain. A patch recorded before the
 * fetch even started is presumed already reflected in its response, so it is dropped
 * here rather than kept forever.
 */
export function applyPendingPatches(apps: LauncherApp[], fetchStartedAt: number): LauncherApp[] {
  if (pending.size === 0) return apps;

  let anyMutated = false;
  const next = apps.map((app) => {
    let appMutated = false;
    const probes = app.probes.map((probe) => {
      const patch = pending.get(probe.probeId);
      if (!patch || patch.appId !== app.id) return probe;
      if (patch.patchedAt < fetchStartedAt) {
        // This fetch started after the patch landed, so its response should already
        // carry it — the patch has done its job and would otherwise never be pruned.
        pending.delete(probe.probeId);
        return probe;
      }
      appMutated = true;
      anyMutated = true;
      return {
        ...probe,
        status: patch.status,
        faultClass: patch.faultClass,
        statusSince: patch.statusSince,
      };
    });
    if (!appMutated) return app;
    const { status, reason, since } = rollUpProbes(probes);
    return { ...app, probes, status, reason, since };
  });

  return anyMutated ? next : apps;
}

/** Test-only: clears every recorded patch so one test's timing cannot leak into another. */
export function clearPendingPatchesForTest(): void {
  pending.clear();
}
