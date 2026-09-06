/**
 * "What you are looking at is a moment old", said quietly.
 *
 * TanStack Query sets `status: "error"` on a failed *background* refetch while
 * keeping the last good `data`. Rendering the error branch first therefore
 * deletes the screen on a single failed poll — the list empties for fifteen
 * seconds, and on the project page a live operation panel is unmounted
 * mid-run, closing its stream and discarding the output being read. Stale data
 * plus a note is strictly better than no data, so every screen that polls
 * renders this instead of blanking.
 *
 * `role="status"` rather than `alert`: it is polite by design. Nothing is
 * broken, nothing needs doing, and the next poll will very likely clear it.
 */
export function StaleNotice({ className = "" }: { className?: string }) {
  return (
    <p role="status" className={`text-sm text-muted ${className}`}>
      Could not refresh just now — showing the last information the server gave
      us.
    </p>
  );
}
