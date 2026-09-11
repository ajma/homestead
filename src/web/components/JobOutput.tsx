import { useSseText } from "@web/lib/use-sse-text";
import { useEffect, useRef } from "react";

/**
 * Renders one job's output as it streams, via `useSseText` against
 * `GET /api/jobs/:jobId/stream` — the same hook, and the same `{ text, stream }` shaped
 * events, that `LogsTab` uses for container logs (`jobs.ts` names its terminal-text event
 * `output` rather than `line`; `useSseText` listens for both). No second SSE hook exists
 * for this, deliberately: a job's output and a container's logs are the same kind of thing
 * to a client — an accumulating string that ends — and Task 9 built `useSseText` general
 * enough for both from the start.
 *
 * `onDone` fires exactly once per mount, on the edge where `done` turns true — not on every
 * render where `done` happens to already be true. It is read through a ref rather than
 * listed as an effect dependency: `ActionBar` does not memoize the callback it passes here,
 * and depending on it directly would re-fire `onDone` on every one of `ActionBar`'s
 * re-renders for as long as the stream stayed finished, which — since `onDone` invalidates
 * four queries — would turn one job completion into a refetch storm.
 */
export function JobOutput({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const { text, done, error } = useSseText(`/api/jobs/${jobId}/stream`);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (done) onDoneRef.current();
  }, [done]);

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      <pre
        data-testid="job-output"
        className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-slate-950 p-3 text-xs text-slate-100 dark:border-slate-800"
      >
        {text || "Waiting for output…"}
      </pre>
    </div>
  );
}
