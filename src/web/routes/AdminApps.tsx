import type { AdminApp } from "@shared/dto";
import { SEVERITY } from "@shared/status-phrase";
import type { AppStatus } from "@shared/types";
import { useAdminApps } from "@web/api/admin";
import { AppIcon } from "@web/components/AppIcon";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { JobOutput } from "@web/components/JobOutput";
import { StatusChip } from "@web/components/StatusChip";
import { type ActionKind, describeActionError, useAppActions } from "@web/components/useAppActions";
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

/**
 * `true` for any status that means "something is running" — the condition the
 * Start/Stop toggle switches on (Stop when running, Start when not). `down` and
 * `unknown` both read as "nothing to stop": `down` is the rollup's own "at least one
 * service missing/failing" bucket, which for a fully-stopped app is every service
 * missing, and `unknown` covers a compose file with no expected services at all (or one
 * that cannot be resolved) — neither has anything a Stop action could act on.
 */
function isRunning(status: AppStatus): boolean {
  return status === "up" || status === "degraded" || status === "starting";
}

const ICON_BUTTON_CLASS =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-transparent dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900";

/**
 * Every icon here is decorative only: the button/link carrying it already has its own
 * `aria-label` (below), the same "purely visual cue, kept out of the accessibility tree"
 * choice `OverviewTab`'s chevron makes — `aria-hidden="true"` on the `<svg>` itself,
 * spelled out on each one (not spread from a shared object) so it stays visible to a
 * static a11y lint pass, not just to a browser.
 */

/** A looping arrow — Restart. Stroke-based, matching the chevron `OverviewTab` added
 *  for its Advanced section, the one other inline SVG in the codebase. */
function RestartIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M15.5 6.5A6 6 0 1 0 16 10" />
      <path d="M16 4v3h-3" />
    </svg>
  );
}

/** A play triangle — Start. */
function StartIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M6 4.3v11.4a.6.6 0 0 0 .93.5l9-5.7a.6.6 0 0 0 0-1l-9-5.7a.6.6 0 0 0-.93.5Z" />
    </svg>
  );
}

/** A filled square — Stop. */
function StopIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <rect x="5" y="5" width="10" height="10" rx="1.5" />
    </svg>
  );
}

/** A pencil over a line — Open in editor. */
function EditIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M4 16v-2.5L13 4.5l2.5 2.5L6.5 16H4Z" />
      <path d="M11.5 6 14 8.5" />
    </svg>
  );
}

/**
 * Spec §8's "row actions" — restart, a Start/Stop toggle, and a shortcut straight into
 * the compose editor — reachable without leaving the inventory, as icon buttons rather
 * than text (Phase 1I: text buttons in a seven-column table read as noisy, and icons
 * shrink the row enough to matter on a phone, where this table is already responsive).
 * Every one of these is reachable from the edit page's own `ActionBar`; this exists
 * purely so the inventory's own row actions aren't missing.
 *
 * **No Deploy button.** Deploy was `up` under another name — removing it here is a
 * relabelling plus a condition (Start already covers "run `up` on a stopped app"), not a
 * capability loss: `up` remains available, unconditionally, from the edit page's own
 * `ActionBar`. **Start/Stop is a toggle over that same `up`/`down` pair**, not a new job
 * kind — `isRunning` (this file) picks which one shows, so exactly one of the two is
 * ever on screen for a given row, never both.
 *
 * **Every icon button carries `aria-label` and `title`**: an icon-only control with no
 * accessible name is unusable with a screen reader (there is no visible text for one to
 * read) and ambiguous with a mouse (nothing but the icon's shape says what it does) —
 * `title` gives the same sighted user a tooltip on hover, `aria-label` gives assistive
 * tech the equivalent.
 *
 * Goes through `useAppActions`, the exact hook `ActionBar` itself uses, rather than a
 * second POST-and-track implementation — one job runner, one set of semantics, so a row
 * action and the edit page's button cannot diverge on what "restart" or "stop" means, or
 * on how a 409 reads. `handleJobDone` (from that hook) invalidates only
 * `adminAppKey(app.id)` and `adminAppKey(app.slug)`, and separately patches this row's
 * cached `runningJobId` in `adminAppsKey` — it never invalidates that whole-inventory
 * rollup, which is what `GET /api/apps` computes by spawning up to four `docker compose
 * config` processes plus a bounded batch of container inspects. A row action re-fetching
 * all of it to update one row is the mistake 1E already made once and fixed; reusing the
 * hook is what makes it structurally impossible to make again here.
 *
 * Passes `app.runningJobId` — `GET /api/apps`'s own grouped query, see `running-jobs.ts`
 * — as `knownRunningJobId`, so this row skips `useAppActions`' default `useJobs` poll of
 * `GET /api/apps/:id/jobs`. Without it, an inventory of twenty apps fired twenty of those
 * on load, each fetching one app's entire job history to answer a yes-or-no question
 * `GET /api/apps` already answered for every row in one query. `ActionBar` does not pass
 * this — a single-app view has no list row to read it from — so it keeps its own poll,
 * which is correct there.
 *
 * **Stop is the one that confirms**, through the existing `ConfirmDialog`: it takes the
 * app down until someone starts it again, not a brief interruption. Restart and Start
 * both do not — restart is a brief stop-and-start (the containers come straight back),
 * and Start has nothing running to interrupt.
 */
function RowActions({ app }: { app: AdminApp }) {
  const { busy, activeJobId, actionError, setActionError, startJob, handleJobDone } = useAppActions(
    app,
    { knownRunningJobId: app.runningJobId },
  );
  const [confirmingStop, setConfirmingStop] = useState(false);

  function run(kind: ActionKind) {
    startJob(kind).catch((error: unknown) => setActionError(describeActionError(error)));
  }

  const running = isRunning(app.status);

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-1.5">
        {running ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingStop(true)}
            title="Stop"
            aria-label="Stop"
            className={ICON_BUTTON_CLASS}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => run("up")}
            title="Start"
            aria-label="Start"
            className={ICON_BUTTON_CLASS}
          >
            <StartIcon />
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => run("restart")}
          title="Restart"
          aria-label="Restart"
          className={ICON_BUTTON_CLASS}
        >
          <RestartIcon />
        </button>
        <Link
          to={`/apps/${app.slug}/config`}
          title="Open in editor"
          aria-label="Open in editor"
          className={ICON_BUTTON_CLASS}
        >
          <EditIcon />
        </Link>
      </div>

      {actionError && <p className="text-xs text-rose-600 dark:text-rose-400">{actionError}</p>}

      {activeJobId !== null && <JobOutput jobId={activeJobId} onDone={handleJobDone} />}

      {confirmingStop && (
        <ConfirmDialog
          title="Stop app"
          message={`Stop ${app.displayName}? This takes down its containers until you start it again.`}
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

/** Every sortable column. `actions` is deliberately excluded — a row's buttons have no
 *  natural order. */
type SortKey = "app" | "status" | "uptime" | "exposure" | "ports" | "lastDeploy";

type SortState = { key: SortKey; direction: "asc" | "desc" };

/**
 * Nulls always sort last, in both directions — an app that is stopped has no uptime, one
 * that is not exposed has no hostname, one with no published ports has no ports, and one
 * never deployed has no deploy date. Sorting those naturally would open "sort by uptime"
 * on a screen of dashes, the opposite of useful. `ascending` only ever flips the
 * *non-null* comparison; the null placement itself is direction-invariant, which is why
 * this doesn't just sort ascending and `.reverse()` the whole array (that would carry
 * nulls back to the front on the way down).
 */
function compareWithNullsLast<T>(
  a: T | null,
  b: T | null,
  ascending: boolean,
  compareValues: (x: T, y: T) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result = compareValues(a, b);
  return ascending ? result : -result;
}

/** An app publishes several ports; the lowest is the one a person scans for. `ports` is
 *  already deduplicated ascending (see `AdminApp`'s own doc comment), so `[0]` would do,
 *  but `Math.min` doesn't depend on that upstream guarantee holding forever. */
function lowestPort(ports: number[]): number | null {
  return ports.length === 0 ? null : Math.min(...ports);
}

/**
 * One comparator per sortable column, each already encoding what "ascending" means for
 * its own domain — not always "the raw value, low to high, first" (see `status` below).
 * `ascending` is passed in rather than applied by the caller afterwards, so nulls-last
 * placement (`compareWithNullsLast`) stays direction-invariant while everything else
 * about the comparison still flips.
 */
const SORT_COMPARATORS: Record<SortKey, (a: AdminApp, b: AdminApp, ascending: boolean) => number> =
  {
    app: (a, b, ascending) => {
      const result = a.displayName.localeCompare(b.displayName);
      return ascending ? result : -result;
    },
    // Worst-wins severity (`SEVERITY`, from `status-phrase.ts` — the same ranking
    // `rollUpProbes` uses to pick which probe names an app's status), not alphabetical:
    // alphabetical order ("degraded, down, starting, unknown, up") is meaningless.
    // Ascending is defined as *most* severe first, so the very first click on this
    // column surfaces what needs attention, matching every other column's "click once,
    // see something useful" contract.
    status: (a, b, ascending) => {
      const result = SEVERITY[b.status] - SEVERITY[a.status];
      return ascending ? result : -result;
    },
    uptime: (a, b, ascending) =>
      compareWithNullsLast(a.uptimeSince, b.uptimeSince, ascending, (x, y) => x - y),
    exposure: (a, b, ascending) =>
      compareWithNullsLast(a.exposureHostname, b.exposureHostname, ascending, (x, y) =>
        x.localeCompare(y),
      ),
    ports: (a, b, ascending) =>
      compareWithNullsLast(lowestPort(a.ports), lowestPort(b.ports), ascending, (x, y) => x - y),
    lastDeploy: (a, b, ascending) =>
      compareWithNullsLast(a.lastDeployAt, b.lastDeployAt, ascending, (x, y) => x - y),
  };

/**
 * The chevron `OverviewTab` added for its Advanced section — the one other inline SVG in
 * the codebase — repurposed as a sort direction cue: pointing down for descending
 * (unrotated, same as that chevron's collapsed state), rotated to point up for ascending.
 * Purely visual, kept out of the accessibility tree the same way: `aria-sort` on the
 * `<th>` is what assistive tech reads, this is a redundant cue for sighted users only.
 */
function SortIndicator({ direction }: { direction: "asc" | "desc" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${
        direction === "asc" ? "rotate-180" : ""
      }`}
    >
      <path d="M5 7.5 10 12.5 15 7.5" />
    </svg>
  );
}

/**
 * A sortable column header. The clickable surface is a real `<button>`, not a `<th>`
 * with an `onClick` — the latter is invisible to keyboard and screen-reader users, since
 * a table cell isn't a focusable, operable control on its own. `aria-sort` goes on the
 * `<th>` itself (where assistive tech looks for it), not the button.
 */
function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState | null;
  onSort: (key: SortKey) => void;
}) {
  const direction = sort?.key === sortKey ? sort.direction : null;
  return (
    <th
      className="px-4 py-2 font-medium"
      aria-sort={direction === null ? "none" : direction === "asc" ? "ascending" : "descending"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1 font-medium uppercase tracking-wide hover:text-slate-700 dark:hover:text-slate-200"
      >
        {label}
        {direction !== null && <SortIndicator direction={direction} />}
      </button>
    </th>
  );
}

/** A fresh, sorted copy of `apps` — never mutates the query cache's own array. Dozens of
 *  rows, recomputed on demand rather than memoized: sorting a home NAS's app list costs
 *  nothing worth guarding against a re-render for. */
function sortApps(apps: AdminApp[], sort: SortState): AdminApp[] {
  const comparator = SORT_COMPARATORS[sort.key];
  const ascending = sort.direction === "asc";
  return [...apps].sort((a, b) => comparator(a, b, ascending));
}

export function AdminApps() {
  const { data, isError } = useAdminApps();
  const [adopting, setAdopting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);
  const now = useNow();

  // `isError` alone throws away rows that are still in hand. The launcher shipped
  // exactly that bug: a failed background refetch replaced a working grid, and whatever
  // the user was typing, with an error message. Keep the rows and say they may be stale.
  if (isError && !data)
    return <p className="p-6 text-sm text-rose-600">Could not load your apps.</p>;

  const apps = data ?? [];

  // Client-side only: the list is already fully loaded (`useAdminApps` has no paging),
  // and a home NAS has dozens of apps, not thousands — nothing here justifies a server
  // round-trip. `sort === null` is "whatever today's default order is", i.e. exactly
  // `apps` — nothing has been clicked yet, so nothing should reorder.
  const sortedApps = sort === null ? apps : sortApps(apps, sort);

  function toggleSort(key: SortKey) {
    // A new column always starts ascending; the already-active one flips. No third
    // "unsorted" state to cycle back through — fiddly, and nobody asked for it.
    setSort((prev) =>
      prev?.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  }

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
                <SortableHeader label="App" sortKey="app" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Uptime" sortKey="uptime" sort={sort} onSort={toggleSort} />
                <SortableHeader
                  label="Exposure"
                  sortKey="exposure"
                  sort={sort}
                  onSort={toggleSort}
                />
                <SortableHeader label="Ports" sortKey="ports" sort={sort} onSort={toggleSort} />
                <SortableHeader
                  label="Last deploy"
                  sortKey="lastDeploy"
                  sort={sort}
                  onSort={toggleSort}
                />
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="block md:table-row-group">
              {sortedApps.map((app) => (
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
                  <td className="mt-2 block text-xs text-slate-500 md:mt-0 md:table-cell md:px-4 md:py-2 md:text-sm dark:text-slate-400">
                    {app.uptimeSince === null ? "—" : relativeTime(app.uptimeSince, now)}
                  </td>
                  <td className="mt-2 block truncate text-xs text-slate-500 md:mt-0 md:table-cell md:px-4 md:py-2 md:text-sm dark:text-slate-400">
                    {app.exposureHostname ?? "Not exposed"}
                  </td>
                  <td className="mt-2 block text-xs text-slate-500 md:mt-0 md:table-cell md:px-4 md:py-2 md:text-sm dark:text-slate-400">
                    {app.ports.length === 0 ? "—" : app.ports.join(", ")}
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
