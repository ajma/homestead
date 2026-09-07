import type { AppSummary } from "@shared/dashboard.js";
import {
  EmptyState,
  Spinner,
  StaleNotice,
  StatusDot,
} from "../components/ui/index.js";
import { isRefusal, useDashboard } from "../lib/queries.js";

function AppTile({ app }: { app: AppSummary }) {
  const isUp = app.status.state === "up";
  const content = (
    <>
      <div className="flex items-center gap-3">
        <StatusDot state={app.status.state} />
        <span className="min-w-0 flex-1 truncate font-medium text-text">
          {app.name}
        </span>
      </div>
      {!isUp && app.tier && (
        <p className="text-sm text-muted mt-1">{app.tier}</p>
      )}
    </>
  );

  if (app.hostname) {
    return (
      <a
        href={`https://${app.hostname}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block p-4 border border-border rounded-lg bg-surface hover:bg-raised min-h-11"
      >
        <article>{content}</article>
      </a>
    );
  }

  return (
    <article className="p-4 border border-border rounded-lg bg-surface min-h-11">
      {content}
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
