import type { Role } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@web/api/client";

export type Me = {
  id: string;
  email: string;
  name: string;
  role: Role;
  scopeAllApps: boolean;
  appIds: string[];
};

export function useSession() {
  return useQuery({
    queryKey: ["me"],
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await apiFetch<Me>("/api/me");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
}

export function useSetupStatus() {
  return useQuery({
    queryKey: ["setup-status"],
    queryFn: () => apiFetch<{ needsSetup: boolean }>("/api/setup/status"),
  });
}
