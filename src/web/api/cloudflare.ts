import type { CloudflareFault, CloudflareStatus, CloudflareZone } from "@shared/cloudflare.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";

/**
 * `"status"`/`"list"` leaves, not bare `["cloudflare", "credentials"]` and
 * `["cloudflare", "zones"]` — `adminAppsKey`'s lesson from Phase 1E (`src/web/api/
 * admin.ts`) is that TanStack's `invalidateQueries` matches by prefix, so a key one
 * segment too short can reach further than intended the moment a sibling appears under
 * the same parent. Neither of these two has a sibling today, but naming them the same
 * way `adminAppsKey` now is means the next Cloudflare query added under `["cloudflare",
 * "credentials", ...]` (a scheduled tunnel status, say) can't be swept up by an
 * invalidation aimed only at this status.
 */
export const cloudflareStatusKey = ["cloudflare", "credentials", "status"] as const;
export const cloudflareZonesKey = ["cloudflare", "zones", "list"] as const;

export function useCloudflareStatus() {
  return useQuery({
    queryKey: cloudflareStatusKey,
    queryFn: () => apiFetch<CloudflareStatus>("/api/cloudflare/credentials"),
  });
}

/**
 * `enabled` is passed by the caller rather than derived in here from a second read of
 * `useCloudflareStatus`, so `CloudflarePanel` — which already has that query's result —
 * stays the single place deciding "configured" for both the status view and this one,
 * rather than two independent reads of the same cache entry drifting during a refetch.
 */
export function useCloudflareZones(enabled: boolean) {
  return useQuery({
    queryKey: cloudflareZonesKey,
    queryFn: () => apiFetch<CloudflareZone[]>("/api/cloudflare/zones"),
    enabled,
  });
}

/**
 * The PUT route's 422 body is `{ error: "verification_failed", fault }` (`src/server/
 * routes/cloudflare.ts`) — no human-readable message, just the slug a `CloudflareFault`
 * enumerates. `null` for anything else (a timeout, a network failure, a differently
 * shaped error body) so `describeCloudflareError` below can fall back to its own
 * generic handling instead of mis-rendering `undefined`.
 */
function cloudflareFaultOf(error: unknown): CloudflareFault | null {
  if (!(error instanceof ApiError)) return null;
  if (error.body === null || typeof error.body !== "object") return null;
  if (!("fault" in error.body)) return null;
  return (error.body as { fault: unknown }).fault as CloudflareFault;
}

/**
 * One sentence per `CloudflareFault`. `permission` and `auth` both describe the token
 * itself — Cloudflare's `listZones` check (see `routes/cloudflare.ts`) proves the token
 * is live and carries Zone:Read, nothing about the account id, so neither message
 * points at the account id field; a typo there either resolves to a different (but
 * still valid-looking) account or fails the same way a bad token would, and the fault
 * Cloudflare hands back cannot tell those apart.
 */
const FAULT_MESSAGES: Record<CloudflareFault, string> = {
  auth: "That token was rejected. Check it hasn't been mistyped or revoked.",
  permission: "That token does not have the Zone:Read permission this check requires.",
  rate_limit: "Cloudflare is rate-limiting these requests right now. Wait a moment and try again.",
  network: "Could not reach Cloudflare. Check the network and try again.",
  cloudflare: "Cloudflare returned an unexpected error. Try again shortly.",
  client: "Cloudflare rejected this request as invalid.",
};

const TIMEOUT_MESSAGE =
  "The server did not respond. It may still be working; check again in a moment.";

/** Mirrors `UserManager`'s `describeUserError` and `StepCreateAdmin`'s `errorMessage`:
 * a `CloudflareFault` wins first since it is the one error shape this route promises,
 * then the generic timeout/network/fallback ladder every other admin form already uses. */
export function describeCloudflareError(error: unknown, fallback: string): string {
  const fault = cloudflareFaultOf(error);
  if (fault) return FAULT_MESSAGES[fault];
  if (error instanceof ApiTimeoutError) return TIMEOUT_MESSAGE;
  if (!(error instanceof ApiError)) {
    return "Could not reach the server. Check the network and try again.";
  }
  return fallback;
}

/**
 * Deliberately NOT `useMutation`. `useMutation` stores whatever is passed to `mutate()`
 * as `state.variables` on the `Mutation` object it tracks inside the `QueryClient`'s
 * `MutationCache` — and `src/web/App.tsx`'s `QueryClient` is an app-wide singleton with
 * the default 5-minute `gcTime`. A `{ token, accountId }` variables object would sit
 * there in plaintext, reachable via `queryClient.getMutationCache()`, on success AND on
 * failure, surviving this panel's unmount for five minutes. That is Phase 1F's defect
 * (raw `.env` values left in the query cache) recurring one layer down — the mutation
 * cache, not the query cache — which is exactly why `EnvTab`'s reveal and save
 * (`src/web/routes/edit/EnvTab.tsx`) already bypass `useMutation` for the same reason:
 * "there is nothing here worth caching". A plain `apiFetch` call has no cache to leak
 * into at all.
 *
 * `PUT /api/cloudflare/credentials` returns the freshly-verified `CloudflareStatus`, so a
 * success here writes straight into `cloudflareStatusKey`'s cache — the same
 * write-the-response-back shape `useCompleteStep` and `useFinishSetup` use via
 * `useMutation`'s `onSuccess`, done here by hand instead. The token itself is never part
 * of that written result: `CloudflareStatus` carries only `tokenHint`.
 *
 * `cloudflareZonesKey` is invalidated, not written directly: this call's own response
 * never carries zones, only `CloudflarePanel`'s separate `useCloudflareZones` fetch does,
 * and a stale or absent zones list left over from before this save would be a lie the
 * moment the panel calls this "configured" for a different account.
 */
export function useSaveCloudflareCredentials() {
  const queryClient = useQueryClient();
  return async function saveCloudflareCredentials(payload: {
    token: string;
    accountId: string;
  }): Promise<CloudflareStatus> {
    const status = await apiFetch<CloudflareStatus>("/api/cloudflare/credentials", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    queryClient.setQueryData(cloudflareStatusKey, status);
    queryClient.invalidateQueries({ queryKey: cloudflareZonesKey });
    return status;
  };
}

/** `DELETE /api/cloudflare/credentials` answers 204 with no body, so unlike the save
 * above there is no fresh status to write back — the `{ configured: false }` written
 * here is known, not fetched, and `cloudflareZonesKey` is removed outright (not merely
 * invalidated) so a background refetch cannot repopulate a zones list for credentials
 * that no longer exist. */
export function useDeleteCloudflareCredentials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<null>("/api/cloudflare/credentials", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<CloudflareStatus>(cloudflareStatusKey, { configured: false });
      queryClient.removeQueries({ queryKey: cloudflareZonesKey });
    },
  });
}
