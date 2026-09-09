import type { AppSummary } from "@shared/dashboard.js";
import type { MonitorSummary } from "@shared/monitoring.js";
import { useId, useState } from "react";
import {
  EmptyState,
  Spinner,
  StaleNotice,
  StatusDot,
} from "../components/ui/index.js";
import { monitorLabel } from "../lib/monitor-labels.js";
import { isRefusal, useDashboard } from "../lib/queries.js";

/** One check behind the dot: what it is, how it answered, and why if it failed. */
function MonitorRow({ monitor }: { monitor: MonitorSummary }) {
  return (
    <li className="flex items-start gap-2 py-1">
      <span className="mt-1 shrink-0">
        <StatusDot state={monitor.state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-sm text-text">{monitorLabel(monitor.type)}</span>
        {!monitor.required && (
          <span className="text-xs text-muted ml-1">(advisory)</span>
        )}
        {monitor.error && (
          <span className="block text-xs text-muted break-words">
            {monitor.error}
          </span>
        )}
      </span>
    </li>
  );
}

function AppTile({ app }: { app: AppSummary }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const isUp = app.status.state === "up";

  return (
    <article className="p-4 border border-border rounded-lg bg-surface">
      <div className="flex items-center gap-1">
        {/*
          The dot is the disclosure, per the tile's whole point: the dot is a
          rollup, and the question it provokes is "which part?". The button is
          sized to the 44px tap target the e2e sweeps enforce rather than to
          the glyph, which is far smaller than a fingertip.
        */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? "Hide" : "Show"} checks for ${app.name}`}
          className="grid place-items-center size-11 shrink-0 rounded-md hover:bg-raised"
        >
          <StatusDot state={app.status.state} />
        </button>
        {/*
          The name links out, the dot expands. Previously the whole tile was
          the link, which leaves nowhere to put a control: a button inside an
          anchor is not valid, and the browser would have to guess which of
          the two a tap meant.
        */}
        {/*
          Same resolution the project list uses: a slug goes through the
          cached icon endpoint, a URL is taken as given. Decorative, so
          `alt=""` — the name beside it already says which app this is, and
          announcing it twice only slows a screen reader down.
        */}
        {(app.iconSlug || app.iconUrl) && (
          <img
            src={
              app.iconSlug ? `/api/icons/${app.iconSlug}` : (app.iconUrl ?? "")
            }
            alt=""
            className="h-6 w-6 shrink-0 rounded"
          />
        )}
        {app.hostname ? (
          <a
            href={`https://${app.hostname}`}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate font-medium text-text hover:underline py-3"
          >
            {app.name}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate font-medium text-text">
            {app.name}
          </span>
        )}
      </div>

      {/*
        Clamped to two lines. A description is free text and a NAS project can
        justify a paragraph; unbounded, one verbose tile would set the height
        of its whole row in the grid.
      */}
      {app.description && (
        <p className="text-sm text-muted mt-1 line-clamp-2">
          {app.description}
        </p>
      )}

      {!isUp && app.tier && (
        <p className="text-sm text-muted mt-1">{app.tier}</p>
      )}

      {open && (
        <ul id={panelId} className="mt-2 border-t border-border pt-2">
          {app.monitors.length === 0 ? (
            <li className="text-sm text-muted">No checks yet</li>
          ) : (
            app.monitors.map((m) => <MonitorRow key={m.id} monitor={m} />)
          )}
        </ul>
      )}
    </article>
  );
}

export function Dashboard() {
  const { data, error, isPending } = useDashboard();

  if (isPending)
    return (
      <main className="mx-auto w-full max-w-6xl p-4 sm:p-8">
        <h1 className="text-2xl font-semibold text-text">Dashboard</h1>
        <div className="flex justify-center py-12 text-muted">
          <Spinner />
        </div>
      </main>
    );

  if (error && !data) {
    if (isRefusal(error))
      return (
        <main className="mx-auto w-full max-w-6xl p-4 sm:p-8">
          <h1 className="text-2xl font-semibold text-text">Dashboard</h1>
          <EmptyState
            title="You do not have access"
            description="Your account cannot view this page. Ask an administrator to grant access."
          />
        </main>
      );
    return (
      <main className="mx-auto w-full max-w-6xl p-4 sm:p-8">
        <h1 className="text-2xl font-semibold text-text">Dashboard</h1>
        <p role="alert" className="mt-6 text-sm text-danger">
          Could not load dashboard. {error.message}
        </p>
      </main>
    );
  }

  if (!data) return null;

  return (
    <main className="mx-auto w-full max-w-6xl p-4 sm:p-8">
      <h1 className="text-2xl font-semibold text-text">Dashboard</h1>
      {error && <StaleNotice className="mt-4" />}
      {data.apps.length === 0 && data.projectCount === null ? (
        <EmptyState
          title="Could not read projects directory"
          description="Homestead cannot access the projects directory. This is likely a permissions problem. Check that the directory is readable by the user running Homestead."
        />
      ) : data.apps.length === 0 && data.projectCount === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create your first project to get started."
        />
      ) : data.apps.length === 0 &&
        data.projectCount !== null &&
        data.projectCount > 0 ? (
        <EmptyState
          title="No apps yet"
          description="None of your projects publishes a port. Add a port mapping to see apps here."
        />
      ) : (
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.apps.map((app) => (
            <AppTile key={app.key} app={app} />
          ))}
        </div>
      )}
    </main>
  );
}
