import type { ExposureSummary, ZoneOption } from "@shared/cloudflare.js";
import type { DashboardData } from "@shared/dashboard.js";
import type {
  DeviceSummary,
  HistoryBucket,
  MonitorSummary,
  MonitorType,
  UptimeWindow,
} from "@shared/monitoring.js";
import type { PreflightResult } from "@shared/preflight.js";
import type {
  ContainerState,
  Operation,
  OperationKind,
  ProjectModel,
  ScanEntry,
} from "@shared/projects.js";
import type { DefaultOptions } from "@tanstack/react-query";
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError, apiFetch } from "./api.js";

export const queryKeys = {
  /** AppShell's sign-out clears the cache by this key — keep them in step. */
  projects: ["projects"] as const,
  project: (slug: string) => ["project", slug] as const,
  /** A prefix of `project(slug)`, so invalidating the detail invalidates this. */
  projectOperations: (slug: string) => ["project", slug, "operations"] as const,
  file: (slug: string, name: "compose" | "env") =>
    ["project", slug, "file", name] as const,
  devices: ["devices"] as const,
  device: (id: string) => ["device", id] as const,
  exposures: ["exposures"] as const,
  cloudflareStatus: ["cloudflare", "status"] as const,
  dashboard: ["dashboard"] as const,
  preflight: ["preflight"] as const,
  zones: ["cloudflare", "zones"] as const,
  icons: (q: string) => ["icons", q] as const,
};

/** How a project is presented: set by an admin, shown wherever it appears. */
export type ProjectIdentity = {
  displayName: string | null;
  description: string | null;
  iconSlug: string | null;
  iconUrl: string | null;
};

/** Slow enough for ~30 stacks on a NAS, quick enough to feel live. */
export const POLL_MS = 15_000;

/**
 * A 401 or 403 is a standing answer, not a blip: the permission will not
 * appear on its own, so retrying only burns requests and delays the message
 * the user needs to see.
 *
 * Exported because the same predicate decides three different things — retry,
 * focus refetching, and which message a component renders — and it was
 * hand-written a fourth and fifth time in `ProjectList` and `ProjectDetail`
 * before it was. One rule, one spelling.
 */
export function isRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 403)
  );
}

// `error: Error` rather than `unknown`: react-query infers the query's error
// type from this signature, and `unknown` would leak into every caller.
export function retryUnlessRefused(
  failureCount: number,
  error: Error,
): boolean {
  return !isRefusal(error) && failureCount < 2;
}

/** Polling a refusal every 15s for as long as the tab is open is pure waste. */
export function projectsPollInterval(error: unknown): number | false {
  return isRefusal(error) ? false : POLL_MS;
}

/**
 * The behaviour every Homestead query gets **by default**, not by remembering.
 *
 * This was first applied to `useProjects` alone; the next task added two more
 * hooks and neither inherited it, so a viewer opening a shared project link
 * took two guaranteed-403s and two more on every alt-tab. A rule that has to
 * be re-typed at each call site is a rule that will be missed, so it lives on
 * the client instead: a hook added tomorrow that sets no options at all gets
 * the same defaults, and `queries.test.tsx` pins exactly that with a query no
 * hook in this file owns.
 *
 * `refetchOnWindowFocus` is deliberately left at the library default (`true`)
 * rather than also suppressed on a refusal: unlike a poll tick, a focus event
 * means a person is looking right now, and a 401/403 is not always standing —
 * a session can renew, a role can change — between when it happened and when
 * they come back to check. Retrying then is one request, not a leak.
 */
export const queryDefaults = {
  retry: retryUnlessRefused,
} as const;

/**
 * The app's `QueryClient`. Tests build theirs through here too — a test that
 * constructed a bare client would be testing a client the app never uses.
 */
export function createQueryClient(
  overrides: DefaultOptions["queries"] = {},
): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { ...queryDefaults, ...overrides } },
  });
}

/**
 * The project list is a cheap directory scan — no compose parsing and no
 * Docker calls — so it is safe to poll. Anything that needs `docker compose`
 * belongs on the detail view, once, not on 30 rows every 15 seconds.
 */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: async () => {
      const body = await apiFetch<{ projects: ScanEntry[] }>("/api/projects");
      return body?.projects ?? [];
    },
    // Retry and focus behaviour come from {@link queryDefaults}; only the poll
    // is this hook's own.
    refetchInterval: (query) => projectsPollInterval(query.state.error),
  });
}

/**
 * `GET /api/projects/:slug`.
 *
 * `model` is null — with `parseError` set — whenever `docker compose config`
 * refuses the file, and the response still carries everything else. That is
 * the whole point: the projects a user most needs to open are the broken ones,
 * so nothing here may be reached through a non-null assertion.
 */
export type ProjectDetailData = ScanEntry & {
  identity: ProjectIdentity | null;
  model: ProjectModel | null;
  parseError: string | null;
  states: ContainerState[];
  statesError: string | null;
  /**
   * True when the compose file carries an `x-homestead` block — i.e. Homestead
   * created this project. Absence is the provenance marker for an adopted
   * directory (§3.7), which is why the delete dialog asks twice for one.
   *
   * Required, not optional: the server always sends it, and an optional field
   * would let a missing flag read as "adopted" and silently soften a
   * confirmation that exists to protect a user's data.
   */
  snapshots: string[];
};

export function useProject(slug: string) {
  return useQuery({
    queryKey: queryKeys.project(slug),
    queryFn: () =>
      apiFetch<ProjectDetailData>(`/api/projects/${encodeURIComponent(slug)}`),
    enabled: slug !== "",
  });
}

/** While something is running, three seconds is the difference between "did it work?" and knowing. */
const RUNNING_POLL_MS = 3_000;

export function hasRunningOperation(operations: Operation[]): boolean {
  return operations.some((op) => op.status === "running");
}

/**
 * `GET /api/projects/:slug/operations`. Polled only while an operation is
 * running: history does not change on its own, and a page left open on a NAS
 * should cost nothing.
 */
export function useProjectOperations(slug: string) {
  return useQuery({
    queryKey: queryKeys.projectOperations(slug),
    queryFn: async () => {
      const body = await apiFetch<{ operations: Operation[] }>(
        `/api/projects/${encodeURIComponent(slug)}/operations`,
      );
      return body?.operations ?? [];
    },
    enabled: slug !== "",
    refetchInterval: (query) =>
      hasRunningOperation(query.state.data ?? []) ? RUNNING_POLL_MS : false,
  });
}

/**
 * `POST /api/projects/:slug/:verb` — 202 with an operation id, or 409 when one
 * is already running for that project.
 *
 * Deliberately never retried. Every verb here spawns `docker compose` against
 * a real stack, so an automatic second attempt is a second `up`, not a
 * harmless re-read.
 */
export function useLifecycle(slug: string) {
  const queryClient = useQueryClient();
  return useMutation<string, Error, OperationKind>({
    mutationFn: async (verb) => {
      const body = await apiFetch<{ operationId: string }>(
        `/api/projects/${encodeURIComponent(slug)}/${verb}`,
        { method: "POST" },
      );
      // apiFetch returns `T | null` because a 204 has no body. A 202 without
      // an id is a broken server, not an operation we can follow.
      if (!body?.operationId)
        throw new Error("the server accepted the request without giving an id");
      return body.operationId;
    },
    retry: false,
    // The detail key is a prefix of the operations key, so one call refreshes
    // both container states and the operation list.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(slug) });
    },
  });
}

/** The server's `detail` is a sentence fragment; this makes it one. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What to put in front of the user when a lifecycle request is refused. */
export function lifecycleErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      // The 409's `detail` names the project the operation is running for,
      // which is the whole question the user has. Without it this could only
      // say "an operation" — true, and no help.
      return `${
        error.detail
          ? sentence(error.detail)
          : "An operation is already running for this project"
      }. Wait for it to finish, then try again.`;
    if (error.status === 403 || error.status === 401)
      return "Controlling a stack needs an administrator account.";
    if (error.status === 404)
      return "This project is no longer on disk. Return to the project list.";
  }
  return error instanceof Error
    ? `Could not start the operation. ${error.message}`
    : "Could not start the operation.";
}

export function useProjectFile(slug: string, name: "compose" | "env") {
  return useQuery({
    queryKey: queryKeys.file(slug, name),
    queryFn: async () => {
      try {
        return await apiFetch<{ content: string }>(
          `/api/projects/${slug}/file/${name}`,
        );
      } catch (err) {
        // A project with no `.env` is an ordinary state, not a failure: the
        // editor offers to create one. Every other status still throws.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useSaveProjectFile(slug: string, name: "compose" | "env") {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      await apiFetch(`/api/projects/${slug}/file/${name}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.file(slug, name) });
      client.invalidateQueries({ queryKey: queryKeys.project(slug) });
    },
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      slug: string;
      source: "blank" | "paste";
      content?: string;
    }) => {
      const res = await apiFetch<{
        slug: string;
        valid: boolean;
        error?: string;
      }>("/api/projects", { method: "POST", body: JSON.stringify(body) });
      if (!res) throw new Error("create returned no body");
      return res;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

export function useDeleteProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => {
      await apiFetch(`/api/projects/${slug}`, { method: "DELETE" });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

export function useDevices() {
  return useQuery({
    queryKey: queryKeys.devices,
    queryFn: async () => {
      const body = await apiFetch<{ devices: DeviceSummary[] }>("/api/devices");
      return body?.devices ?? [];
    },
  });
}

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: async () => {
      const body = await apiFetch<DashboardData>("/api/dashboard");
      return body;
    },
  });
}

/**
 * `enabled` exists for sign-out. `queryClient.clear()` makes every *mounted*
 * observer refetch immediately, and AppShell — which owns this query — is
 * still mounted at that moment, because navigating is a state update React
 * has not flushed yet. That refetch carries the cookie the server has just
 * revoked, so it 401s, and apiFetch answers a 401 with
 * `window.location.assign("/login")`, aborting whatever navigation is already
 * in flight. Ordering navigate before clear does not prevent it; not asking
 * does.
 */
/**
 * The account's zones, for the hostname picker. Effectively static for a
 * session, and the picker is the only consumer, so it is fetched on demand
 * rather than polled.
 */
/**
 * Icon slugs matching a query. Disabled while the box is empty — the endpoint
 * answers "" with nothing, and asking anyway is a request per focus.
 */
export function useIconSearch(query: string) {
  return useQuery({
    queryKey: queryKeys.icons(query),
    enabled: query.trim() !== "",
    queryFn: async () => {
      const body = await apiFetch<{ icons: string[] }>(
        `/api/icons?q=${encodeURIComponent(query)}`,
      );
      return body?.icons ?? [];
    },
  });
}

export function useSaveIdentity(slug: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<ProjectIdentity>) => {
      await apiFetch(`/api/projects/${encodeURIComponent(slug)}/identity`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.project(slug) });
      client.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useZones() {
  return useQuery({
    queryKey: queryKeys.zones,
    queryFn: async () => {
      const body = await apiFetch<{ zones: ZoneOption[] }>(
        "/api/cloudflare/zones",
      );
      return body?.zones ?? [];
    },
  });
}

export function usePreflight(enabled = true) {
  return useQuery({
    queryKey: queryKeys.preflight,
    enabled,
    queryFn: async () => {
      const body = await apiFetch<{ checks: PreflightResult[] }>(
        "/api/preflight",
      );
      return body?.checks ?? [];
    },
  });
}

export function useCreateDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; kind: string }) => {
      const res = await apiFetch<DeviceSummary>("/api/devices", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res) throw new Error("create returned no body");
      return res;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}

export function useUpdateDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: { id: string; hidden: boolean }) => {
      await apiFetch(`/api/devices/${body.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: body.hidden }),
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}

export function useDeleteDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/api/devices/${id}`, { method: "DELETE" });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}

export function useConfigureTailscale() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: { tailnet: string; token: string }) => {
      const res = await apiFetch<{ deviceCount: number }>(
        "/api/settings/tailscale",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      if (!res) throw new Error("configure returned no body");
      return res;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.devices }),
  });
}

export type DeviceDetailData = {
  device: DeviceSummary;
  monitors: MonitorSummary[];
  uptime: UptimeWindow[];
  history: HistoryBucket[];
};

export function useDeviceDetail(id: string) {
  return useQuery({
    queryKey: queryKeys.device(id),
    queryFn: () =>
      apiFetch<DeviceDetailData>(`/api/devices/${encodeURIComponent(id)}`),
    enabled: id !== "",
  });
}

export function useCreateMonitor(deviceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: { type: MonitorType }) => {
      const res = await apiFetch(`/api/devices/${deviceId}/monitors`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return res;
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.device(deviceId) });
    },
  });
}

export function useUpdateMonitor(deviceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      id: string;
      required?: boolean;
      enabled?: boolean;
    }) => {
      const { id, ...patch } = body;
      await apiFetch(`/api/monitors/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.device(deviceId) });
    },
  });
}

export function useDeleteMonitor(deviceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/api/monitors/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.device(deviceId) });
    },
  });
}

export type CloudflareStatus = {
  configured: boolean;
  accountId: string | null;
  tunnelId: string | null;
  runtime: { kind: string; containerId?: string; projectSlug?: string };
  idpId: string | null;
  syncState: string;
};

export function useExposures() {
  return useQuery({
    queryKey: queryKeys.exposures,
    queryFn: async () => {
      const body = await apiFetch<{ exposures: ExposureSummary[] }>(
        "/api/exposures",
      );
      return body?.exposures ?? [];
    },
  });
}

export function useCloudflareStatus() {
  return useQuery({
    queryKey: queryKeys.cloudflareStatus,
    queryFn: () => apiFetch<CloudflareStatus>("/api/cloudflare/status"),
  });
}

export function useCreateExposure() {
  const client = useQueryClient();
  return useMutation({
    // No serviceName: there is no such column, and the server derives the
    // name from docker compose config at read time. Accepting one here let the
    // form collect a value that was silently discarded.
    mutationFn: async (body: {
      projectSlug: string | null;
      hostPort: number;
      hostname: string;
      scheme: "http" | "https";
      noTlsVerify: boolean;
      label: string | null;
      enabled: boolean;
      accessEnabled: boolean;
    }) => {
      const res = await apiFetch<{ id: string }>("/api/exposures", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res) throw new Error("create returned no body");
      return res;
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.exposures }),
  });
}

export function useUpdateExposure() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      id: string;
      enabled?: boolean;
      accessEnabled?: boolean;
      hostname?: string;
      label?: string | null;
    }) => {
      const { id, ...patch } = body;
      await apiFetch(`/api/exposures/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.exposures }),
  });
}

export function useDeleteExposure() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/api/exposures/${id}`, { method: "DELETE" });
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.exposures }),
  });
}

export function useReconcileExposures() {
  const client = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: async () => {
      await apiFetch("/api/exposures/reconcile", { method: "POST" });
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.exposures }),
  });
}

export type AccountOption = { id: string; name: string };

export function useVerifyToken() {
  return useMutation({
    mutationFn: async (token: string) => {
      const res = await apiFetch<{ accounts: AccountOption[] }>(
        "/api/cloudflare/token",
        { method: "POST", body: JSON.stringify({ token }) },
      );
      if (!res) throw new Error("verify token returned no body");
      return res;
    },
  });
}

export function useSelectAccount() {
  return useMutation({
    mutationFn: async (accountId: string) => {
      const res = await apiFetch<{
        zones: import("@shared/cloudflare.js").ZoneOption[];
        idps: import("@shared/cloudflare.js").IdpOption[];
      }>("/api/cloudflare/account", {
        method: "POST",
        body: JSON.stringify({ accountId }),
      });
      if (!res) throw new Error("select account returned no body");
      return res;
    },
  });
}

export function useSetupTunnel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (idpId: string) => {
      const res = await apiFetch<{
        tunnelId: string;
        runtime: import("@shared/cloudflare.js").TunnelRuntime;
      }>("/api/cloudflare/setup", {
        method: "POST",
        body: JSON.stringify({ idpId }),
      });
      if (!res) throw new Error("setup tunnel returned no body");
      return res;
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.cloudflareStatus });
      client.invalidateQueries({ queryKey: queryKeys.exposures });
    },
  });
}
