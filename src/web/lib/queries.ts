import type {
  ContainerState,
  Operation,
  OperationKind,
  ProjectModel,
  ScanEntry,
} from "@shared/projects.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./api.js";

export const queryKeys = {
  /** AppShell's sign-out clears the cache by this key — keep them in step. */
  projects: ["projects"] as const,
  project: (slug: string) => ["project", slug] as const,
  /** A prefix of `project(slug)`, so invalidating the detail invalidates this. */
  projectOperations: (slug: string) => ["project", slug, "operations"] as const,
};

/** Slow enough for ~30 stacks on a NAS, quick enough to feel live. */
export const POLL_MS = 15_000;

/**
 * A 401 or 403 is a standing answer, not a blip: the permission will not
 * appear on its own, so retrying only burns requests and delays the message
 * the user needs to see.
 */
function isRefusal(error: unknown): boolean {
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
 * Focus refetching is an independent switch from the poll interval, and an
 * errored query has no `dataUpdatedAt`, so it is always considered stale: left
 * at the default, a viewer who alt-tabs 200 times issues 200 requests that are
 * all guaranteed to 403. Same rule as the poll, applied to the other trigger.
 */
export function refetchProjectsOnFocus(error: unknown): boolean {
  return !isRefusal(error);
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
    refetchInterval: (query) => projectsPollInterval(query.state.error),
    refetchOnWindowFocus: (query) => refetchProjectsOnFocus(query.state.error),
    retry: retryUnlessRefused,
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
  model: ProjectModel | null;
  parseError: string | null;
  states: ContainerState[];
  statesError: string | null;
  snapshots: string[];
};

export function useProject(slug: string) {
  return useQuery({
    queryKey: queryKeys.project(slug),
    queryFn: () =>
      apiFetch<ProjectDetailData>(`/api/projects/${encodeURIComponent(slug)}`),
    enabled: slug !== "",
    retry: retryUnlessRefused,
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
    retry: retryUnlessRefused,
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

/** What to put in front of the user when a lifecycle request is refused. */
export function lifecycleErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return "An operation is already running for this project. Wait for it to finish, then try again.";
    if (error.status === 403 || error.status === 401)
      return "Controlling a stack needs an administrator account.";
    if (error.status === 404)
      return "This project is no longer on disk. Return to the project list.";
  }
  return error instanceof Error
    ? `Could not start the operation. ${error.message}`
    : "Could not start the operation.";
}
