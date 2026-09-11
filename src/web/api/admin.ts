import type {
  ContainerSummary,
  ImageStatusRow,
  JobRow,
  ProbeRow,
  ScanResult,
} from "@shared/admin.js";
import type { AdminApp } from "@shared/dto";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

/**
 * Keyed separately from the launcher's `["launcher"]`.
 *
 * `/api/apps` computes a live rollup — one `listContainers` plus up to four concurrent
 * `docker compose config` spawns — while `/api/launcher` deliberately touches neither.
 * Sharing a cache key would let the expensive answer overwrite the cheap one, and the
 * launcher would start depending on Docker by accident, which is the single thing its
 * design exists to prevent.
 */
/**
 * `"list"` rather than bare `["admin", "apps"]`, because TanStack's `invalidateQueries`
 * matches by prefix unless told otherwise. `["admin", "apps"]` also matches
 * `["admin", "apps", <id>, "containers"]` and every other per-app subview, so
 * invalidating the list after adopting one app would force-refetch the containers, jobs,
 * images and probes of every app whose page happens to be open — several Docker round
 * trips for a change none of them saw.
 */
export const adminAppsKey = ["admin", "apps", "list"] as const;

/**
 * This one DOES prefix-match its own subviews, deliberately: `["admin", "apps", id]`
 * covers `["admin", "apps", id, "containers"]` and friends. After a lifecycle action on
 * an app, its containers really have changed, so one invalidation refreshing that app's
 * tabs is the behaviour we want.
 */
export const adminAppKey = (id: string) => ["admin", "apps", id] as const;
export const containersKey = (id: string) => ["admin", "apps", id, "containers"] as const;
export const jobsKey = (id: string) => ["admin", "apps", id, "jobs"] as const;
export const imagesKey = (id: string) => ["admin", "apps", id, "images"] as const;
export const probesKey = (id: string) => ["admin", "apps", id, "probes"] as const;
export const scanKey = ["admin", "scan"] as const;

export function useAdminApps() {
  return useQuery({
    queryKey: adminAppsKey,
    queryFn: () => apiFetch<AdminApp[]>("/api/apps"),
    staleTime: 15_000,
  });
}

export function useAdminApp(id: string | null) {
  return useQuery({
    queryKey: adminAppKey(id ?? ""),
    enabled: id !== null,
    queryFn: () => apiFetch<AdminApp>(`/api/apps/${id}`),
    staleTime: 15_000,
  });
}

function perApp<T>(key: readonly unknown[], id: string | null, path: string, staleTime: number) {
  return { queryKey: key, enabled: id !== null, queryFn: () => apiFetch<T>(path), staleTime };
}

export function useContainers(id: string | null) {
  return useQuery(
    perApp<ContainerSummary[]>(containersKey(id ?? ""), id, `/api/apps/${id}/containers`, 5_000),
  );
}

export function useJobs(id: string | null) {
  return useQuery(perApp<JobRow[]>(jobsKey(id ?? ""), id, `/api/apps/${id}/jobs`, 5_000));
}

export function useImages(id: string | null) {
  return useQuery(
    perApp<ImageStatusRow[]>(imagesKey(id ?? ""), id, `/api/apps/${id}/images`, 60_000),
  );
}

export function useProbes(id: string | null) {
  return useQuery(perApp<ProbeRow[]>(probesKey(id ?? ""), id, `/api/apps/${id}/probes`, 15_000));
}

export function useScan(enabled: boolean) {
  return useQuery({
    queryKey: scanKey,
    enabled,
    // The scan walks the whole compose root and lists every container on the host.
    // Gated so opening the inventory does not pay for a dialog nobody opened.
    queryFn: () => apiFetch<ScanResult>("/api/apps/scan"),
    staleTime: 0,
    gcTime: 0,
  });
}
