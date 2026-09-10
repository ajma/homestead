/**
 * Matches an HTTP status against a comma-separated pattern of literal codes and `Nxx`
 * classes — `2xx,3xx`, `200,204,301`.
 *
 * Fails CLOSED. An empty or unparseable pattern matches nothing, so the probe reads down
 * and the user investigates. The opposite mistake — matching everything — reports a dead
 * app as healthy indefinitely, which nobody ever notices.
 */
export function matchesStatusPattern(pattern: string, status: number): boolean {
  if (!Number.isInteger(status) || status < 100 || status > 599) return false;

  for (const raw of pattern.split(",")) {
    const term = raw.trim().toLowerCase();
    if (term === "") continue;

    const asClass = /^([1-5])xx$/.exec(term);
    if (asClass) {
      if (Math.floor(status / 100) === Number(asClass[1])) return true;
      continue;
    }

    // A literal code, and only a three-digit one: `20` should not match anything.
    if (/^[1-5][0-9]{2}$/.test(term) && Number(term) === status) return true;
  }

  return false;
}
