/**
 * Matches an HTTP status against a comma-separated pattern of literal codes and `Nxx`
 * classes — `2xx,3xx`, `200,204,301`.
 *
 * Fails CLOSED. An empty or unparseable pattern matches nothing, so the probe reads down
 * and the user investigates. The opposite mistake — matching everything — reports a dead
 * app as healthy indefinitely, which nobody ever notices.
 */
const CLASS_TERM = /^([1-5])xx$/;
const LITERAL_TERM = /^[1-5][0-9]{2}$/;

/** The terms a pattern contains, ignoring blanks and anything unparseable. */
function usableTerms(pattern: string): string[] {
  return pattern
    .split(",")
    .map((raw) => raw.trim().toLowerCase())
    .filter((term) => CLASS_TERM.test(term) || LITERAL_TERM.test(term));
}

export function matchesStatusPattern(pattern: string, status: number): boolean {
  if (!Number.isInteger(status) || status < 100 || status > 599) return false;

  for (const term of usableTerms(pattern)) {
    const asClass = CLASS_TERM.exec(term);
    if (asClass) {
      if (Math.floor(status / 100) === Number(asClass[1])) return true;
      continue;
    }
    if (Number(term) === status) return true;
  }

  return false;
}

/**
 * Whether a pattern would ever match anything.
 *
 * The matcher failing closed is right at runtime, but on its own it means a user who
 * types `2x` for `2xx` watches their app go red with nothing saying the pattern is at
 * fault. The probe API calls this when they type it, so the mistake is caught where it
 * can still be explained.
 */
export function isValidStatusPattern(pattern: string): boolean {
  return usableTerms(pattern).length > 0;
}
