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
 * Focus refetching is an independent switch from the poll interval, and an
 * errored query has no `dataUpdatedAt`, so it is always considered stale: left
 * at the default, a viewer who alt-tabs 200 times issues 200 requests that are
 * all guaranteed to 403. Same rule as the poll, applied to the other trigger.
 *
 * Typed structurally rather than as `Query<…>` so one function serves every
 * query in the app regardless of its data and error types.
 */
export function refetchUnlessRefused(query: {
  state: { error: unknown };
}): boolean {
  return !isRefusal(query.state.error);
}

/**
 * The behaviour every Homestead query gets **by default**, not by remembering.
 *
 * This was first applied to `useProjects` alone; the next task added two more
 * hooks and neither inherited it, so a viewer opening a shared project link
 * took two guaranteed-403s and two more on every alt-tab. A rule that has to
 * be re-typed at each call site is a rule that will be missed, so it lives on
 * the client instead: a hook added tomorrow that sets no options at all is
 * refusal-aware, and `queries.test.tsx` pins exactly that with a query no hook
 * in this file owns.
 */
export const queryDefaults = {
  retry: retryUnlessRefused,
  refetchOnWindowFocus: refetchUnlessRefused,
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
  hasHomestead: boolean;
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
