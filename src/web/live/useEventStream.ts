import type { AdminApp, ViewerApp } from "@shared/dto";
import type { LauncherApp } from "@shared/launcher";
import { rollUpProbes } from "@shared/status-phrase";
import type { AppStatus, FaultClass } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { adminAppKey, adminAppsKey } from "@web/api/admin";
import { healthKey, launcherKey } from "@web/api/launcher";
import { recordPatch } from "@web/live/sse-patch-store";
import { useEffect } from "react";

export type StatusEvent = {
  appId: string;
  probeId: string;
  status: AppStatus;
  faultClass: FaultClass | null;
};

export type AppChangedEvent = { appId: string };

/**
 * Backoff for a reconnect this hook initiates itself (see the `error` handler below).
 * 1s to start, so a blip recovers fast; capped at 30s so a client that keeps getting a
 * fatal response (a 429, say) is not hammering the server ten times a second.
 */
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * One `EventSource` for the whole app, mounted at the shell.
 *
 * Events roll into the cached tile through `rollUpProbes` — the exact function the server
 * uses to build the tile in the first place — rather than being written straight onto the
 * tile. An event names one probe; a tile shows the worst of all of an app's probes. Writing
 * the event's status directly overwrote whatever the other probes were saying, so one probe
 * recovering could paint a tile green while a sibling was still down. Rolling up from the
 * tile's own `probes` array is what makes that structurally impossible instead of something
 * tests have to keep chasing.
 *
 * An event whose `probeId` is not found among the tile's probes means a probe was added
 * since the list was last fetched. The event does not carry `kind`, so there is no way to
 * build a correct `ProbeSnapshot` for it — invalidating the launcher query is the honest
 * response, not a guess.
 *
 * `open` and `error` are both handled, because a reconnect is the normal path here, not an
 * edge case: the server caps every stream at 15 minutes and closes a user's streams outright
 * on a role/scope change. `EventBus.publish` only fires on a change, so a transition that
 * happens during the reconnect gap is never replayed — the fix is to invalidate the launcher
 * query on every `open` after the first, so a reconnect resynchronises whatever was missed.
 * And some server responses (401, or the 429 for too many concurrent streams) are fatal to
 * `EventSource` per spec: the browser will not retry on its own. When `readyState` reports
 * `CLOSED`, this hook closes the dead source and opens a new one itself, after a backoff.
 */
export function useEventStream(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = INITIAL_BACKOFF_MS;
    let hasOpenedOnce = false;

    const onStatus = (event: MessageEvent) => {
      let payload: StatusEvent;
      try {
        payload = JSON.parse(event.data as string) as StatusEvent;
      } catch {
        // A malformed frame is not a reason to drop a working stream.
        return;
      }
      if (typeof payload?.appId !== "string") return;

      let matchedTile = false;
      let sawUnknownProbe = false;
      const nowMs = Date.now();
      const statusSince = Math.floor(nowMs / 1000);

      queryClient.setQueryData<LauncherApp[]>(launcherKey, (current) => {
        if (!current) return current;
        let changed = false;
        const next = current.map((tile) => {
          if (tile.id !== payload.appId) return tile;
          matchedTile = true;
          const index = tile.probes.findIndex((p) => p.probeId === payload.probeId);
          if (index === -1) {
            // Reported below, outside setQueryData: a probe the tile doesn't know about
            // yet. Leave the tile untouched rather than fabricate a snapshot with a
            // guessed `kind`.
            sawUnknownProbe = true;
            return tile;
          }
          changed = true;
          const probes = tile.probes.map((probe, i) =>
            i === index
              ? {
                  ...probe,
                  status: payload.status,
                  faultClass: payload.faultClass,
                  // Only the probe the event is about moves. The others keep the
                  // `statusSince` they already had, so the app's own `since` — taken
                  // from whichever probe `rollUpProbes` finds worst — only moves when
                  // the worst probe itself changes, not whenever any probe reports.
                  statusSince,
                }
              : probe,
          );
          const { status, reason, since } = rollUpProbes(probes);
          return { ...tile, probes, status, reason, since };
        });
        // Returning a new array when nothing matched would re-render every tile.
        return changed ? next : current;
      });

      // The inventory's own cache, patched directly rather than invalidated — the same
      // reasoning `sse-patch-store.ts` explains for the launcher, applied to
      // `adminAppsKey` (Important 2 of the 1E final-fix brief). Unlike a launcher tile,
      // an `AdminApp`/`ViewerApp` row carries one scalar `status`, not a `probes` array
      // to roll up — there is nothing here to combine this probe's verdict with a
      // sibling probe's, so a multi-probe app's row shows THIS probe's status, not
      // necessarily the worst of all of them. That is the debounced status, not the live
      // Docker rollup `GET /api/apps` computes; the two agree once Important 1 (grace)
      // is fixed, in the case that actually matters — an app that just started a deploy.
      // `statusDetail` is cleared rather than left stale: the row's specific reason text
      // (e.g. "0/1 services up, 1 missing") would otherwise describe the status this
      // patch just overwrote, and the fallback wording in `AdminApps.tsx`/`EditApp.tsx`
      // covers a null detail already.
      queryClient.setQueryData<Array<AdminApp | ViewerApp>>(adminAppsKey, (current) => {
        if (!current) return current;
        let changed = false;
        const next = current.map((row) => {
          if (row.id !== payload.appId) return row;
          changed = true;
          return { ...row, status: payload.status, statusDetail: null };
        });
        return changed ? next : current;
      });

      if (!matchedTile) {
        // An app the launcher's cache does not know about at all yet — most commonly one
        // created in another tab (`POST /api/apps` is new in 1E) whose first probe result
        // just published. This cannot loop: invalidating only triggers one refetch of the
        // launcher query, which does not itself dispatch a `status` event back into this
        // handler. See the 1D carry-forward item 2 / the 1E final-fix brief, Important 6.
        void queryClient.invalidateQueries({ queryKey: launcherKey });
      } else if (sawUnknownProbe) {
        void queryClient.invalidateQueries({ queryKey: launcherKey });
      } else {
        // Record the patch so a launcher refetch already in flight — one whose server
        // read predates this transition — cannot silently overwrite it when it resolves.
        // See `sse-patch-store.ts`.
        recordPatch(payload.probeId, {
          appId: payload.appId,
          status: payload.status,
          faultClass: payload.faultClass,
          statusSince,
          patchedAt: nowMs,
        });
      }

      // The open health panel, if any, is now stale. Invalidating one key is cheap and
      // only refetches while a panel is actually mounted.
      void queryClient.invalidateQueries({ queryKey: healthKey(payload.appId) });
    };

    /**
     * A probe was created, deleted, or had `enabled` flipped — not a status transition,
     * which is why it arrives on its own event name rather than through `onStatus`.
     *
     * Invalidating rather than patching is deliberate, unlike `onStatus` above: the probe
     * *set* changed, so the cached `ProbeSnapshot[]` this tile's roll-up was built from is
     * no longer a sound basis for one — precisely the shape of bug this event exists to
     * close (see `probes.ts` and `EventBus.publishAppChanged`). `adminAppKey` is
     * invalidated too, so an open edit page's probes tab (fetched separately, under
     * `probesKey`, which `adminAppKey` prefix-matches) refetches instead of showing a
     * probe that was just deleted from another tab.
     */
    const onAppChanged = (event: MessageEvent) => {
      let payload: AppChangedEvent;
      try {
        payload = JSON.parse(event.data as string) as AppChangedEvent;
      } catch {
        // A malformed frame is not a reason to drop a working stream.
        return;
      }
      if (typeof payload?.appId !== "string") return;

      void queryClient.invalidateQueries({ queryKey: launcherKey });
      void queryClient.invalidateQueries({ queryKey: adminAppKey(payload.appId) });
    };

    const onOpen = () => {
      backoff = INITIAL_BACKOFF_MS;
      if (!hasOpenedOnce) {
        // The query has just loaded; refetching again immediately is wasted work.
        hasOpenedOnce = true;
        return;
      }
      // A reconnect — whether the browser's own retry or ours below — means some gap of
      // unknown length just passed during which transitions could have been missed.
      // Resynchronise from the server rather than trust whatever the cache still shows.
      void queryClient.invalidateQueries({ queryKey: launcherKey });
    };

    const onError = () => {
      // `CONNECTING` means the browser intends to retry this same connection itself;
      // nothing to do. `CLOSED` means it has given up for good — a 401 or the 429 for
      // too many concurrent streams are both "fail the connection" per spec — and only
      // reconnecting ourselves will bring the stream back.
      if (source.readyState !== EventSource.CLOSED) return;
      teardownSource();
      const delay = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    function teardownSource() {
      source.removeEventListener("status", onStatus);
      source.removeEventListener("app-changed", onAppChanged);
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.close();
    }

    function connect() {
      source = new EventSource("/api/events");
      source.addEventListener("status", onStatus);
      source.addEventListener("app-changed", onAppChanged);
      source.addEventListener("open", onOpen);
      source.addEventListener("error", onError);
    }

    connect();

    return () => {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      teardownSource();
    };
  }, [queryClient]);
}
