/**
 * The exposure form asks for a label and a zone rather than a fully-qualified
 * hostname: the zone is a closed set the account already defines, and typing
 * it out invites a domain you do not own.
 *
 * The form still submits one `hostname` string — the server derives the zone
 * from it, so there is a single contract and the server stays authoritative
 * rather than trusting a zone the browser chose.
 */

/** `metube` + `example.com` → `metube.example.com`. Empty label means apex. */
export function composeHostname(label: string, zoneName: string): string {
  const zone = zoneName
    .trim()
    .toLowerCase()
    .replace(/^\.|\.$/g, "");
  if (zone === "") return "";
  const prefix = label
    .trim()
    .toLowerCase()
    .replace(/^\.|\.$/g, "");
  return prefix === "" ? zone : `${prefix}.${zone}`;
}

/**
 * The inverse, for editing an existing exposure.
 *
 * A hostname no zone covers keeps its whole self as the label and reports no
 * zone, rather than being reattached to whichever zone happens to be first —
 * the zone may simply have been removed from the account since.
 */
export function splitHostname(
  hostname: string,
  zones: { id: string; name: string }[],
): { label: string; zoneId: string | null } {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");

  let best: { id: string; name: string } | null = null;
  for (const zone of zones) {
    const name = zone.name.trim().toLowerCase().replace(/\.$/, "");
    if (host !== name && !host.endsWith(`.${name}`)) continue;
    // Most specific wins, so the label left over belongs to the zone chosen.
    if (!best || name.length > best.name.length) best = { id: zone.id, name };
  }

  if (!best) return { label: hostname, zoneId: null };
  const label =
    host === best.name ? "" : host.slice(0, -(best.name.length + 1));
  return { label, zoneId: best.id };
}
