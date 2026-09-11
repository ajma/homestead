import type { LauncherApp } from "@shared/launcher";
import type { AppStatus, FaultClass } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { healthKey, launcherKey } from "@web/api/launcher";
import { useEffect } from "react";

export type StatusEvent = {
  appId: string;
  probeId: string;
  status: AppStatus;
  faultClass: FaultClass | null;
};

/** Mirrors the server's phrases. Kept small deliberately — see the note below. */
function reasonFor(status: AppStatus, faultClass: FaultClass | null): string {
  if (status === "up") return "Healthy";
  if (status === "starting") return "Starting";
  if (status === "unknown") return "Not checked yet";
  if (faultClass === "config") return "Compose config invalid";
  if (faultClass === "network") return "Unreachable";
  return "Containers not running";
}

/**
 * One `EventSource` for the whole app, mounted at the shell.
 *
 * Events patch the cached tile with `setQueryData` rather than invalidating it. Twenty
 * apps flapping during a `docker compose up` would otherwise fire twenty refetches at a
 * machine that is by definition busy at that moment — which is why the event payload is
 * self-sufficient rather than an ID to look up.
 *
 * The phrase is recomputed here from `{status, faultClass}` alone, so it can be
 * marginally less specific than the server's — the event does not say which probe kind
 * fired, so "Tunnel unreachable — app is fine" cannot be derived. The health panel and
 * the next full fetch both carry the precise phrase. Widening the SSE payload to fix
 * this is a server change, not a client one; do not add a second fetch here to
 * compensate, because avoiding exactly that is the reason this design exists.
 */
export function useEventStream(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource("/api/events");

    const onStatus = (event: MessageEvent) => {
      let payload: StatusEvent;
      try {
        payload = JSON.parse(event.data as string) as StatusEvent;
      } catch {
        // A malformed frame is not a reason to drop a working stream.
        return;
      }
      if (typeof payload?.appId !== "string") return;

      queryClient.setQueryData<LauncherApp[]>(launcherKey, (current) => {
        if (!current) return current;
        let changed = false;
        const next = current.map((tile) => {
          if (tile.id !== payload.appId) return tile;
          changed = true;
          return {
            ...tile,
            status: payload.status,
            reason: reasonFor(payload.status, payload.faultClass),
            since: Math.floor(Date.now() / 1000),
          };
        });
        // Returning a new array when nothing matched would re-render every tile.
        return changed ? next : current;
      });

      // The open health panel, if any, is now stale. Invalidating one key is cheap and
      // only refetches while a panel is actually mounted.
      void queryClient.invalidateQueries({ queryKey: healthKey(payload.appId) });
    };

    source.addEventListener("status", onStatus);
    return () => {
      source.removeEventListener("status", onStatus);
      source.close();
    };
  }, [queryClient]);
}
