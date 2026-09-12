import type { Role } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

/**
 * `GET /api/users`'s row shape (`publicUser` in `src/server/routes/users.ts`) — never a
 * password hash, and never per-user `appIds`: the list endpoint doesn't carry them
 * (only `GET /api/me` does, for the caller's own account, off `AuthContext`). A scope
 * editor for another user therefore has no way to learn which apps they're currently
 * scoped to from this list alone; see `UserManager`'s own comment on that gap.
 */
export type ManagedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  scopeAllApps: boolean;
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
