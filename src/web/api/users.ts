import type { Role } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

/**
 * `GET /api/users`'s row shape (`publicUser` plus `appIds` in
 * `src/server/routes/users.ts`) — never a password hash. `appIds` comes from a second,
 * whole-list query over `user_app_scope` grouped by user, so `EditScopeDialog` can
 * pre-select what a user is currently scoped to instead of opening blank.
 */
export type ManagedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  scopeAllApps: boolean;
  appIds: string[];
  disabledAt: number | null;
  createdAt: number;
};

/**
 * `"list"` for the same reason `adminAppsKey` carries one (`src/web/api/admin.ts`):
 * leaves room for a per-user subview key like `["admin", "users", id]` later without an
 * `invalidateQueries` on this key accidentally sweeping it up too.
 */
export const usersKey = ["admin", "users", "list"] as const;

export function useUsers() {
  return useQuery({
    queryKey: usersKey,
    queryFn: () => apiFetch<ManagedUser[]>("/api/users"),
    staleTime: 15_000,
  });
}
