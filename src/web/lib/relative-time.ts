/** Compact age for a status line: `5s`, `12m`, `3h`, `2d`. Both arguments are epoch seconds. */
export function relativeTime(since: number, now: number): string {
  const elapsed = Math.max(0, now - since);
  if (elapsed < 60) return `${Math.floor(elapsed)}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`;
  return `${Math.floor(elapsed / 86400)}d`;
}
