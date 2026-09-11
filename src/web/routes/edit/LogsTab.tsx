import type { ContainerSummary } from "@shared/admin.js";
import { useContainers } from "@web/api/admin";
import { useSseText } from "@web/lib/use-sse-text";
import type { EditAppContext } from "@web/routes/EditApp";
import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

function primaryName(container: ContainerSummary): string {
  return container.names[0] ?? container.service ?? container.id.slice(0, 12);
}

/**
 * How far from the bottom (in pixels) still counts as "at the bottom" for the purposes
 * of auto-scroll. Not zero: a log line's height means the scroll position lands a few
 * pixels short of the true bottom even when the user has done nothing, and treating that
 * as "scrolled up" would stop following on every single line.
 */
const NEAR_BOTTOM_PX = 24;

/**
 * The edit page's Logs tab: a container selector, a follow toggle and the pane itself,
 * fed by `useSseText` against `GET /api/apps/:id/containers/:containerId/logs`.
 *
 * Reads the app via `useOutletContext`, the same pattern `OverviewTab` and
 * `ContainersTab` use — re-resolving `:slug` here would defeat the point of the tabs
 * sharing one lookup.
 *
 * The stream URL is derived state, not something set imperatively: it is `null` until a
 * container is chosen, and changes whenever the selection or the follow toggle changes.
 * `useSseText` reacting to that change — opening a new stream and closing the old one —
 * is what makes switching containers or toggling follow "just work" here; this component
 * does not manage the `EventSource` itself.
 *
 * Auto-scroll follows the newest line unless the user has scrolled up to read history:
 * fighting that by snapping back to the bottom on every incoming line would make
 * scrollback unusable on a chatty container.
 */
export function LogsTab() {
  const { app } = useOutletContext<EditAppContext>();
  const { data, isPending, isError } = useContainers(app.id);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const paneRef = useRef<HTMLPreElement>(null);

  const containerId = selectedId ?? data?.containers[0]?.id ?? null;
  const url =
    containerId !== null
      ? `/api/apps/${app.id}/containers/${containerId}/logs?follow=${follow}`
      : null;
  const { text, done, error } = useSseText(url);

  // A new stream — a different container, or the same one re-opened after toggling
  // follow — starts back at the bottom. Whatever scroll position the user left on the
  // previous stream says nothing about this one. `url` itself is unused in the body;
  // it is the dependency that makes this effect keyed to "a new stream started".
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on url
  useEffect(() => {
    setScrolledUp(false);
  }, [url]);

  // Re-run on every new chunk of `text` so the pane follows it — `text` itself is read
  // off `paneRef`'s DOM, not from this closure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on text
  useEffect(() => {
    if (scrolledUp) return;
    const pane = paneRef.current;
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
  }, [text, scrolledUp]);

  function handleScroll() {
    const pane = paneRef.current;
    if (!pane) return;
    const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
    setScrolledUp(distanceFromBottom > NEAR_BOTTOM_PX);
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
        Docker is not reachable, so logs are unavailable.
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={containerId ?? ""}
          onChange={(event) => setSelectedId(event.target.value)}
          aria-label="Container"
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
        >
          {data.containers.map((container) => (
            <option key={container.id} value={container.id}>
              {primaryName(container)}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
          />
          <span className="text-slate-900 dark:text-slate-100">Follow</span>
        </label>

        {done && <span className="text-xs text-slate-500 dark:text-slate-400">Stream ended</span>}
      </div>

      {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

      <pre
        ref={paneRef}
        onScroll={handleScroll}
        data-testid="log-pane"
        className="h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-slate-950 p-3 text-xs text-slate-100 dark:border-slate-800"
      >
        {text}
      </pre>
    </div>
  );
}
