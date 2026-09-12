import type { AdminApp } from "@shared/dto";
import { useImages } from "@web/api/admin";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { JobOutput } from "@web/components/JobOutput";
import { type ActionKind, describeActionError, useAppActions } from "@web/components/useAppActions";
import { useState } from "react";

const QUICK_ACTIONS: ReadonlyArray<{ kind: Exclude<ActionKind, "down">; label: string }> = [
  { kind: "up", label: "Deploy" },
  { kind: "restart", label: "Restart" },
  { kind: "pull", label: "Pull" },
];

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
  const { data: images } = useImages(app.id);
  const { busy, activeJobId, actionError, setActionError, startJob, handleJobDone } =
    useAppActions(app);

  const [confirmingStop, setConfirmingStop] = useState(false);

  const updatesAvailable = images?.some((image) => image.updateAvailable) ?? false;

  function handleQuickAction(kind: Exclude<ActionKind, "down">) {
    startJob(kind).catch((error: unknown) => {
      setActionError(describeActionError(error));
    });
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
