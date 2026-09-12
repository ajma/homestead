import type { HostCheck, SetupState, SetupStep } from "@shared/setup.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";

/**
 * `GET /api/setup/state` is admin-only with one carve-out: before any administrator
 * exists, nobody could ever pass that check, so the route relaxes for exactly that
 * window (see `src/server/routes/setup.ts`). A viewer hitting this after an admin
 * exists gets a 403 that has nothing to do with anything they're allowed to see — so
 * callers who know they're a viewer should pass `enabled: false` rather than let that
 * 403 surface as a spurious "setup unavailable" screen. `App.tsx`'s guard does exactly
 * that.
 */
export const setupStateKey = ["setup-state"] as const;

export function useSetupState(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: setupStateKey,
    queryFn: () => apiFetch<SetupState>("/api/setup/state"),
    enabled: options.enabled ?? true,
  });
}

/**
 * `POST /api/setup/state/:step/complete` hands back the freshly-read state, so a
 * success here writes straight into the cache rather than triggering a second round
 * trip through `invalidateQueries` — the wizard's next render sees the new step
 * immediately.
 *
 * Not how `admin` gets marked done: that step is derived server-side from whether a
 * user exists (see `src/shared/setup.ts`), never recorded through this endpoint. A
 * caller that just created the first admin should refetch `useSetupState` instead.
 *
 * `preflightOverride` is optional and only meaningful for the `host` step: it tells the
 * server the failing `HostCheck.preflight` the user actually saw on screen when they
 * chose to continue anyway, so it can leave a breadcrumb (`src/server/routes/setup.ts`)
 * instead of the completion looking identical to a clean pass. Omitted entirely for
 * every other step, and for `host` when the preflight was passing.
 */
export function useCompleteStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { step: SetupStep; preflightOverride?: { reason: string } }) =>
      apiFetch<SetupState>(`/api/setup/state/${variables.step}/complete`, {
        method: "POST",
        ...(variables.preflightOverride
          ? { body: JSON.stringify({ preflightOverride: variables.preflightOverride }) }
          : {}),
      }),
    onSuccess: (state) => queryClient.setQueryData(setupStateKey, state),
  });
}

/** `POST /api/setup/finish` is one-way — calling it twice cannot move `completedAt` —
 * and, like `useCompleteStep`, returns the state it just wrote. */
export function useFinishSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SetupState>("/api/setup/finish", { method: "POST" }),
    onSuccess: (state) => queryClient.setQueryData(setupStateKey, state),
  });
}

export const hostCheckKey = ["setup-host-check"] as const;

/**
 * `GET /api/setup/host-check` runs a real container for the mount preflight — the same
 * cost the route itself serialises server-side (see `src/server/routes/setup.ts`'s
 * `runPreflightOnce`). `staleTime`/`gcTime` at 0 so the step's re-check button, which
 * calls `refetch()`, always gets a genuinely fresh answer rather than a cached one from
 * before the user went and fixed their bind mount.
 */
export function useHostCheck() {
  return useQuery({
    queryKey: hostCheckKey,
    queryFn: () => apiFetch<HostCheck>("/api/setup/host-check"),
    staleTime: 0,
    gcTime: 0,
  });
}
