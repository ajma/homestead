import type { AdminApp } from "@shared/dto";
import type { AppStatus } from "@shared/types";
import { useAdminApps } from "@web/api/admin";
import { AppIcon } from "@web/components/AppIcon";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { JobOutput } from "@web/components/JobOutput";
import { StatusChip } from "@web/components/StatusChip";
import { describeActionError, useAppActions } from "@web/components/useAppActions";
import { PAGE_SHELL } from "@web/lib/density";
import { relativeTime } from "@web/lib/relative-time";
import { useNow } from "@web/lib/use-now";
import { AdoptDialog } from "@web/routes/AdoptDialog";
import { CreateAppDialog } from "@web/routes/CreateAppDialog";
import { useState } from "react";
import { Link } from "react-router-dom";

/**
 * `statusDetail` is null exactly when `statusFor` reports `unknown` (zero expected
 * services, or an unreadable compose file) — never when the app is actually healthy.
 * `src/shared/status-phrase.ts` owns the full cause mapping, but that mapping runs over
 * a `ProbeSnapshot` (`kind` + `faultClass`), neither of which an `AdminApp` row carries;
 * only `status` is known here. So this is a smaller, status-only fallback rather than a
 * bent version of that module. It shares its wording with `status-phrase.ts` for the
 * two cases both cover (`unknown`, `starting`).
 */
const STATUS_FALLBACK: Record<AppStatus, string> = {
  up: "Healthy",
  starting: "Starting",
  unknown: "Not checked yet",
  degraded: "Degraded",
  down: "Down",
};

const ROW_BUTTON_CLASS =
  "rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-800";

/**
 * Spec §8's "row actions" — deploy, restart, and a shortcut straight into the compose
 * editor — reachable without leaving the inventory. Every one of these is already
 * reachable from the edit page's own `ActionBar`; this exists purely so the spec's row
 * actions aren't missing, the gap 1E's Self-Review wrongly claimed was already closed
 * (Task 11).
 *
 * Goes through `useAppActions`, the exact hook `ActionBar` itself uses, rather than a
 * second POST-and-track implementation — one job runner, one set of semantics, so a row
 * action and the edit page's button cannot diverge on what "deploy" means or on how a 409
 * reads. `handleJobDone` (from that hook) invalidates only `adminAppKey(app.id)` and
 * `adminAppKey(app.slug)`, and separately patches this row's cached `runningJobId` in
 * `adminAppsKey` — it never invalidates that whole-inventory rollup, which is what `GET
 * /api/apps` computes by spawning up to four `docker compose config` processes. A row
 * action re-fetching all of it to update one row is the mistake 1E already made once and
 * fixed; reusing the hook is what makes it structurally impossible to make again here.
 *
 * Passes `app.runningJobId` — `GET /api/apps`'s own grouped query, see `running-jobs.ts`
 * — as `knownRunningJobId`, so this row skips `useAppActions`' default `useJobs` poll of
 * `GET /api/apps/:id/jobs`. Without it, an inventory of twenty apps fired twenty of those
 * on load, each fetching one app's entire job history to answer a yes-or-no question
 * `GET /api/apps` already answered for every row in one query. `ActionBar` does not pass
 * this — a single-app view has no list row to read it from — so it keeps its own poll,
 * which is correct there.
 *
 * Restart is the one that confirms: unlike Deploy (idempotent when nothing changed) or
 * the editor shortcut (pure navigation), it stops and starts the app's containers,
 * interrupting whatever was using it, however briefly.
 */
function RowActions({ app }: { app: AdminApp }) {
  const { busy, activeJobId, actionError, setActionError, startJob, handleJobDone } = useAppActions(
    app,
    { knownRunningJobId: app.runningJobId },
  );
  const [confirmingRestart, setConfirmingRestart] = useState(false);

  function handleDeploy() {
    startJob("up").catch((error: unknown) => setActionError(describeActionError(error)));
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} onClick={handleDeploy} className={ROW_BUTTON_CLASS}>
          Deploy
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmingRestart(true)}
          className={ROW_BUTTON_CLASS}
        >
          Restart
        </button>
        <Link to={`/apps/${app.slug}/config`} className={ROW_BUTTON_CLASS}>
          Open in editor
        </Link>
      </div>

      {actionError && <p className="text-xs text-rose-600 dark:text-rose-400">{actionError}</p>}

      {activeJobId !== null && <JobOutput jobId={activeJobId} onDone={handleJobDone} />}

      {confirmingRestart && (
        <ConfirmDialog
          title="Restart app"
          message={`Restart ${app.displayName}? This briefly stops and starts its containers.`}
          confirmLabel="Restart"
          destructive
          onConfirm={() => startJob("restart")}
          onClose={() => setConfirmingRestart(false)}
          formatError={describeActionError}
        />
      )}
    </div>
  );
}

export function AdminApps() {
  const { data, isError } = useAdminApps();
  const [adopting, setAdopting] = useState(false);
  const [creating, setCreating] = useState(false);
  const now = useNow();

  // `isError` alone throws away rows that are still in hand. The launcher shipped
  // exactly that bug: a failed background refetch replaced a working grid, and whatever
  // the user was typing, with an error message. Keep the rows and say they may be stale.
  if (isError && !data)
    return <p className="p-6 text-sm text-rose-600">Could not load your apps.</p>;

  const apps = data ?? [];

  return (
    <div className={PAGE_SHELL}>
      <div className="mb-4 flex items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">Apps</h1>
        <button
          type="button"
          onClick={() => setAdopting(true)}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
        >
          Adopt from disk
        </button>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white dark:bg-slate-100 dark:text-slate-900"
        >
          Create app
        </button>
      </div>

      {apps.length === 0 ? (
        <p className="text-sm text-slate-500">
          No apps yet. Adopt one already on disk, or create a new one.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="hidden bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 md:table-header-group dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">App</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Directory</th>
                <th className="px-4 py-2 font-medium">Last deploy</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="block md:table-row-group">
              {apps.map((app) => (
                <tr
                  key={app.id}
                  className="block border-t border-slate-200 p-3 first:border-t-0 md:table-row md:border-t md:p-0 dark:border-slate-800"
                >
                  <td className="block md:table-cell md:px-4 md:py-2">
                    <Link to={`/apps/${app.slug}`} className="flex items-center gap-3">
                      <AppIcon iconRef={app.iconRef} displayName={app.displayName} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-1.5 truncate font-medium text-slate-900 dark:text-slate-100">
                          {app.displayName}
                          {app.systemKind !== null && (
                            <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              System
                            </span>
                          )}
                          {!app.showOnLauncher && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                              Hidden
                            </span>
                          )}
                        </p>
                      </div>
                    </Link>
                  </td>
                  <td className="mt-2 block md:mt-0 md:table-cell md:px-4 md:py-2">
                    <StatusChip
                      status={app.status}
                      reason={app.statusDetail ?? STATUS_FALLBACK[app.status]}
                      since={null}
                    />
                  </td>
                  <td className="mt-2 block truncate text-xs text-slate-500 md:mt-0 md:table-cell md:px-4 md:py-2 md:text-sm dark:text-slate-400">
                    {app.directory}
                  </td>
                  <td className="mt-2 block text-xs text-slate-500 md:mt-0 md:table-cell md:px-4 md:py-2 md:text-sm dark:text-slate-400">
                    {app.lastDeployAt === null
                      ? "Never"
                      : `${relativeTime(app.lastDeployAt, now)} ago`}
                  </td>
                  <td className="mt-2 block md:mt-0 md:table-cell md:px-4 md:py-2">
                    <RowActions app={app} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adopting && <AdoptDialog onClose={() => setAdopting(false)} />}
      {creating && <CreateAppDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
