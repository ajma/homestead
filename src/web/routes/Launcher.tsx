import type { LauncherApp } from "@shared/launcher";
import { useLauncherApps } from "@web/api/launcher";
import { AppCard } from "@web/components/AppCard";
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
  const { data, isError, isPending } = useLauncherApps();
  const [query, setQuery] = useState("");

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
  if (isError) {
    return (
      <p className="p-6 text-sm text-rose-600 dark:text-rose-400">
        Could not load your apps. Homestead may be restarting.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search apps"
        aria-label="Search apps"
        className="mb-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900"
      />

      {(data ?? []).length === 0 && (
        <p className="text-sm text-slate-500">No apps yet. An admin can adopt one from disk.</p>
      )}
      {(data ?? []).length > 0 && filtered.length === 0 && (
        <p className="text-sm text-slate-500">No apps match “{query}”.</p>
      )}

      {groupByCategory(filtered).map(([category, apps]) => (
        <section key={category} className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {category}
          </h2>
          {/* 2-up on phone, up to 5 across on a wide desktop. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {apps.map((app) => (
              <AppCard key={app.id} app={app} onOpenHealth={() => {}} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
