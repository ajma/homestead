import type { ProjectModel, ScanEntry } from "@shared/projects.js";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./api.js";

export const queryKeys = {
  /** AppShell's sign-out clears the cache by this key — keep them in step. */
  projects: ["projects"] as const,
  project: (slug: string) => ["project", slug] as const,
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
 * `GET /api/projects/:slug`. Task 7's detail view owns the rest of this shape
 * (container states, parse errors); it is extended there as the view needs it.
 */
export type ProjectDetail = ScanEntry & {
  model: ProjectModel | null;
  parseError: string | null;
  snapshots: string[];
};

export function useProject(slug: string) {
  return useQuery({
    queryKey: queryKeys.project(slug),
    queryFn: () =>
      apiFetch<ProjectDetail>(`/api/projects/${encodeURIComponent(slug)}`),
    enabled: slug !== "",
    retry: retryUnlessRefused,
  });
}
