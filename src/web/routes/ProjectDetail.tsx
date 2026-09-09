import type { ExposureSummary } from "@shared/cloudflare.js";
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
import { DeleteProjectDialog } from "../components/DeleteProjectDialog.js";
import {
  ExposureDialog,
  type PortOption,
} from "../components/ExposureDialog.js";
import { OperationPanel } from "../components/OperationPanel.js";
import { ProjectIdentityDialog } from "../components/ProjectIdentityDialog.js";
import {
  Button,
  EmptyState,
  Panel,
  Spinner,
  StaleNotice,
  StatusDot,
  Tabs,
} from "../components/ui/index.js";
import { ApiError } from "../lib/api.js";
import {
  hasRunningOperation,
  isRefusal,
  lifecycleErrorMessage,
  useExposures,
  useLifecycle,
  useProject,
  useProjectOperations,
} from "../lib/queries.js";
import { Edit } from "./project/Edit.js";
import { Logs } from "./project/Logs.js";
import { Overview } from "./project/Overview.js";
import { projectStatus } from "./project/status.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "edit", label: "Edit" },
  { id: "logs", label: "Logs" },
] as const;

/**
 * The four verbs the server accepts, in the order a person reaches for them.
 *
 * `down` is labelled for what `docker compose down` does — it deletes the
 * containers and networks — and is the only one that asks first. "Stop" was a
 * lie: a tap meant as "pause this for a minute", made on a phone, destroyed
 * everything the stack had not written to a named volume. The other three stay
 * one tap, because restarting from a phone is the primary mobile job and must
 * not grow friction.
 */
const VERBS: {
  verb: OperationKind;
  label: string;
  variant: "primary" | "secondary";
  confirm?: never;
}[] = [
  { verb: "up", label: "Start", variant: "primary" },
  // Plain "Stop", and no confirmation: `compose stop` leaves the containers,
  // the network and every volume in place, so there is nothing to warn about
  // and nothing to undo. This used to be "Stop & remove" running `down` —
  // honest about what it did, but it made pausing a stack a destructive act.
  // Removal now happens only when the project is deleted.
  { verb: "stop", label: "Stop", variant: "secondary" },
  { verb: "restart", label: "Restart", variant: "secondary" },
  { verb: "pull", label: "Pull", variant: "secondary" },
];

/** Why the controls are disabled — said out loud, not left to be inferred. */
const BUSY_REASON =
  "An operation is running for this project. The controls return when it finishes.";

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
  // Exposures are instance-wide; Overview narrows them to this project. A
  // viewer's request is refused, and the dialog is admin-only anyway, so an
  // empty list simply means no exposure state is shown.
  const exposures = useExposures();

  // Which exposure the dialog is editing, or the port it is being created for.
  // Local to the page, like the operation slot above it.
  const [exposing, setExposing] = useState<PortOption | null>(null);
  const [editingExposure, setEditingExposure] =
    useState<ExposureSummary | null>(null);
  const dialogOpen = exposing !== null || editingExposure !== null;
  const [editingIdentity, setEditingIdentity] = useState(false);

  // Local, not global and not cache: this belongs to this project's page for
  // the lifetime of that page. OperationPanel takes it as props.
  //
  // The verb travels with the id in one piece of state rather than two,
  // because they are one fact — a panel labelled `pull` while streaming a
  // `down` is worse than an unlabelled one — and two states can drift.
  const [activeOperation, setActiveOperation] = useState<{
    id: string;
    kind: OperationKind;
  } | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const overviewId = useId();
  const busyId = useId();

  const run = (verb: OperationKind) =>
    lifecycle.mutate(verb, {
      onSuccess: (id) => setActiveOperation({ id, kind: verb }),
    });

  if (detail.isPending)
    return (
      <main className="flex justify-center p-12 text-muted">
        <Spinner />
      </main>
    );

  // `detail.error && !detail.data`, never the error alone. This query is
  // refetched by window focus and by every operation that ends, and a failed
  // refetch keeps the last good `data` while flipping status to "error" — so
  // branching on the error first tears down the whole page, including a live
  // OperationPanel, closing its stream and discarding the output the user is
  // reading, because one unrelated background request failed.
  if (detail.error && !detail.data) {
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
        <BackLink />
        {isRefusal(detail.error) ? (
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
  // Flattened once for the exposure dialog's port picker: the service each
  // port belongs to is what makes the option readable.
  const projectPorts: PortOption[] = (data?.model?.services ?? []).flatMap(
    (service) => service.ports.map((p) => ({ ...p, service: service.name })),
  );
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
        <div
          role="toolbar"
          aria-label="Lifecycle controls"
          className="mt-3 flex flex-wrap gap-2"
        >
          {VERBS.map(({ verb, label, variant }) => (
            <Button
              key={verb}
              variant={variant}
              disabled={busy}
              // A disabled control that does not say why reads as broken.
              aria-describedby={busy ? busyId : undefined}
              title={busy ? BUSY_REASON : undefined}
              onClick={() => run(verb)}
            >
              {label}
            </Button>
          ))}
        </div>
        {busy && (
          <p id={busyId} className="mt-2 text-sm text-muted">
            {BUSY_REASON}
          </p>
        )}
        {/* Outside the lifecycle toolbar on purpose. Deleting the directory is
            not a fourth verb — it is the one action here that no later verb
            can undo — and grouping it with Restart invites the mis-tap. */}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            className="text-danger"
            disabled={busy}
            aria-describedby={busy ? busyId : undefined}
            title={busy ? BUSY_REASON : undefined}
            onClick={() => setDeleting(true)}
          >
            Delete project…
          </Button>
        </div>
        {/* Mounted only while open: the dialog's typed-slug field and its
            "already confirmed once" flag are local state, and unmounting is
            what guarantees a reopened dialog starts from the first question
            rather than resuming one the user escaped out of. */}
        {deleting && (
          <DeleteProjectDialog
            open
            onClose={() => setDeleting(false)}
            detail={data}
          />
        )}
        {/* Mounted only while open, like the delete dialog above: the form
            resets from its props, and a stale instance would reopen on the
            previous port. */}
        {editingIdentity && (
          <ProjectIdentityDialog
            open
            onClose={() => setEditingIdentity(false)}
            slug={slug}
            identity={data.identity}
          />
        )}
        {dialogOpen && (
          <ExposureDialog
            open
            onClose={() => {
              setExposing(null);
              setEditingExposure(null);
            }}
            exposure={editingExposure}
            projectSlug={slug}
            // All of the project's ports, with the clicked one selected — you
            // may well have meant the one next to it.
            ports={projectPorts}
            initialPort={exposing?.hostPort}
          />
        )}
        {lifecycle.isError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {lifecycleErrorMessage(lifecycle.error)}
          </p>
        )}
        {/* Rendered only when `data` survived, which is the point: the page
            below is real, just a moment old. */}
        {(detail.isError || operations.isError) && (
          <StaleNotice className="mt-2" />
        )}
      </div>

      <div className="flex flex-col gap-4 p-4 sm:p-6">
        {/* Above the tabs, not inside the Overview aside: the aside is
            `hidden` below `lg` on any other tab, so a phone user who opened
            Edit to fix the file could not see what was wrong with it. */}
        {data.parseError && (
          <Panel
            title="Compose file could not be parsed"
            role="region"
            aria-label="Compose error"
            className="border-danger"
          >
            <p className="text-sm text-muted">
              Homestead cannot read this stack until the file is valid.
              Everything below is what it can still tell you.
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-sm text-danger">
              {data.parseError}
            </pre>
          </Panel>
        )}

        {/* Docked directly above the tab bar, so the live output sits between
            the controls that started it and the tabs — and, at phone width, is
            the screen. Deliberately in the flow rather than a fixed overlay:
            an overlay would cover the lifecycle controls at exactly the moment
            someone wants to stop what they just started.

            Keyed on the id so a second operation starts from a clean panel
            rather than inheriting the previous one's log and terminal state. */}
        {activeOperation && (
          <OperationPanel
            key={activeOperation.id}
            operationId={activeOperation.id}
            slug={slug}
            kind={activeOperation.kind}
            onDismiss={() => setActiveOperation(null)}
          />
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
                variant="ghost"
                aria-expanded={overviewOpen}
                aria-controls={overviewId}
                onClick={() => setOverviewOpen(!overviewOpen)}
              >
                {overviewOpen ? "Hide overview" : "Show overview"}
              </Button>
            </div>
            <div id={overviewId} className={overviewOpen ? "" : "lg:hidden"}>
              <Overview
                slug={slug}
                detail={data}
                exposures={exposures.data ?? []}
                onExpose={setExposing}
                onEditExposure={setEditingExposure}
                onEditIdentity={() => setEditingIdentity(true)}
              />
            </div>
          </aside>
          {/* On the Overview tab the aside owns the whole row, so this column
              is hidden — unless the rail is collapsed at `lg`+, where leaving
              half the page blank looks like a rendering fault. The Outlet is
              rendered either way: the index route's redirect lives in it. */}
          <div
            className={`min-w-0 flex-1 ${
              onOverview ? (overviewOpen ? "hidden" : "hidden lg:block") : ""
            }`}
          >
            {onOverview && !overviewOpen && (
              <EmptyState
                title="Overview is hidden"
                description={`The overview sidebar is collapsed. Use "Show overview" on the left to bring it back.`}
              />
            )}
            <Outlet />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * `key={slug}` so React remounts rather than reusing state across projects.
 * `activeOperation` belongs to one project's page; without the key,
 * navigating from one project to another would carry the previous project's
 * operation — and the SSE connection streaming its output — into the new
 * page. Nothing links project-to-project today; it is one link away from
 * being a live bug, and the fix costs one attribute.
 */
function KeyedProjectDetail() {
  const { slug = "" } = useParams();
  return <ProjectDetail key={slug} />;
}

/**
 * Registered from `App.tsx` so there is one definition of these paths, and the
 * unit tests exercise the same tree the app mounts.
 */
export const projectDetailRoute = (
  <Route path="/projects/:slug" element={<KeyedProjectDetail />}>
    <Route index element={<Navigate to="overview" replace />} />
    <Route path="overview" element={<OverviewRoute />} />
    <Route path="edit" element={<Edit />} />
    <Route path="logs" element={<Logs />} />
  </Route>
);
