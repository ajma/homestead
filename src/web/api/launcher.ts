import type { AppHealth, LauncherApp } from "@shared/launcher";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";
import { applyPendingPatches } from "@web/live/sse-patch-store";

export const launcherKey = ["launcher"] as const;
export const healthKey = (appId: string) => ["launcher", "health", appId] as const;

/**
 * A plain object, not just the hook below, so a test can drive this exact `queryFn`
 * through a real `QueryClient` without needing a mounted component.
 */
export function launcherQueryOptions() {
  return {
    queryKey: launcherKey,
    queryFn: async () => {
      // Captured before the request goes out, not after it resolves: a patch recorded
      // while this fetch was already in flight is exactly the one the response cannot
      // contain. See `sse-patch-store.ts`.
      const fetchStartedAt = Date.now();
      const { apps } = await apiFetch<{ apps: LauncherApp[] }>("/api/launcher");
      return applyPendingPatches(apps, fetchStartedAt);
    },
    // Spec: "Launcher renders from cached data first; stale status beats a spinner."
    // Live corrections arrive over SSE, so polling would only duplicate them.
    staleTime: 60_000,
    refetchOnMount: "always" as const,
  };
}

export function useLauncherApps() {
  return useQuery(launcherQueryOptions());
}

export function useAppHealth(appId: string | null) {
  return useQuery({
    queryKey: healthKey(appId ?? ""),
    enabled: appId !== null,
    queryFn: () => apiFetch<AppHealth>(`/api/launcher/${appId}/health`),
    staleTime: 30_000,
  });
}
