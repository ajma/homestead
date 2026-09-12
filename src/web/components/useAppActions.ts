import type { AdminApp } from "@shared/dto";
import { useQueryClient } from "@tanstack/react-query";
import { adminAppKey, adminAppsKey, useJobs } from "@web/api/admin";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { useEffect, useState } from "react";

export type ActionKind = "up" | "restart" | "pull" | "down";

const ALREADY_RUNNING_MESSAGE = "Another job is already running for this app.";

const TIMEOUT_MESSAGE =
  "The server did not respond. It may still be working; check again in a moment.";

/**
 * Reports a failed action the way a user should read it, not the way the server encoded
 * it. `POST /api/apps/:id/actions/:kind` answers 409 `job_running` when `JobRunner.start`'s
 * mutex rejects a second job — see the class doc on `JobBusyError`. That mutex slot is
 * taken before any `await` (the 1B-ii carry-forward records a double-click on Deploy
 * spawning `docker compose up` twice before that fix), so every caller of `useAppActions`
 * already disables its buttons while a job is in flight; the residual case this function
 * exists for is the click that lands in the brief window before that disable has rendered.
 * It reads as "already running" — a fact, not a failure the user needs to retry past.
 */
export function describeActionError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return ALREADY_RUNNING_MESSAGE;
  // A timeout is genuinely different from a rejection: `apiFetch` gave up waiting, not
  // the server saying no, so the action itself may have gone through — "already running"
  // and a raw "API request timed out after 30000ms" are both wrong words for that.
  if (error instanceof ApiTimeoutError) return TIMEOUT_MESSAGE;
  return error instanceof Error ? error.message : "Could not start this action.";
}

/**
 * The one mutation path for `POST /api/apps/:id/actions/:kind` — shared by `ActionBar`
 * (the edit page's full bar) and the inventory row actions in `AdminApps.tsx`, so a row
 * action and the edit page's button cannot diverge on what "deploy" means, on the
 * busy-while-a-job-is-running semantics, or on how a 409 reads (Task 11).
 *
 * All actions disable together while any job is in flight for this app, both a job this
 * hook's caller just started (`activeJobId`, set the moment the POST resolves) and one
 * already running when the caller mounts or that another tab/admin started (`useJobs`'
 * most recent row, checked below) — the point is "a job is running for this app", not "a
 * job this browser tab happens to remember starting". `starting` covers the gap between
 * click and response, which is also disabled but does not yet have a `jobId` to stream.
 *
 * `handleJobDone` invalidates `adminAppKey(app.id)` and `adminAppKey(app.slug)`, and
 * separately patches this app's row in the `adminAppsKey` cache in place — it never
 * invalidates `adminAppsKey` itself. That rollup is what `GET /api/apps` computes by
 * spawning up to four `docker compose config` processes; re-fetching all of it to update
 * one row is the mistake 1E already made once and fixed (the 1E final-fix brief,
 * Important 3), and a caller reusing this hook cannot reintroduce it. See the patch
 * itself, below, for why writing to that one row is safe where invalidating it is not.
 *
 * `knownRunningJobId` lets a caller that already has the answer — the inventory row,
 * from `GET /api/apps`'s own `runningJobId` field — skip `useJobs` entirely rather than
 * mounting a per-row poll of that app's whole job history to re-derive a fact the list
 * response already carried. Omitting it (as `ActionBar` does) keeps this hook's default
 * behaviour exactly what it always was: a single-app view has no such list to read from,
 * so its own `useJobs` poll is the correct, and only, source.
 */
export function useAppActions(
  app: Pick<AdminApp, "id" | "slug">,
  options: { knownRunningJobId?: string | null } = {},
) {
  const queryClient = useQueryClient();
  const hasKnownRunningJobId = options.knownRunningJobId !== undefined;
  const { data: jobs } = useJobs(hasKnownRunningJobId ? null : app.id);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runningJobId = hasKnownRunningJobId
    ? (options.knownRunningJobId ?? null)
    : (jobs?.find((job) => job.status === "running")?.id ?? null);

  // Picks up a job already running when this hook mounts — someone started a `pull` and
  // refreshed the page, or another admin's session did — without stomping on a job this
  // hook itself just started (the `activeJobId === null` guard) or re-triggering on every
  // poll of `useJobs` while the same job is still the one running (keyed on the id, not
  // the array reference, which is a new object every refetch regardless).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on runningJobId only
  useEffect(() => {
    if (runningJobId !== null && activeJobId === null) setActiveJobId(runningJobId);
  }, [runningJobId]);

  const busy = starting || activeJobId !== null;

  async function startJob(kind: ActionKind): Promise<void> {
    setStarting(true);
    setActionError(null);
    try {
      const job = await apiFetch<{ jobId: string }>(`/api/apps/${app.id}/actions/${kind}`, {
        method: "POST",
      });
      setActiveJobId(job.jobId);
    } finally {
      setStarting(false);
    }
  }

  function handleJobDone() {
    setActiveJobId(null);
    // `adminAppKey(app.id)` prefix-matches this app's containers, jobs, images and probes
    // deliberately (see `src/web/api/admin.ts`), so this one invalidation refreshes all of
    // them. `adminAppKey(app.slug)` is a separate cache entry — the one `EditApp`'s own
    // header is keyed by, since it resolves through `useAdminApp(slug)` rather than the
    // whole-inventory `adminAppsKey`. Both need invalidating.
    queryClient.invalidateQueries({ queryKey: adminAppKey(app.id) });
    queryClient.invalidateQueries({ queryKey: adminAppKey(app.slug) });

    // Since Task 2, `adminAppsKey` — the inventory list `GET /api/apps` returns — is the
    // ONLY cache holding this row's `runningJobId`; nothing else writes to it once a job
    // finishes. Leaving it untouched (as this used to) meant a row's cached
    // `runningJobId` outlived the job itself: an admin who deployed, watched it finish,
    // then came back within the list's 15s `staleTime` found Deploy and Restart disabled
    // again and a second SSE stream opened for a job that had already completed. It
    // self-healed once that stream replayed `done`, but it was a visible flicker and a
    // spurious connection nothing caught.
    //
    // This does NOT reintroduce the defect `adminAppsKey` is otherwise never invalidated
    // for (the 1E final-fix brief, Important 3): that rule is about *invalidating* —
    // forcing `GET /api/apps` to re-run its Docker calls — on every status frame from a
    // flapping probe, which would turn polling into a load generator. A job finishing is
    // not a status frame; it is a discrete, user-initiated, low-frequency event, and a
    // local `setQueryData` patch triggers no refetch and no Docker call at all — it just
    // corrects the one field this hook's own row owns.
    queryClient.setQueryData<AdminApp[]>(adminAppsKey, (rows) =>
      rows?.map((row) => (row.id === app.id ? { ...row, runningJobId: null } : row)),
    );
  }

  return { busy, activeJobId, actionError, setActionError, startJob, handleJobDone };
}
