/**
 * The zone a hostname belongs to, or null if the account holds none that
 * cover it.
 *
 * An exposure records a zone, but the form asks only for a hostname — the
 * hostname already determines the zone, and making someone choose it as well
 * is a question with a derivable answer. Requiring it in the request body,
 * with no field to supply it, is what made every attempt to add an exposure
 * fail with `invalid_body`.
 */
export function resolveZoneId(
  hostname: string,
  zones: { id: string; name: string }[],
): string | null {
  // A trailing dot is a legal fully-qualified name and would otherwise fail
  // every comparison.
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");

  let best: { id: string; name: string } | null = null;
  for (const zone of zones) {
    const name = zone.name.trim().toLowerCase().replace(/\.$/, "");
    // The apex, or a label boundary. Suffix alone would match
    // "notexample.com" against "example.com" — a different domain, and quite
    // possibly someone else's.
    const covers = host === name || host.endsWith(`.${name}`);
    if (!covers) continue;
    // Most specific wins: with both example.com and sub.example.com held,
    // app.sub.example.com belongs to the latter, and a record created in the
    // former would resolve for nobody.
    if (!best || name.length > best.name.length) best = { id: zone.id, name };
  }

  return best?.id ?? null;
}
