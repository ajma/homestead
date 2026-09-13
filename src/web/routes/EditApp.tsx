import type { AdminApp } from "@shared/dto";
import type { AppStatus } from "@shared/types";
import { useAdminApp } from "@web/api/admin";
import { ActionBar } from "@web/components/ActionBar";
import { AppIcon } from "@web/components/AppIcon";
import { ImageUpdates } from "@web/components/ImageUpdates";
import { StatusChip } from "@web/components/StatusChip";
import { relativeTime } from "@web/lib/relative-time";
import { useNow } from "@web/lib/use-now";
import { Link, NavLink, Outlet, useParams } from "react-router-dom";

/**
 * Same fallback wording as `AdminApps.tsx`'s `STATUS_FALLBACK`, kept as its own small
 * copy rather than a shared import: both are "only `status` is known here" fallbacks
 * for the two views that render a chip without the full `ProbeSnapshot` that
 * `status-phrase.ts` needs, and neither owns the other.
 */
const STATUS_FALLBACK: Record<AppStatus, string> = {
  up: "Healthy",
  starting: "Starting",
  unknown: "Not checked yet",
  degraded: "Degraded",
  down: "Down",
};

/**
 * `overview`, `containers`, `logs`, `probes`, `config`, `exposure` — Phase 1F's full set
 * plus 2F Task 3's exposure tab, with the former `compose` and `env` tabs now merged into
 * one `config` tab (`ConfigTab`, which renders `ComposeTab` and `EnvTab` side by side; see
 * that file). A list rather than literals scattered across the nav markup, so a later tab
 * is one entry here plus one child `<Route>` in `App.tsx` — not a hunt through JSX.
 */
const TABS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "overview", label: "Overview" },
  { to: "containers", label: "Containers" },
  { to: "logs", label: "Logs" },
  { to: "probes", label: "Probes" },
  { to: "config", label: "Config" },
  { to: "exposure", label: "Exposure" },
];

/**
 * What `<Outlet context>` hands each tab. Tasks 7-9 read this with `useOutletContext`
 * instead of each re-resolving `:slug` against `useAdminApps()` themselves — the point
 * of resolving it once here.
 */
export type EditAppContext = { app: AdminApp };

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between gap-3 truncate">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="truncate text-right text-slate-900 dark:text-slate-100">{value}</span>
    </p>
  );
}

/**
 * Spec §8's right rail: "a persistent right rail on desktop carrying actions, exposure,
 * image updates, and metadata" — the metadata part, which 1E's Self-Review wrongly
 * claimed was already there (Task 11). Exposure is Phase 2 and stays out.
 *
 * `hidden lg:flex`, not conditionally rendered: on mobile the same space is the fixed
 * bottom action bar (`ActionBar`'s own layout classes on the `<aside>` below), and there
 * is no room to also show five rows of metadata beneath it. Every field here already
 * lives in `AdminApp`, so this is presentation only, no new fetch.
 */
function AppMetadata({ app, now }: { app: AdminApp; now: number }) {
  return (
    <div
      data-testid="app-metadata"
      className="hidden flex-col gap-1 rounded-2xl border border-slate-200 p-3 text-xs lg:flex dark:border-slate-800"
    >
      <MetaRow label="Directory" value={app.directory} />
      <MetaRow label="Compose file" value={app.composeFile} />
      <MetaRow label="Project name" value={app.projectName} />
      <MetaRow label="Adopted" value={`${relativeTime(app.adoptedAt, now)} ago`} />
      <MetaRow
        label="Last deploy"
        value={app.lastDeployAt === null ? "Never" : `${relativeTime(app.lastDeployAt, now)} ago`}
      />
    </div>
  );
}

function tabLinkClass({ isActive }: { isActive: boolean }): string {
  return `border-b-2 px-3 py-2 text-sm ${
    isActive
      ? "border-slate-900 font-medium text-slate-900 dark:border-slate-100 dark:text-slate-100"
      : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
  }`;
}

export function EditApp() {
  const { slug = "" } = useParams<{ slug: string }>();
  const now = useNow();
  // Resolves through the cheap single-app endpoint (`GET /api/apps/:id`, which accepts a
  // slug too — see `loadAppByIdOrSlug`), not `useAdminApps()`'s whole-inventory rollup.
  // The list query used to be made *active* on every edit page merely by being read here,
  // so any invalidation of it — a job finishing, a metadata save on any tab — refetched
  // up to sixty `docker compose config` spawns to update one chip. See the 1E final-fix
  // brief, Important 3.
  const { data: app, isPending } = useAdminApp(slug);

  if (!app) {
    // `isPending` only: nothing cached yet, so a spinner is honest and temporary. Once
    // the fetch has settled and there is still no app, that's not a state that a wait
    // will resolve — a typo'd URL, a deleted app, or an app outside this admin's scope
    // must say so plainly rather than spin forever.
    if (isPending) return <p className="p-6 text-sm text-slate-500">Loading…</p>;
    return (
      <div className="p-6">
        <p className="text-sm text-slate-600 dark:text-slate-400">No app called “{slug}”.</p>
        <Link
          to="/apps"
          className="mt-2 inline-block text-sm text-sky-600 hover:underline dark:text-sky-400"
        >
          Back to apps
        </Link>
      </div>
    );
  }

  return (
    <div className="pb-24 lg:pb-0">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
        <AppIcon iconRef={app.iconRef} displayName={app.displayName} size="sm" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{app.displayName}</h1>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{app.directory}</p>
        </div>
        <StatusChip
          status={app.status}
          reason={app.statusDetail ?? STATUS_FALLBACK[app.status]}
          since={null}
        />
      </header>

      <nav
        className="flex gap-1 border-b border-slate-200 px-4 dark:border-slate-800"
        aria-label="App sections"
      >
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={tabLinkClass}>
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {/*
       * One tree, Tailwind breakpoints only — no JS media query, which would re-render
       * on every resize and could disagree with CSS right at the breakpoint, and one
       * `ActionBar` instance rather than two: it opens a job-output SSE stream while a
       * job runs, and rendering a second copy for the other layout would open a second
       * stream nobody is looking at. Below `lg` its own classes make it a bar fixed to
       * the bottom of the viewport; at `lg` and up they make it a static column
       * alongside `main` instead.
       */}
      <div className="flex flex-col gap-4 p-4 lg:flex-row">
        <main className="min-w-0 flex-1">
          <Outlet context={{ app } satisfies EditAppContext} />
        </main>
        <aside className="fixed inset-x-0 bottom-0 z-10 flex flex-col gap-4 border-t border-slate-200 bg-white p-3 lg:static lg:z-auto lg:w-72 lg:shrink-0 lg:border-t-0 lg:bg-transparent lg:p-0 dark:border-slate-800 dark:bg-slate-950 lg:dark:bg-transparent">
          <ActionBar app={app} />
          <ImageUpdates appId={app.id} />
          <AppMetadata app={app} now={now} />
        </aside>
      </div>
    </div>
  );
}
