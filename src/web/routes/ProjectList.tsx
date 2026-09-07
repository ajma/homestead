import type { ScanEntry } from "@shared/projects.js";
import { Link } from "react-router-dom";
import {
  Badge,
  EmptyState,
  Spinner,
  StaleNotice,
  StatusDot,
} from "../components/ui/index.js";
import { isRefusal, useProjects } from "../lib/queries.js";

/**
 * A `Link` styled as the primary button, not a `Button` that navigates.
 *
 * It goes somewhere, so it must be middle-clickable, long-pressable and
 * copyable like every other destination in the app. `min-h-11` and `px-4`
 * match `Button`'s `md` sizing so the sweep sees a 44px target.
 */
const NEW_PROJECT =
  "inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-contrast transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** 44px minimum touch target; the whole row is the target, not the name. */
const ROW =
  "flex min-h-11 w-full items-center gap-3 px-4 py-2 text-sm transition focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * What the list can honestly say.
 *
 * `GET /api/projects` is a directory scan: it knows whether a compose file and
 * a `.env` are present and nothing else. Service counts and published ports
 * need `docker compose config`, and container state needs `docker compose ps`
 * — one invocation per project, which on a 30-stack NAS polled every 15s would
 * be 30 Docker calls every 15 seconds. Those belong on the detail view, and
 * real runtime status waits for an endpoint that can report it in one call.
 *
 * So a manageable project is a **neutral badge**, not a green dot. The green
 * dot means "containers are running" on the detail page, and thirty of them
 * down a list read as "everything is up" — a claim this screen has no way to
 * make. Saying less, in a colour that promises nothing, is the honest reading.
 */
function Row({ entry }: { entry: ScanEntry }) {
  const contents = (
    <>
      <span className="min-w-0 flex-1 truncate font-medium">{entry.slug}</span>
      {entry.hasEnv && <Badge>.env</Badge>}
      {entry.hasCompose ? (
        <Badge>Valid compose</Badge>
      ) : (
        <>
          <Badge tone="warning">Not a project</Badge>
          <StatusDot state="unknown" label="No compose file" />
        </>
      )}
    </>
  );

  if (!entry.hasCompose) {
    // No link: the detail view answers a directory without a compose file with
    // nothing useful, and a dead link is worse than an explained row.
    return <li className={`${ROW} text-muted`}>{contents}</li>;
  }

  return (
    <li>
      <Link
        to={`/projects/${entry.slug}`}
        className={`${ROW} text-text hover:bg-raised`}
      >
        {contents}
      </Link>
    </li>
  );
}

export function ProjectList() {
  const { data, error, isPending } = useProjects();

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">Projects</h1>
        <Link to="/projects/new" className={NEW_PROJECT}>
          New project
        </Link>
      </div>
      <Body data={data} error={error} isPending={isPending} />
    </main>
  );
}

function Body({
  data,
  error,
  isPending,
}: {
  data: ScanEntry[] | undefined;
  error: Error | null;
  isPending: boolean;
}) {
  if (isPending)
    return (
      <div className="flex justify-center py-12 text-muted">
        <Spinner />
      </div>
    );

  // `error && !data`, never `error` alone: this query polls every 15 seconds,
  // and a failed *refetch* leaves the last good `data` in place while flipping
  // status to "error". Branching on the error first would empty the list a
  // user is reading because one poll lost the network.
  if (error && !data) {
    // The list needs project:read, which is admin-only. A viewer is signed in
    // and correct — they simply cannot see this — so it is a state, not a
    // crash and not something to keep retrying.
    if (isRefusal(error))
      return (
        <EmptyState
          title="You do not have access"
          description="Viewing projects needs an administrator account. Ask an administrator to grant you access."
        />
      );
    return (
      <p role="alert" className="mt-6 text-sm text-danger">
        Could not load projects. {error.message}
      </p>
    );
  }

  if (!data) return null;

  return (
    <>
      {error && <StaleNotice className="mt-4" />}
      {data.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Homestead lists every directory in HOMESTEAD_PROJECTS. Create one here, or drop a directory with a compose file in there and it will appear."
          action={
            <Link to="/projects/new" className={NEW_PROJECT}>
              New project
            </Link>
          }
        />
      ) : (
        <ul className="mt-6 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {data.map((entry) => (
            <Row key={entry.slug} entry={entry} />
          ))}
        </ul>
      )}
    </>
  );
}
