import type { Operation, OperationKind } from "@shared/projects.js";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { queryKeys } from "../lib/queries.js";
import { useEventStream } from "../lib/useEventStream.js";
import { Badge, Button, Spinner } from "./ui/index.js";

/**
 * One frame of `GET /api/operations/:id/stream`: a piece of the command's
 * output, or the terminal event. `operation` is resolved from the database
 * when the operation is no longer in memory, and is null only when the server
 * could not find it at all.
 */
export type OperationFrame =
  | { chunk: string }
  | { end: true; operation: Operation | null };

/**
 * How close to the bottom still counts as "following".
 *
 * Not zero: a wrapped last line, a sub-pixel layout and a trackpad's inertia
 * all leave a few pixels behind, and a reader who is plainly at the bottom
 * should not silently stop being followed because of them.
 */
const FOLLOW_SLACK_PX = 24;

type Scrollable = Pick<
  HTMLElement,
  "scrollTop" | "scrollHeight" | "clientHeight"
>;

/**
 * Whether the log should keep following new output.
 *
 * Auto-scroll is conditional on purpose. Yanking the view back down while
 * someone is reading the line that explains the failure is worse than not
 * following at all — they lose their place, and the thing they were reading is
 * the thing they came for.
 */
export function isAtBottom(el: Scrollable): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
}

function statusLine(
  operation: Operation | null,
  ended: boolean,
  lost: boolean,
): string {
  // Order matters: `lost` before `Running`, because once the stream is gone
  // for good this page has no way to know the operation is still going.
  if (!ended) return lost ? "No longer following" : "Running";
  if (!operation) return "Finished — the server did not say how it ended";
  const code = operation.exitCode;
  const suffix = code === null ? "" : ` (exit ${code})`;
  return `${operation.status === "succeeded" ? "Succeeded" : "Failed"}${suffix}`;
}

export function OperationPanel({
  operationId,
  slug,
  kind,
  onDismiss,
}: {
  operationId: string;
  /** Which queries the terminal event invalidates. */
  slug: string;
  /**
   * The verb this page posted. The stream carries it only in its terminal
   * frame, and a panel that cannot name what is running until it stops is
   * useless during the four minutes a `pull` takes.
   */
  kind: OperationKind;
  onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const [ended, setEnded] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  /** Null until the reader overrides the default for this operation. */
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  const { items, state } = useEventStream<OperationFrame>(
    `/api/operations/${encodeURIComponent(operationId)}/stream`,
    {
      onEnd: (frame) => {
        setEnded(true);
        setOperation("end" in frame ? frame.operation : null);
        // Container states and the operation list both changed. The detail key
        // is a prefix of the operations key, so that is one call; the list is
        // separate because a stack that just came up reads differently there.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.project(slug),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      },
    },
  );

  const output = items
    .map((frame) => ("chunk" in frame ? frame.chunk : ""))
    .join("");

  /**
   * The stream is gone for good and this page will learn nothing more.
   *
   * The realistic cause is a session that expired part-way through a long
   * `pull`: the reconnect is refused, `EventSource` closes for good and no
   * further attempt is made. Reported as a retry it would leave a spinner
   * that can never stop and a promise nothing will keep, over an operation
   * that has very likely succeeded.
   */
  const lost = !ended && state === "error";

  /**
   * Between connections — the first attempt, or a retry after a drop.
   *
   * Deliberately not worded as "reconnecting". Telling the two apart would
   * mean remembering whether there has ever been an `open`, and React batches
   * a drop that follows one closely enough that the intermediate state is
   * never rendered. "Connecting" is true of both, and true is enough.
   */
  const connecting = !ended && state === "connecting";

  // Collapsed only on a confirmed success: a stack that came up is a one-line
  // answer, and anything else is something the reader has to work through.
  const succeeded = ended && operation?.status === "succeeded";
  const open = openOverride ?? !succeeded;

  useEffect(() => {
    const log = logRef.current;
    // Re-run when the log is revealed too: a collapsed element has no layout,
    // so it cannot be scrolled to its own bottom until it is back on screen.
    if (!open || !log || !followRef.current) return;
    // Nothing to follow yet, and nothing to scroll to.
    if (output === "") return;
    log.scrollTop = log.scrollHeight;
  }, [output, open]);

  return (
    <section
      // The name is exactly "Operation": ProjectDetail's tests and the e2e
      // suite both address this region by it.
      aria-label="Operation"
      data-operation-id={operationId}
      className="w-full rounded-lg border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        {/* The live region is the status, never the log: announcing every
            line of `docker compose pull` would make a screen reader unusable,
            while the one fact that changes — how it ended — must be spoken.
            Said once, so there is nothing to keep in step and nothing to read
            twice. */}
        <p role="status" className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm font-semibold text-text">
            {kind}
          </span>
          {/* A spinner is a claim that something is still being watched. */}
          {!ended && !lost && <Spinner size={16} />}
          {ended || lost ? (
            <Badge
              tone={
                lost
                  ? "warning"
                  : operation?.status === "succeeded"
                    ? "success"
                    : operation
                      ? "danger"
                      : "neutral"
              }
            >
              {statusLine(operation, ended, lost)}
            </Badge>
          ) : (
            <span className="text-sm text-muted">
              {statusLine(operation, ended, lost)}
            </span>
          )}
        </p>
        <div className="ms-auto flex flex-wrap gap-2">
          <Button
            aria-expanded={open}
            onClick={() => setOpenOverride(!open)}
            // The log is rendered either way, so this controls a real element.
            aria-controls={`${operationId}-output`}
          >
            {open ? "Hide output" : "Show output"}
          </Button>
          <Button onClick={onDismiss}>Dismiss</Button>
        </div>
      </div>

      {lost && (
        <p
          role="alert"
          className="border-b border-border px-4 py-2 text-sm text-danger"
        >
          The output stream ended and will not reconnect — your session may have
          expired. This operation is probably still running. Reload the page to
          sign in again and see how it finished.
        </p>
      )}

      {/* A retry the browser is already making is not news, and an alarm on
          every Wi-Fi handoff trains people to ignore alarms. One quiet line,
          in the muted tone, and no `role="alert"`. */}
      {connecting && (
        <p className="border-b border-border px-4 py-2 text-sm text-muted">
          Connecting to the output stream…
        </p>
      )}

      <pre
        id={`${operationId}-output`}
        ref={logRef}
        // `log` rather than a bare `pre`: a `pre` is generic and cannot carry
        // an accessible name, so the scroll region would be an anonymous box.
        // Its implicit live region is turned off — reading every line of
        // `docker compose pull` aloud is not help, and the status above
        // already announces the one thing that matters. No `tabIndex`: current
        // browsers make an overflowing region keyboard-scrollable on their own.
        role="log"
        aria-live="off"
        aria-label="Operation output"
        // The attribute rather than a `hidden` utility: collapsing must hold
        // wherever this renders, including where the stylesheet has not been
        // applied, and `hidden` is the thing every consumer already agrees on.
        hidden={!open}
        // Wrapped rather than scrolled sideways: at 390px a horizontal scroll
        // inside a vertical one is unusable, and the page must not overflow.
        //
        // Tall enough at phone width to be the screen, short enough at a desk
        // that the controls above it stay in view.
        className="h-[55vh] overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-text sm:h-72"
        onScroll={(event) => {
          followRef.current = isAtBottom(event.currentTarget);
        }}
      >
        {output === "" ? (
          <span className="text-muted">
            {ended ? "No output." : "Waiting for output…"}
          </span>
        ) : (
          output
        )}
      </pre>
    </section>
  );
}
