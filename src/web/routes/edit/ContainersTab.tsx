import type { ContainerSummary } from "@shared/admin.js";
import { useQuery } from "@tanstack/react-query";
import { containersKey, useContainers } from "@web/api/admin";
import { apiFetch } from "@web/api/client";
import type { EditAppContext } from "@web/routes/EditApp";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";

/**
 * Mirrors `src/server/host/types.ts`'s `ContainerInspect` structurally. Kept as a local
 * copy rather than a shared import: unlike `ContainerSummary`, nothing about this shape
 * needs to be typed at both ends of a request the server also builds internally, and
 * `src/shared/admin.ts`'s existing types all exist because the server infers a payload
 * from them — this one is consumed only here, by a `fetch` response.
 */
type ContainerDetail = {
  id: string;
  name: string;
  image: string;
  imageDigest: string | null;
  state: string;
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  restartPolicy: string;
  restartCount: number;
  tty: boolean;
  env: Array<{ key: string; masked: string }>;
  mounts: Array<{ source: string; destination: string; mode: string; type: string }>;
  ports: Array<{ container: number; host: number | null; protocol: string }>;
  networks: string[];
  health: {
    status: string;
    failingStreak: number;
    log: Array<{ exitCode: number; output: string; end: string }>;
  } | null;
};

function primaryName(container: ContainerSummary): string {
  return container.names[0] ?? container.service ?? container.id.slice(0, 12);
}

/**
 * A container's inspect detail, fetched only once its row is expanded.
 *
 * Not mounted at all while its row is collapsed — `ContainersTab` renders this
 * component conditionally rather than always rendering it with an `enabled` flag, the
 * same gate `AdoptDialog` uses for its scan. One Docker round trip per container for
 * data nobody asked for is exactly what the tab-as-boundary rule exists to prevent, and
 * it applies inside this tab exactly as it does between tabs.
 */
function ContainerDetailPanel({ appId, containerId }: { appId: string; containerId: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: [...containersKey(appId), containerId],
    queryFn: () => apiFetch<ContainerDetail>(`/api/apps/${appId}/containers/${containerId}`),
    // Matches the 5s `staleTime` the sibling container list (`useContainers`, in
    // `src/web/api/admin.ts`) uses — this panel is scoped to one row of that same list,
    // so collapsing and re-expanding a row within the window should reuse the cached
    // detail rather than firing a fresh Docker inspect.
    staleTime: 5_000,
  });

  if (isPending) {
    return <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">Loading…</p>;
  }

  if (isError || !data) {
    return (
      <p className="px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
        Could not load this container's detail.
      </p>
    );
  }

  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-slate-200 px-3 py-3 text-xs sm:grid-cols-2 dark:border-slate-800">
      <div>
        <dt className="uppercase tracking-wide text-slate-500">Exit code</dt>
        <dd className="text-slate-900 dark:text-slate-100">{data.exitCode ?? "—"}</dd>
      </div>
      <div>
        <dt className="uppercase tracking-wide text-slate-500">OOM killed</dt>
        <dd className="text-slate-900 dark:text-slate-100">{data.oomKilled ? "Yes" : "No"}</dd>
      </div>
      <div>
        <dt className="uppercase tracking-wide text-slate-500">Restart policy</dt>
        <dd className="text-slate-900 dark:text-slate-100">{data.restartPolicy}</dd>
      </div>
      <div>
        <dt className="uppercase tracking-wide text-slate-500">Restart count</dt>
        <dd className="text-slate-900 dark:text-slate-100">{data.restartCount}</dd>
      </div>
      <div>
        <dt className="uppercase tracking-wide text-slate-500">Health</dt>
        <dd className="text-slate-900 dark:text-slate-100">{data.health?.status ?? "—"}</dd>
      </div>
      <div>
        <dt className="uppercase tracking-wide text-slate-500">Networks</dt>
        <dd className="text-slate-900 dark:text-slate-100">
          {data.networks.length > 0 ? data.networks.join(", ") : "—"}
        </dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="uppercase tracking-wide text-slate-500">Ports</dt>
        <dd className="text-slate-900 dark:text-slate-100">
          {data.ports.length === 0
            ? "—"
            : data.ports
                .map((port) => `${port.host ?? "—"} → ${port.container}/${port.protocol}`)
                .join(", ")}
        </dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="uppercase tracking-wide text-slate-500">Mounts</dt>
        <dd className="text-slate-900 dark:text-slate-100">
          {data.mounts.length === 0
            ? "—"
            : data.mounts.map((mount) => `${mount.source} → ${mount.destination}`).join(", ")}
        </dd>
      </div>
    </dl>
  );
}

/**
 * The edit page's Containers tab: one row per container the app's compose project owns,
 * each expandable to its inspect detail.
 *
 * Reads the app `EditApp` already resolved via `useOutletContext`, the same pattern
 * `OverviewTab` uses — re-resolving `:slug` here would defeat the point of the tabs
 * sharing one lookup.
 *
 * A Docker failure and an empty stack render different messages, deliberately: both
 * leave the table empty, but only one of them means the admin's containers are actually
 * gone. `GET /api/apps/:id/containers` carries that distinction as `dockerReachable`
 * rather than collapsing it into a bare array, the same distinction `docker-runner.ts`
 * draws between `ctx.containers === null` and `[]`.
 *
 * A stopped container is listed like any other row, not filtered out — "why is this
 * down" is the question this tab exists to answer, and hiding the stopped one hides
 * the answer.
 */
export function ContainersTab() {
  const { app } = useOutletContext<EditAppContext>();
  const { data, isPending, isError } = useContainers(app.id);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (isPending) {
    return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Loading containers…</p>;
  }

  if (isError || !data) {
    return (
      <p className="p-4 text-sm text-rose-600 dark:text-rose-400">Could not load containers.</p>
    );
  }

  if (!data.dockerReachable) {
    return (
      <p className="p-4 text-sm text-rose-600 dark:text-rose-400">
        Docker is not reachable, so container status is unavailable.
      </p>
    );
  }

  if (data.containers.length === 0) {
    return (
      <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
        This stack is not running — Docker sees no containers for it.
      </p>
    );
  }

  return (
    <ul className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
      {data.containers.map((container) => {
        const isExpanded = expanded.has(container.id);
        return (
          <li
            key={container.id}
            className="border-t border-slate-200 first:border-t-0 dark:border-slate-800"
          >
            <button
              type="button"
              onClick={() => toggle(container.id)}
              aria-expanded={isExpanded}
              className="flex w-full flex-col gap-1 px-3 py-2 text-left text-sm hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-3 dark:hover:bg-slate-900"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-slate-900 dark:text-slate-100">
                {primaryName(container)}
              </span>
              <span className="truncate text-xs text-slate-500 dark:text-slate-400">
                {container.image}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">{container.state}</span>
              <span className="truncate text-xs text-slate-500 dark:text-slate-400">
                {container.status}
              </span>
            </button>
            {isExpanded && <ContainerDetailPanel appId={app.id} containerId={container.id} />}
          </li>
        );
      })}
    </ul>
  );
}
