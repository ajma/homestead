import type { OperationKind } from "@shared/projects.js";
import { useId, useState } from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  useMatch,
  useParams,
} from "react-router-dom";
import {
  Button,
  EmptyState,
  Panel,
  Spinner,
  StatusDot,
  Tabs,
} from "../components/ui/index.js";
import { ApiError } from "../lib/api.js";
import {
  hasRunningOperation,
  lifecycleErrorMessage,
  useLifecycle,
  useProject,
  useProjectOperations,
} from "../lib/queries.js";
import { Overview } from "./project/Overview.js";
import { projectStatus } from "./project/status.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "edit", label: "Edit" },
  { id: "logs", label: "Logs" },
] as const;

/**
 * The four verbs the server accepts, in the order a person reaches for them.
 * `down` is `danger`-toned because it removes containers.
 */
const VERBS: {
  verb: OperationKind;
  label: string;
  variant: "primary" | "secondary" | "danger";
}[] = [
  { verb: "up", label: "Start", variant: "primary" },
  { verb: "down", label: "Stop", variant: "danger" },
  { verb: "restart", label: "Restart", variant: "secondary" },
  { verb: "pull", label: "Pull", variant: "secondary" },
];

function BackLink() {
  return (
    <Link
      to="/projects"
      aria-label="Back to projects"
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text transition hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M15 19 8 12l7-7" />
      </svg>
    </Link>
  );
}

function Placeholder({ title, children }: { title: string; children: string }) {
  return (
    <Panel title={title}>
      <p className="text-sm text-muted">{children}</p>
    </Panel>
  );
}

/** Replaced by the compose editor in Plan 4. */
function ComposeEditorRoute() {
  return (
    <Placeholder title="Compose editor">
      Editing the compose file is not available yet.
    </Placeholder>
  );
}

/** Replaced by the log viewer in Task 9. */
function LogsRoute() {
  return (
    <Placeholder title="Logs">Streaming logs is not available yet.</Placeholder>
  );
}

/**
 * Overview is rendered by {@link ProjectDetail} itself, because at `lg` and
 * above it is a sidebar that stays put while the other tabs change. This route
 * exists so the tab owns a URL.
 */
function OverviewRoute() {
  return null;
}

export function ProjectDetail() {
  const { slug = "" } = useParams();
  const match = useMatch("/projects/:slug/:tab");
  const activeTab = match?.params.tab ?? "overview";
  const onOverview = activeTab === "overview";

  const detail = useProject(slug);
  const operations = useProjectOperations(slug);
  const lifecycle = useLifecycle(slug);

  // Local, not global and not cache: the id belongs to this project's page for
  // the lifetime of that page. Task 8's OperationPanel takes it as a prop.
  const [activeOperationId, setActiveOperationId] = useState<string | null>(
    null,
  );
  const [overviewOpen, setOverviewOpen] = useState(true);
  const overviewId = useId();

  if (detail.isPending)
    return (
      <main className="flex justify-center p-12 text-muted">
        <Spinner />
      </main>
    );

  if (detail.error) {
    const refused =
      detail.error instanceof ApiError &&
      (detail.error.status === 401 || detail.error.status === 403);
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
        <BackLink />
        {refused ? (
          // Every endpoint this page needs is admin-only, so a viewer's whole
          // page is a 403. That is a state, not a crash, and not something to
          // keep retrying.
          <EmptyState
            title="You do not have access"
            description="Viewing a project needs an administrator account. Ask an administrator to grant you access."
          />
        ) : detail.error instanceof ApiError && detail.error.status === 404 ? (
          <EmptyState
            title="No such project"
            description="This directory is no longer under the projects root."
          />
        ) : (
          <p role="alert" className="mt-6 text-sm text-danger">
            Could not load this project. {detail.error.message}
          </p>
        )}
      </main>
    );
  }

  const data = detail.data;
  if (!data)
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
        <BackLink />
        <EmptyState
          title="No project data"
          description="The server answered without a body. Try again."
        />
      </main>
    );

  const status = projectStatus(data.states);
  // Another tab or another admin can start an operation, so "in flight" is
  // whatever the server reports, not only what this page just posted.
  const busy =
    lifecycle.isPending || hasRunningOperation(operations.data ?? []);

  return (
    <main className="flex w-full flex-1 flex-col">
      <div className="border-b border-border bg-surface px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <BackLink />
          <h1 className="min-w-0 flex-1 truncate text-xl font-semibold text-text">
            {slug}
          </h1>
          <StatusDot
            state={status.state}
            label={status.label}
            className="shrink-0 text-muted"
          />
        </div>
        {/* Outside the collapsible Overview, and present at every width:
            restarting a stack from a phone is the primary mobile job. */}
        <div className="mt-3 flex flex-wrap gap-2">
          {VERBS.map(({ verb, label, variant }) => (
            <Button
              key={verb}
              variant={variant}
              disabled={busy}
              onClick={() =>
                lifecycle.mutate(verb, { onSuccess: setActiveOperationId })
              }
            >
              {label}
            </Button>
          ))}
        </div>
        {lifecycle.isError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {lifecycleErrorMessage(lifecycle.error)}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4 p-4 sm:p-6">
        {activeOperationId && (
          <Panel
            title="Operation"
            role="region"
            aria-label="Operation"
            data-operation-id={activeOperationId}
            actions={
              <Button size="sm" onClick={() => setActiveOperationId(null)}>
                Dismiss
              </Button>
            }
          >
            {/* Task 8 replaces this body with OperationPanel, which streams
                the operation's output over SSE. */}
            <p className="text-sm text-muted">
              Started. Live output arrives with the operation panel.
            </p>
          </Panel>
        )}

        <Tabs
          items={TABS.map((tab) => ({
            id: tab.id,
            label: tab.label,
            href: `/projects/${slug}/${tab.id}`,
          }))}
          activeId={activeTab}
        />

        <div className="lg:flex lg:items-start lg:gap-6">
          <aside
            aria-label="Overview"
            className={`min-w-0 ${
              onOverview
                ? "block lg:flex-1"
                : "hidden lg:block lg:w-80 lg:shrink-0"
            }`}
          >
            <div className="mb-3 hidden lg:flex">
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={overviewOpen}
                aria-controls={overviewId}
                onClick={() => setOverviewOpen(!overviewOpen)}
              >
                {overviewOpen ? "Hide overview" : "Show overview"}
              </Button>
            </div>
            <div id={overviewId} className={overviewOpen ? "" : "lg:hidden"}>
              <Overview slug={slug} detail={data} />
            </div>
          </aside>
          <div className={`min-w-0 flex-1 ${onOverview ? "hidden" : ""}`}>
            <Outlet />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Registered from `App.tsx` so there is one definition of these paths, and the
 * unit tests exercise the same tree the app mounts.
 */
export const projectDetailRoute = (
  <Route path="/projects/:slug" element={<ProjectDetail />}>
    <Route index element={<Navigate to="overview" replace />} />
    <Route path="overview" element={<OverviewRoute />} />
    <Route path="edit" element={<ComposeEditorRoute />} />
    <Route path="logs" element={<LogsRoute />} />
  </Route>
);
