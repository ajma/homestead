import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { isAtBottom } from "../../components/OperationPanel.js";
import { Button, Panel, Spinner } from "../../components/ui/index.js";
import { useProject } from "../../lib/queries.js";
import { useEventStream } from "../../lib/useEventStream.js";

/**
 * One frame of `GET /api/projects/:slug/logs`.
 *
 * The terminal frame carries no `operation` — unlike the operations stream's,
 * which resolves the row it was following. There is no row here: this endpoint
 * follows a child process, not a recorded operation.
 */
export type LogFrame = { chunk: string } | { end: true };

/**
 * How many lines to ask the server for, and the default.
 *
 * Every value is inside the server's `z.coerce.number().int().min(0).max(10_000)`,
 * because the validator answers anything outside it with a 400 the reader
 * cannot act on. 200 is the server's own default, so the first connection asks
 * for exactly what it would have got anyway.
 */
const TAIL_OPTIONS = [100, 200, 1_000, 5_000] as const;
const DEFAULT_TAIL = 200;

/**
 * The `<select>` value that means "every service".
 *
 * It is deliberately not sent. `service` is validated against
 * `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`, which an empty string fails — so
 * `?service=` is a 400, while omitting the key entirely is the "all services"
 * the server already implements.
 */
const ALL_SERVICES = "";

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

/** One shape for both toolbar selects, at a size a thumb can hit. */
const SELECT_CLASS =
  "min-h-11 min-w-11 rounded-md border border-border bg-raised px-3 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * A live view of `docker compose logs -f` for one project.
 *
 * **Pause detaches; it does not buffer.** The server holds a child process
 * open for as long as the request is open, so "pause" cannot mean "keep
 * reading and hide it" without leaving that process running for a reader who
 * has stopped looking. It closes the connection instead — which is also what
 * kills the child — and says so, because a Pause that silently dropped output
 * would leave someone believing they had a complete log. Following again
 * reopens the stream, and the server's `--tail` hands back recent context.
 */
export function Logs() {
  const { slug = "" } = useParams();
  // The parent has already fetched this and does not render the Outlet until
  // it resolves, so this is a cache read rather than a second request.
  const detail = useProject(slug);

  const [service, setService] = useState<string>(ALL_SERVICES);
  const [tail, setTail] = useState<number>(DEFAULT_TAIL);
  const [following, setFollowing] = useState(true);

  const serviceId = useId();
  const tailId = useId();
  const logRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  /**
   * Sorted rather than left in compose-file order: this is a lookup, and a
   * list that reorders itself when someone edits the file is a list nobody can
   * build a habit around. Every name here came from the project model, so
   * every one already satisfies the server's service-name regex — which is why
   * there is no free-text field.
   */
  const services = useMemo(
    () =>
      [...(detail.data?.model?.services ?? [])]
        .map((s) => s.name)
        .sort((a, b) => a.localeCompare(b)),
    [detail.data],
  );

  // A service that has just been removed from the compose file would otherwise
  // stay selected and silently filter the log down to nothing.
  const selected = services.includes(service) ? service : ALL_SERVICES;

  // Null while paused. `useEventStream` keeps the frames it already has when
  // the url goes null, which is exactly what a pause needs: the log must keep
  // showing what was on screen when the reader stopped it.
  const url = useMemo(() => {
    if (!following || slug === "") return null;
    const params = new URLSearchParams({ tail: String(tail) });
    if (selected !== ALL_SERVICES) params.set("service", selected);
    return `/api/projects/${encodeURIComponent(slug)}/logs?${params.toString()}`;
  }, [following, slug, tail, selected]);

  // `replace`, because a reconnected request re-issues `--tail=N`: the first
  // frame after a reopen is the start of that tail, not a continuation.
  const { items, state, reopens } = useEventStream<LogFrame>(url, {
    onReopen: "replace",
  });

  const output = useMemo(
    () => items.map((frame) => ("chunk" in frame ? frame.chunk : "")).join(""),
    [items],
  );

  useEffect(() => {
    const log = logRef.current;
    if (!log || !followRef.current) return;
    // Nothing to follow yet, and nothing to scroll to.
    if (output === "") return;
    log.scrollTop = log.scrollHeight;
  }, [output]);

  /**
   * The browser has given up and will not reconnect.
   *
   * A viewer holds only `app:read`, so this endpoint answers them 403 — and
   * `EventSource` closes for good on a 403 rather than hammering it. The other
   * realistic cause is a session that expired while the tab sat open. Neither
   * is recoverable from here, so this is a state to explain, not a spinner.
   */
  const refused = state === "error";
  const connecting = state === "connecting";
  const ended = state === "closed";

  return (
    <Panel title="Logs" role="region" aria-label="Logs">
      {/* A fieldset, not a `toolbar`: a toolbar promises arrow-key navigation
          between its controls, and a `<select>` needs its own arrow keys.
          `min-w-0` because a fieldset's default `min-inline-size: min-content`
          would let a wide control push the page sideways on a phone. */}
      <fieldset
        aria-label="Log controls"
        className="flex min-w-0 flex-wrap items-end gap-3"
      >
        <Field id={serviceId} label="Service">
          <select
            id={serviceId}
            value={selected}
            onChange={(event) => setService(event.target.value)}
            className={SELECT_CLASS}
          >
            <option value={ALL_SERVICES}>All services</option>
            {services.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>

        <Field id={tailId} label="Lines">
          <select
            id={tailId}
            value={String(tail)}
            onChange={(event) => setTail(Number(event.target.value))}
            className={SELECT_CLASS}
          >
            {TAIL_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} lines
              </option>
            ))}
          </select>
        </Field>

        <Button
          variant={following ? "secondary" : "primary"}
          className="min-w-11"
          onClick={() => setFollowing(!following)}
        >
          {following ? "Pause" : "Follow"}
        </Button>

        {/* A spinner is a claim that something is still being watched. */}
        {following && !ended && !refused && (
          <span className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={16} />
            {connecting ? "Connecting…" : "Following"}
          </span>
        )}
      </fieldset>

      {!following && (
        <p className="mt-3 text-sm text-warning">
          Paused. The connection is closed while paused, so output produced now
          is <strong>not being collected</strong> — it is not hidden, it is not
          arriving. Choose Follow to reopen the stream; the server sends the
          last {tail} lines back as context.
        </p>
      )}

      {ended && (
        <p className="mt-3 text-sm text-muted">
          The log stream ended. <code>docker compose logs</code> stops following
          when the stack has no running containers. Choose Pause, then Follow,
          to reopen it.
        </p>
      )}

      {refused && (
        <p role="alert" className="mt-3 text-sm text-danger">
          The log stream closed and will not reconnect. Reading container logs
          needs an administrator account — or your session may have expired.
          Reload the page to sign in again.
        </p>
      )}

      <pre
        ref={logRef}
        // `log` rather than a bare `pre`: a `pre` is generic and cannot carry
        // an accessible name, so this scroll region would be an anonymous box.
        // Its implicit live region is turned off — reading a container's whole
        // stdout aloud is not help.
        role="log"
        aria-live="off"
        aria-label="Log output"
        // Scroll anchoring fights the follow: as lines are appended the
        // browser adjusts `scrollTop` to keep the anchored content still,
        // which is the opposite of following the newest line.
        style={{ overflowAnchor: "none" }}
        // Wrapped rather than scrolled sideways: at 390px a horizontal scroll
        // inside a vertical one is unusable, and the page must not overflow.
        className="mt-3 h-[55vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-raised px-3 py-2 font-mono text-xs text-text sm:h-96"
        onScroll={(event) => {
          const el = event.currentTarget;
          // A hidden element measures 0/0/0, which reads as "at the bottom".
          // Left unguarded, revealing the region would silently re-arm the
          // follow and drag a reader who had deliberately scrolled up back
          // down — the one thing this mechanism exists to prevent.
          if (el.clientHeight === 0) return;
          followRef.current = isAtBottom(el);
        }}
      >
        {/* Inside the log, not beside it, because it marks a place in the
            log. `replace` is the right policy here and still lossy: the server
            keeps no scrollback, so a reconnect is handed `--tail=N` and
            everything older is gone. Redrawing in silence would destroy a
            reader's history exactly as invisibly as a Pause that dropped
            output — which this tab already refuses to do. */}
        {reopens > 0 && (
          <span className="mb-2 block border-b border-border pb-2 text-warning">
            — the stream reconnected; the server resent only the last {tail}{" "}
            lines, so anything older than this point has been lost —{"\n"}
          </span>
        )}
        {output === "" ? (
          <span className="text-muted">
            {following ? "Waiting for output…" : "No output yet."}
          </span>
        ) : (
          output
        )}
      </pre>
    </Panel>
  );
}
