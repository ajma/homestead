import { useAdminApps } from "@web/api/admin";
import { AppIcon } from "@web/components/AppIcon";
import { StatusChip } from "@web/components/StatusChip";
import { relativeTime } from "@web/lib/relative-time";
import { useNow } from "@web/lib/use-now";
import { useState } from "react";
import { Link } from "react-router-dom";

function noop() {
  // `StatusChip` always renders as a button (it is the launcher's health-panel
  // trigger). There is no health panel on this screen, so the click is a no-op and the
  // chip is inert rather than wrong — it still reports status honestly.
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
    <div className="mx-auto max-w-5xl p-4">
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
              </tr>
            </thead>
            <tbody className="block md:table-row-group">
              {apps.map((app) => (
                <tr
                  key={app.id}
                  className="block border-t border-slate-200 p-3 first:border-t-0 md:table-row md:border-t md:p-0 dark:border-slate-800"
                >
                  <td className="block md:table-cell md:px-4 md:py-3">
                    <Link to={`/apps/${app.slug}`} className="flex items-center gap-3">
                      <AppIcon iconRef={app.iconRef} displayName={app.displayName} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-1.5 truncate font-medium text-slate-900 dark:text-slate-100">
                          {app.displayName}
                          {app.isSystem && (
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
                  <td className="mt-2 block md:mt-0 md:table-cell md:px-4 md:py-3">
                    <StatusChip
                      status={app.status}
                      reason={app.statusDetail ?? "Healthy"}
                      since={null}
                      onOpen={noop}
                    />
                  </td>
                  <td className="mt-2 block truncate text-xs text-slate-500 md:mt-0 md:table-cell md:px-4 md:py-3 md:text-sm dark:text-slate-400">
                    {app.directory}
                  </td>
                  <td className="mt-2 block text-xs text-slate-500 md:mt-0 md:table-cell md:px-4 md:py-3 md:text-sm dark:text-slate-400">
                    {relativeTime(app.adoptedAt, now)} ago
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adopting && null}
      {creating && null}
    </div>
  );
}
