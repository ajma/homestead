import type { AdminApp } from "@shared/dto";
import { useQueryClient } from "@tanstack/react-query";
import { adminAppKey, useImages, useJobs } from "@web/api/admin";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { JobOutput } from "@web/components/JobOutput";
import { useEffect, useState } from "react";

type ActionKind = "up" | "restart" | "pull" | "down";

const QUICK_ACTIONS: ReadonlyArray<{ kind: Exclude<ActionKind, "down">; label: string }> = [
  { kind: "up", label: "Deploy" },
  { kind: "restart", label: "Restart" },
  { kind: "pull", label: "Pull" },
];

const ALREADY_RUNNING_MESSAGE = "Another job is already running for this app.";

/**
 * Reports a failed action the way a user should read it, not the way the server encoded
 * it. `POST /api/apps/:id/actions/:kind` answers 409 `job_running` when `JobRunner.start`'s
 * mutex rejects a second job — see the class doc on `JobBusyError`. That mutex slot is
 * taken before any `await` (the 1B-ii carry-forward records a double-click on Deploy
 * spawning `docker compose up` twice before that fix), so the buttons below already
 * disable while a job is in flight; the residual case this function exists for is the
 * click that lands in the brief window before that disable has rendered. It reads as
 * "already running" — a fact, not a failure the user needs to retry past.
 */
const TIMEOUT_MESSAGE =
  "The server did not respond. It may still be working; check again in a moment.";

function describeActionError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return ALREADY_RUNNING_MESSAGE;
  // A timeout is genuinely different from a rejection: `apiFetch` gave up waiting, not
  // the server saying no, so the action itself may have gone through — "already running"
  // and a raw "API request timed out after 30000ms" are both wrong words for that.
  if (error instanceof ApiTimeoutError) return TIMEOUT_MESSAGE;
  return error instanceof Error ? error.message : "Could not start this action.";
}

/**
 * The lifecycle action bar: deploy, restart, pull and (behind a confirmation) stop, with
 * the job's output streaming below as it runs. This is the surface Phase 1E's admin pages
 * exist to reach — everything else on the edit page is context for the decision this makes.
 *
 * `app` arrives as a prop, not via `useOutletContext` — `EditApp` already holds it for the
 * header, and this bar is rendered from there directly rather than as a routed tab.
 *
 * All four buttons disable together while any job is in flight for this app, both a job
 * this component just started (`activeJobId`, set the moment the POST resolves) and one
 * already running when the page loads or that another tab/admin started (`useJobs`' most
 * recent row, checked below) — the point is "a job is running for this app", not "a job
 * this browser tab happens to remember starting". `starting` covers the gap between click
 * and response, which is also disabled but does not yet have a `jobId` to stream.
 *
 * `down` alone goes through `ConfirmDialog` rather than starting immediately, because it is
 * the destructive action (`docker compose down`, taking the stack's containers with it).
 * `ConfirmDialog`'s `onConfirm` can reject — the 409 above is exactly that case — and when
 * it does, the dialog stays open and shows `describeActionError`'s message in place, rather
 * than closing and losing it.
 */
export function ActionBar({ app }: { app: AdminApp }) {
  const queryClient = useQueryClient();
  const { data: jobs } = useJobs(app.id);
  const { data: images } = useImages(app.id);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);

  const runningJobId = jobs?.find((job) => job.status === "running")?.id ?? null;
  const updatesAvailable = images?.some((image) => image.updateAvailable) ?? false;

  // Picks up a job already running when this component mounts — someone started a `pull`
  // and refreshed the page, or another admin's session did — without stomping on a job
  // this component itself just started (the `activeJobId === null` guard) or re-triggering
  // on every poll of `useJobs` while the same job is still the one running (keyed on the
  // id, not the array reference, which is a new object every refetch regardless).
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

  function handleQuickAction(kind: Exclude<ActionKind, "down">) {
    startJob(kind).catch((error: unknown) => {
      setActionError(describeActionError(error));
    });
  }

  function handleJobDone() {
    setActiveJobId(null);
    // `adminAppKey(app.id)` prefix-matches this app's containers, jobs, images and probes
    // deliberately (see `src/web/api/admin.ts`), so this one invalidation refreshes all
    // of them — a separate `containersKey`/`jobsKey` invalidation here was refetching
    // `jobs` a second time for nothing (measured: a single Deploy produced two `GET
    // .../jobs`).
    //
    // Deliberately NOT `adminAppsKey`, the whole-inventory rollup: `EditApp` used to read
    // it, which kept it active on every edit page, so invalidating it here refetched up
    // to sixty `docker compose config` spawns to update one row's chip. `EditApp` now
    // resolves through `useAdminApp(slug)` instead, cached under `adminAppKey(slug)` —
    // a second, separate entry from `adminAppKey(app.id)` above, since the id and the
    // slug are different strings. Both need invalidating: the id one for the subview
    // cascade, the slug one because that is what the header on THIS page is actually
    // keyed by. See the 1E final-fix brief, Important 3.
    queryClient.invalidateQueries({ queryKey: adminAppKey(app.id) });
    queryClient.invalidateQueries({ queryKey: adminAppKey(app.slug) });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {QUICK_ACTIONS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            disabled={busy}
            onClick={() => handleQuickAction(kind)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {label}
            {kind === "pull" && updatesAvailable && (
              <span className="ml-1.5 text-xs font-normal text-amber-300 dark:text-amber-600">
                Update available
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmingStop(true)}
          className="rounded-lg border border-rose-300 px-3 py-2 text-sm text-rose-700 disabled:opacity-50 dark:border-rose-800 dark:text-rose-400"
        >
          Stop
        </button>
      </div>

      {actionError && <p className="text-sm text-rose-600 dark:text-rose-400">{actionError}</p>}

      {activeJobId !== null && <JobOutput jobId={activeJobId} onDone={handleJobDone} />}

      {confirmingStop && (
        <ConfirmDialog
          title="Stop app"
          message={`Stop ${app.displayName}? This takes its containers down.`}
          confirmLabel="Stop"
          destructive
          onConfirm={() => startJob("down")}
          onClose={() => setConfirmingStop(false)}
          formatError={describeActionError}
        />
      )}
    </div>
  );
}
