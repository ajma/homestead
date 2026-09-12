/**
 * `configured: false` carries nothing else — a discriminated union so a caller cannot
 * accidentally read `accountId` off a status that has none, the same shape `SetupState`
 * and other admin DTOs already use.
 */
export type CloudflareStatus =
  | { configured: false }
  | { configured: true; accountId: string; tokenHint: string; verifiedAt: number | null };

export type CloudflareZone = { id: string; name: string };

/** `deletedAt` is `null` for a live tunnel, an epoch-ms timestamp once soft-deleted.
 * Shared rather than server-only because a future picker UI needs to filter or grey out
 * deleted tunnels the same way the server does — see `CloudflareClient.listTunnels`. */
export type CloudflareTunnel = { id: string; name: string; deletedAt: number | null };

/**
 * Cloudflare's failure classified into the sentence a caller needs to say about it.
 * Shared rather than server-only: the PUT route's 422 body carries this verbatim
 * (`{ error: "verification_failed", fault }`), and the Settings panel renders a
 * per-fault message off it, so the same union has to type both ends of that response.
 */
export type CloudflareFault =
  | "auth"
  | "permission"
  | "rate_limit"
  | "network"
  | "cloudflare"
  | "client";
