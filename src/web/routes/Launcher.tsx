import type { LauncherApp } from "@shared/launcher";
import { useLauncherApps } from "@web/api/launcher";
import { AppCard } from "@web/components/AppCard";
import { HealthPanel } from "@web/components/HealthPanel";
import { PAGE_SHELL, SECTION_GAP } from "@web/lib/density";
import { useMemo, useState } from "react";

const UNGROUPED = "Apps";

function groupByCategory(apps: LauncherApp[]): Array<[string, LauncherApp[]]> {
  const groups = new Map<string, LauncherApp[]>();
  for (const app of apps) {
    const key = app.category ?? UNGROUPED;
    groups.set(key, [...(groups.get(key) ?? []), app]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function Launcher() {
  const { data, isLoadingError, isRefetchError, isPending } = useLauncherApps();
  const [query, setQuery] = useState("");
  const [openApp, setOpenApp] = useState<LauncherApp | null>(null);

  const filtered = useMemo(() => {
    const apps = data ?? [];
    const needle = query.trim().toLowerCase();
    if (needle === "") return apps;
    return apps.filter(
      (app) =>
        app.displayName.toLowerCase().includes(needle) ||
        (app.description ?? "").toLowerCase().includes(needle) ||
        (app.category ?? "").toLowerCase().includes(needle),
    );
  }, [data, query]);

  // `isPending` is only true with nothing cached. With cached data we render it and let
  // the background refetch correct it — stale status beats a spinner.
  if (isPending) return <p className="p-6 text-sm text-slate-500">Loading apps…</p>;
  // `isLoadingError` means there is no data to fall back on — that's the only time an
  // error screen is allowed to replace the grid. TanStack Query keeps the last good
  // `data` across a failed *refetch* (`isRefetchError`), and the reconnect path makes
  // that refetch common: the event stream invalidates this query on every reconnect,
  // and the server closes streams every 15 minutes and on every user edit. Blanking a
  // working launcher on one of those failures would throw away a populated grid — and
  // whatever the user was mid-way through typing into search — for a transient blip.
  if (isLoadingError) {
    return (
      <p className="p-6 text-sm text-rose-600 dark:text-rose-400">
        Could not load your apps. Homestead may be restarting.
      </p>
    );
  }

  return (
    <div className={PAGE_SHELL}>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search apps"
        aria-label="Search apps"
        className="mb-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900"
      />

      {isRefetchError && (
        <p className="mb-4 text-xs text-amber-600 dark:text-amber-400">
          Showing the last known status — Homestead couldn’t refresh just now.
        </p>
      )}

      {(data ?? []).length === 0 && (
        <p className="text-sm text-slate-500">No apps yet. An admin can adopt one from disk.</p>
      )}
      {(data ?? []).length > 0 && filtered.length === 0 && (
        <p className="text-sm text-slate-500">No apps match “{query}”.</p>
      )}

      <div className={SECTION_GAP}>
        {groupByCategory(filtered).map(([category, apps]) => (
          <section key={category}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {category}
            </h2>
            {/* 2-up on phone, up to 6 across on a wide desktop. `xl:grid-cols-5` used to
                never fire: the page shell capped out at 1024px before that breakpoint
                (1280px) could matter. With the cap lifted (see `density.ts`), it does,
                and `2xl:grid-cols-6` gives the wider end of the density band one more
                step — density here means more tiles visible, not more text per tile. */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {apps.map((app) => (
                <AppCard key={app.id} app={app} onOpenHealth={() => setOpenApp(app)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {openApp !== null && (
        <HealthPanel
          appId={openApp.id}
          appName={openApp.displayName}
          onClose={() => setOpenApp(null)}
        />
      )}
    </div>
  );
}
