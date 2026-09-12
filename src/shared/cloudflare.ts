/**
 * `configured: false` carries nothing else — a discriminated union so a caller cannot
 * accidentally read `accountId` off a status that has none, the same shape `SetupState`
 * and other admin DTOs already use.
 */
export type CloudflareStatus =
  | { configured: false }
  | { configured: true; accountId: string; tokenHint: string; verifiedAt: number | null };

export type CloudflareZone = { id: string; name: string };
