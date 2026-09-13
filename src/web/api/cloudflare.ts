import {
  type AccessConfigStatus,
  type AppExposureStatus,
  type CloudflareFault,
  type CloudflareStatus,
  type CloudflareZone,
  type MonitorAccessStatus,
  TUNNEL_PROVISION_TIMEOUT_MS,
  type TunnelStatus,
} from "@shared/cloudflare.js";
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

/** Own leaf under `["cloudflare", ...]`, not folded into `cloudflareStatusKey` — same
 * prefix-matching reasoning as that key's own doc comment: a tunnel's status and the
 * credentials' status are refetched on different triggers (this one also polls — see
 * `useCloudflareTunnel` below — the credentials status never does) and must not share an
 * `invalidateQueries` blast radius. */
export const cloudflareTunnelKey = ["cloudflare", "tunnel", "status"] as const;

/**
 * `GET /api/cloudflare/tunnel`. Unconditional, unlike `useCloudflareZones` (no `enabled`
 * flag gated on credentials being configured): a tunnel record can outlive the
 * credentials that created it (an admin could remove credentials after provisioning), and
 * the "no credentials, don't offer Provision" case still needs to know whether a tunnel
 * already exists, not just that credentials are missing.
 *
 * Polls every 5s **only** while `runningJobId` is non-null in the last-known data — the
 * one fact this tab has no other way to learn (the job's `appId` is `null`, so it is
 * invisible to every app-scoped job listing `useAppActions` could otherwise poll). This is
 * what lets a page reloaded mid-provision, or a second admin's tab, notice a sequence
 * someone else started without a manual refresh; a tab that started the job itself learns
 * the same fact immediately from its own `provisionTunnel()` response and does not need
 * the poll to catch up. Stops polling the instant the row goes terminal, rather than
 * running forever at a fixed interval the way a naive "always poll" would.
 */
export function useCloudflareTunnel() {
  return useQuery({
    queryKey: cloudflareTunnelKey,
    queryFn: () => apiFetch<TunnelStatus>("/api/cloudflare/tunnel"),
    refetchInterval: (query) => (query.state.data?.runningJobId ? 5_000 : false),
  });
}

/** `POST /api/cloudflare/tunnel`'s error bodies are `{ error: <code> }` with no `fault` —
 * a different shape from the credentials routes' `CloudflareFault` (this route never talks
 * to Cloudflare before the job starts, so there is no fault to classify yet), hence a
 * separate reader rather than reusing `cloudflareFaultOf`. */
function tunnelErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.body === null || typeof error.body !== "object" || !("error" in error.body)) {
    return null;
  }
  const code = (error.body as { error: unknown }).error;
  return typeof code === "string" ? code : null;
}

/** One sentence per code the route can send. `tunnel_provision_running` reads as "try
 * again shortly" rather than as a failure — see `routes/cloudflare-tunnel.ts`'s own
 * comment on why that race maps to 409 rather than the generic 500 it used to. */
const TUNNEL_ERROR_MESSAGES: Record<string, string> = {
  tunnel_exists: "A tunnel is already provisioned.",
  not_configured: "Add Cloudflare credentials before provisioning a tunnel.",
  tunnel_provision_running: "A tunnel provision is already running. Try again shortly.",
};

/** Mirrors `describeCloudflareError` above, over the provision route's own error shape. */
export function describeTunnelError(error: unknown, fallback: string): string {
  const code = tunnelErrorCode(error);
  const message = code === null ? undefined : TUNNEL_ERROR_MESSAGES[code];
  if (message !== undefined) return message;
  if (error instanceof ApiTimeoutError) return TIMEOUT_MESSAGE;
  if (!(error instanceof ApiError)) {
    return "Could not reach the server. Check the network and try again.";
  }
  return fallback;
}

/**
 * `POST /api/cloudflare/tunnel`. A plain function, not `useMutation`, for a different
 * reason than `useSaveCloudflareCredentials`'s (there is no secret in this call's
 * variables — it takes none): this call needs a `timeoutMs` far longer than `apiFetch`'s
 * 30s default, and `useMutation`'s `mutationFn` has no per-call override for that, only a
 * fixed one baked in at the hook's definition. `TUNNEL_PROVISION_TIMEOUT_MS` is shared
 * with the server (`@shared/cloudflare.js`) precisely because both ends of this one call
 * need to agree: the route does not answer until its whole five-step sequence has
 * finished, so a client timeout shorter than that abandons a request that is still
 * succeeding (or failing and rolling back) on the server, with no jobId ever reaching the
 * browser to check on it.
 */
export function useProvisionTunnel() {
  const queryClient = useQueryClient();
  return async function provisionTunnel(): Promise<{ jobId: string }> {
    const result = await apiFetch<{ jobId: string }>(
      "/api/cloudflare/tunnel",
      { method: "POST" },
      { timeoutMs: TUNNEL_PROVISION_TIMEOUT_MS },
    );
    queryClient.invalidateQueries({ queryKey: cloudflareTunnelKey });
    return result;
  };
}

/** One leaf per app, not folded into `cloudflareTunnelKey` — same prefix-matching
 * reasoning as every other key in this file: this app's exposure and the account's one
 * tunnel are refetched on different triggers and must not share an `invalidateQueries`
 * blast radius. */
export const appExposureKey = (appId: string) => ["cloudflare", "expose", appId] as const;

/**
 * `GET /api/apps/:id/expose` (2F Task 3) — the one read the exposure tab needs that
 * nothing before it returned; see `AppExposureStatus`'s own doc comment in
 * `@shared/cloudflare.js`. Polls every 5s only while `runningJobId` is set, the same
 * `useCloudflareTunnel` pattern above and for the same reason: a tab reloaded mid-expose,
 * or a second admin's tab, needs to notice the sequence without a manual refresh.
 */
export function useAppExposure(appId: string) {
  return useQuery({
    queryKey: appExposureKey(appId),
    queryFn: () => apiFetch<AppExposureStatus>(`/api/apps/${appId}/expose`),
    refetchInterval: (query) => (query.state.data?.runningJobId ? 5_000 : false),
  });
}

export type ExposeAppBody = {
  hostname: string;
  zoneId: string;
  ingressService: string;
  policyId: string;
  /** Only sent for the app marked `systemKind: "self"` — see `exposeBody`'s own comment
   * in `routes/cloudflare-expose.ts` for why the server requires it only there. */
  teamDomain?: string;
};

/**
 * `POST /api/apps/:id/expose`. A plain function, not `useMutation` — the same shape as
 * `useProvisionTunnel` above, and for a related reason: Expose creates real resources in
 * the user's Cloudflare account (a DNS record, an Access application, an ingress rule),
 * the same class of consequential action Provision is, so the caller drives its own
 * synchronous `starting` state rather than trusting `useMutation`'s `isPending` — see
 * `CloudflarePanel`'s own doc comment on `notifyManager` deferring that flag through a
 * `setTimeout(0)` a second click can land inside of. Unlike `useProvisionTunnel`, no
 * custom `timeoutMs`: 2F Task 1 detached BOTH step-job routes from the sequence they kick
 * off, so this POST already answers as soon as the job row exists, well inside
 * `apiFetch`'s ordinary default.
 */
export function useExposeApp(appId: string) {
  const queryClient = useQueryClient();
  return async function exposeApp(body: ExposeAppBody): Promise<{ jobId: string }> {
    const result = await apiFetch<{ jobId: string }>(`/api/apps/${appId}/expose`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    queryClient.invalidateQueries({ queryKey: appExposureKey(appId) });
    return result;
  };
}

/** `DELETE /api/apps/:id/expose`'s error bodies are `{ error: <code> }` for every 409, the
 * same shape `tunnelErrorCode` already reads — reused rather than duplicated. */
function exposeErrorCode(error: unknown): string | null {
  return tunnelErrorCode(error);
}

const EXPOSE_ERROR_MESSAGES: Record<string, string> = {
  tunnel_not_provisioned: "No tunnel is provisioned yet. Provision one from Settings first.",
  monitor_not_configured:
    "The monitor service token is not set up yet. Configure it from Settings first.",
  not_configured: "Add Cloudflare credentials in Settings before exposing this app.",
  already_exposed: "This app is already exposed.",
  hostname_taken: "That hostname is already used by another exposed app.",
  team_domain_required: "Enter this app's Cloudflare Zero Trust team domain to expose it.",
  app_busy: "Another job is already running for this app. Try again shortly.",
};

/** Mirrors `describeTunnelError` above, over the expose route's own error codes. */
export function describeExposeError(error: unknown, fallback: string): string {
  const code = exposeErrorCode(error);
  const message = code === null ? undefined : EXPOSE_ERROR_MESSAGES[code];
  if (message !== undefined) return message;
  if (error instanceof ApiTimeoutError) return TIMEOUT_MESSAGE;
  if (!(error instanceof ApiError)) {
    return "Could not reach the server. Check the network and try again.";
  }
  return fallback;
}

/** `DELETE /api/apps/:id/expose`'s 500 `deprovision_incomplete` body — see
 * `cloudflare-expose.ts`'s own comment on why this carries a message per resource, not
 * just the resource's name. */
type DeprovisionFailure = { resource: string; message: string };

function deprovisionFailures(error: unknown): DeprovisionFailure[] | null {
  if (!(error instanceof ApiError)) return null;
  if (error.body === null || typeof error.body !== "object" || !("failures" in error.body)) {
    return null;
  }
  const { failures } = error.body as { failures: unknown };
  return Array.isArray(failures) ? (failures as DeprovisionFailure[]) : null;
}

const DEPROVISION_ERROR_MESSAGES: Record<string, string> = {
  not_exposed: "This app is not exposed.",
  not_configured: "Add Cloudflare credentials in Settings before removing this exposure.",
  app_busy: "Another job is already running for this app. Try again shortly.",
};

/**
 * `deprovision.ts`'s own carefully-worded refusal — "the actual reason and what to do
 * about it" (2F Task 3's brief) — reaches here as `failures[].message` and is rendered
 * verbatim, one clause per resource, rather than collapsed into a generic "could not
 * remove" sentence. **Prominence, not just presence**: every failing resource is listed,
 * not only the first, because a partial success (three resources gone, one refused) is
 * exactly the shape a user must read in full to know what is still live. Joined with
 * `"; "`, not newlines — this string is rendered inside `ConfirmDialog`'s plain `<p>`
 * (reused, not reimplemented: see this tab's own doc comment on why), which does not
 * preserve whitespace, so a newline-joined list would collapse into a run-on sentence
 * with no visible separation at all.
 */
export function describeDeprovisionError(error: unknown, fallback: string): string {
  const failures = deprovisionFailures(error);
  if (failures && failures.length > 0) {
    const detail = failures.map((f) => `${f.resource} — ${f.message}`).join("; ");
    return `Could not fully remove this exposure: ${detail}`;
  }
  const code = exposeErrorCode(error);
  const message = code === null ? undefined : DEPROVISION_ERROR_MESSAGES[code];
  if (message !== undefined) return message;
  if (error instanceof ApiTimeoutError) return TIMEOUT_MESSAGE;
  if (!(error instanceof ApiError)) {
    return "Could not reach the server. Check the network and try again.";
  }
  return fallback;
}

/** `DELETE /api/apps/:id/expose`. `useMutation`, unlike Expose above: nothing here is a
 * secret, and the destructive click already goes through `ConfirmDialog`, which owns its
 * own once-only guard (`pendingRef`) independent of `isPending` — the same reasoning
 * `OverviewTab`'s own delete mutation and `useDeleteCloudflareCredentials` both rely on.
 * `onSettled`, not `onSuccess` alone: a failed deprovision still changes the `exposures`
 * row (some flags flip to `false` even though the row survives — `deprovision.ts`'s own
 * doc comment), so the tab's view of it needs refreshing either way. */
export function useDeprovisionApp(appId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: true }>(`/api/apps/${appId}/expose`, { method: "DELETE" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: appExposureKey(appId) }),
  });
}

/** Own leaf under `["cloudflare", ...]`, same reasoning as every other key in this file:
 * the monitor token's status is refetched on its own triggers (a rotate, an ensure) and
 * must not share an `invalidateQueries` blast radius with credentials, zones or the
 * tunnel. */
export const cloudflareMonitorKey = ["cloudflare", "monitor", "status"] as const;

/** `GET /api/cloudflare/monitor` — never carries the secret, see `MonitorAccessStatus`'s
 * own doc comment in `@shared/cloudflare.js`. Unconditional, like `useCloudflareTunnel`:
 * the monitor token can exist independently of whether credentials are currently
 * configured (an admin could remove credentials after setting it up), and Settings needs
 * to say so either way. */
export function useMonitorAccess() {
  return useQuery({
    queryKey: cloudflareMonitorKey,
    queryFn: () => apiFetch<MonitorAccessStatus>("/api/cloudflare/monitor"),
  });
}

/** `POST /api/cloudflare/monitor` — creates the one shared token and policy, or returns
 * the existing ones unchanged (`ensureMonitorAccess`'s own idempotency). `useMutation`,
 * not a plain function: nothing in its request body or response is a secret (the
 * response is `MonitorAccessStatus`, which never carries one), so there is nothing here
 * for `useMutation`'s cache to leak the way `useSaveCloudflareCredentials` avoids. */
export function useEnsureMonitorAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<MonitorAccessStatus>("/api/cloudflare/monitor", { method: "POST" }),
    onSuccess: (status) => queryClient.setQueryData(cloudflareMonitorKey, status),
  });
}

/** `POST /api/cloudflare/monitor/rotate` — same token id and policy id, a new secret.
 * `useMutation`, for `ConfirmDialog` to drive directly via `mutateAsync`: the confirm
 * click already goes through that dialog's own once-only guard (`pendingRef`), the same
 * reasoning `useDeprovisionApp` and `useDeleteCloudflareCredentials` rely on. */
export function useRotateMonitorSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<MonitorAccessStatus>("/api/cloudflare/monitor/rotate", { method: "POST" }),
    onSuccess: (status) => queryClient.setQueryData(cloudflareMonitorKey, status),
  });
}

/** `POST /api/cloudflare/monitor` and `.../rotate` share one error shape: `{ error: <code>
 * }` for a 409 (`not_configured`, `monitor_not_configured`), `{ error: "cloudflare_error",
 * fault }` for a 502 — the same `CloudflareFault` shape `describeCloudflareError` already
 * reads, reused here rather than duplicated. */
const MONITOR_ERROR_MESSAGES: Record<string, string> = {
  not_configured: "Add Cloudflare credentials above before setting up the monitor token.",
  monitor_not_configured: "Set up the monitor token before it can be rotated.",
};

/** Mirrors `describeCloudflareError` above, over the monitor routes' own error codes
 * layered on top of the same `CloudflareFault` shape. */
export function describeMonitorError(error: unknown, fallback: string): string {
  const fault = cloudflareFaultOf(error);
  if (fault) return FAULT_MESSAGES[fault];
  const code = tunnelErrorCode(error);
  const message = code === null ? undefined : MONITOR_ERROR_MESSAGES[code];
  if (message !== undefined) return message;
  if (error instanceof ApiTimeoutError) return TIMEOUT_MESSAGE;
  if (!(error instanceof ApiError)) {
    return "Could not reach the server. Check the network and try again.";
  }
  return fallback;
}

/** Own leaf under `["cloudflare", ...]`, same reasoning as every key above. */
export const cloudflareAccessKey = ["cloudflare", "access", "status"] as const;

/** `GET /api/cloudflare/access` — read-only, resolved from the database, the environment,
 * or neither (`AccessConfigStatus`'s own doc comment in `@shared/cloudflare.js`). */
export function useAccessConfig() {
  return useQuery({
    queryKey: cloudflareAccessKey,
    queryFn: () => apiFetch<AccessConfigStatus>("/api/cloudflare/access"),
  });
}

/**
 * `POST /api/cloudflare/reconcile` (2F Task 6) — triggers the periodic reconcile on
 * demand and returns only a count, never per-exposure detail: the one caller of this
 * (`ExposureTab`) already has its own `GET /api/apps/:id/expose` for that, via
 * `useAppExposure`. A plain function, not `useMutation`, for the same class of reason
 * `useProvisionTunnel` avoids it — this changes real local state (every exposure's
 * `state`/`lastError`) that other queries need to see immediately, and the caller drives
 * its own `checking` state the way every other consequential action in this codebase does.
 *
 * Invalidates every `["cloudflare", "expose", ...]` leaf, not just the current app's — a
 * system-wide reconcile can change ANY exposure's drift status, and `appExposureKey`'s own
 * doc comment already establishes that TanStack's `invalidateQueries` matches by prefix,
 * which is exactly what makes one broad invalidation here reach all of them.
 */
export function useReconcileExposures() {
  const queryClient = useQueryClient();
  return async function reconcileExposures(): Promise<{ checked: number; drifted: number }> {
    const result = await apiFetch<{ checked: number; drifted: number }>(
      "/api/cloudflare/reconcile",
      { method: "POST" },
    );
    queryClient.invalidateQueries({ queryKey: ["cloudflare", "expose"] });
    return result;
  };
}
