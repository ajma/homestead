import type { IngressRule } from "@shared/cloudflare.js";

/**
 * The trailing catch-all is the one ingress entry with no `hostname` — it matches
 * whatever no earlier rule claims. Matched on that SHAPE rather than on a specific
 * `service` string: Cloudflare's own examples use both `http_status:404` and
 * `http_status:503`, and this module has no business caring which fallback status an
 * operator picked. In a well-formed array there is exactly one, and it is last; this
 * returns the first match regardless, since a malformed array (more than one, or one not
 * actually trailing) is not this module's problem to detect.
 */
function catchAllIndex(rules: IngressRule[]): number {
  return rules.findIndex((rule) => rule.hostname === undefined);
}

/**
 * Returns `rules` with `rule` spliced in — before the trailing catch-all, never after.
 * Cloudflare matches ingress top to bottom and stops at the first match, so a rule placed
 * after the catch-all is never evaluated: the catch-all, matching everything, shadows it.
 * That failure is silent — provisioning reports success and the hostname 404s — which is
 * the entire reason this is a pure, exhaustively-testable module rather than inline logic
 * inside a step.
 *
 * Replaces any existing entry for the same hostname rather than duplicating it: two rules
 * for one hostname means the second is dead, and which one wins is not obvious from the
 * UI. The replacement always lands immediately before the catch-all (not at the removed
 * entry's old position) — this function does not promise position stability for a
 * hostname being re-spliced, only that every OTHER rule keeps its relative order.
 *
 * **No catch-all present:** appends at the end. Decided rather than left unhandled — a
 * tunnel config without one is unusual but not impossible (an operator can always edit
 * the dashboard directly) — because appending keeps the new rule reachable: nothing
 * follows it that could shadow it, since shadowing is exactly what a catch-all does and
 * there isn't one here. The alternative, inventing a catch-all of our own, would silently
 * change the tunnel's fallback behaviour for every other hostname already on it — a much
 * larger and less obvious side effect than just placing the rule last.
 *
 * Pure: no I/O, no Cloudflare client, nothing to fake. `expose.ts` is the only caller,
 * and it runs this against a config it just read under its own mutex — this function
 * knows nothing about that lock and must not need to.
 */
export function spliceIngress(
  rules: IngressRule[],
  rule: { hostname: string; service: string },
): IngressRule[] {
  const withoutExisting = rules.filter((r) => r.hostname !== rule.hostname);
  const index = catchAllIndex(withoutExisting);
  const entry: IngressRule = { hostname: rule.hostname, service: rule.service };
  if (index === -1) return [...withoutExisting, entry];
  return [...withoutExisting.slice(0, index), entry, ...withoutExisting.slice(index)];
}

/**
 * Removes only the entry for `hostname`, leaving the catch-all — and every other rule —
 * untouched. The catch-all has no `hostname`, so `r.hostname !== hostname` can never
 * match it away; removing it would break every OTHER app exposed on this tunnel, which is
 * why this filters strictly by name rather than, say, dropping the last N rules. A no-op
 * (returns an array with the same rules, in the same order) when `hostname` is not
 * present — both rollback and deprovisioning call this and must tolerate calling it on an
 * already-removed hostname without complaint.
 */
export function removeIngress(rules: IngressRule[], hostname: string): IngressRule[] {
  return rules.filter((r) => r.hostname !== hostname);
}
