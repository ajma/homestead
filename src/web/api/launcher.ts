import type { AppHealth, LauncherApp } from "@shared/launcher";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

export const launcherKey = ["launcher"] as const;
export const healthKey = (appId: string) => ["launcher", "health", appId] as const;

export function useLauncherApps() {
  return useQuery({
    queryKey: launcherKey,
    queryFn: async () => (await apiFetch<{ apps: LauncherApp[] }>("/api/launcher")).apps,
    // Spec: "Launcher renders from cached data first; stale status beats a spinner."
    // Live corrections arrive over SSE, so polling would only duplicate them.
    staleTime: 60_000,
    refetchOnMount: "always",
  });
}

export function useAppHealth(appId: string | null) {
  return useQuery({
    queryKey: healthKey(appId ?? ""),
    enabled: appId !== null,
    queryFn: () => apiFetch<AppHealth>(`/api/launcher/${appId}/health`),
    staleTime: 30_000,
  });
}
