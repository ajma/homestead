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
 * One entry in a tunnel's ingress array (`GET`/`PUT .../cfd_tunnel/{id}/configurations`,
 * `result.config.ingress`). `hostname` is absent on exactly one entry in a well-formed
 * array: the trailing catch-all, which carries only `service` (conventionally
 * `"http_status:404"|"http_status:503"`) and matches whatever no earlier rule claimed.
 * Shared rather than server-only because the client (Task 1), the pure splice module and
 * the expose sequence (Task 3) all need to agree on this shape — see the phase's progress
 * ledger.
 *
 * The index signature is load-bearing, not decoration: a real rule can carry `path` and
 * `originRequest` (2D's whole-branch review, F2) alongside `hostname`/`service`, and a
 * tunnel this project only ADOPTED (2C) may have rules a human wrote with exactly those
 * fields. `spliceIngress`/`removeIngress` (`cloudflare/ingress.ts`) only ever touch the
 * ONE entry for the hostname being exposed or removed; every other entry passes through
 * untouched, and untouched has to mean "every field it arrived with," not just the two
 * this project happens to read.
 */
export type IngressRule = { hostname?: string; service: string; [key: string]: unknown };

/**
 * A tunnel's full ingress configuration — `ingress` plus whatever else Cloudflare's GET
 * returned (`warp-routing`, a tunnel-level `originRequest`, or a field this client has
 * never heard of). `CloudflareClient.getTunnelConfig`/`putTunnelConfig` round-trip this
 * whole object rather than just `{ ingress }`: on a read-modify-write endpoint with no
 * partial-update form, dropping an unknown field on read is not tolerating it, it is
 * deleting it on the very next write (2D's whole-branch review, F2). A caller that wants
 * to change only `ingress` does `{ ...config, ingress: updated }`, never `{ ingress:
 * updated }` alone.
 */
export type TunnelConfig = { ingress: IngressRule[]; [key: string]: unknown };

/**
 * `GET /api/cloudflare/tunnel`'s shape — Task 4's read model over `TunnelStore` plus
 * whatever the provision sequence's own job row says right now. A discriminated union on
 * `provisioned`, the same shape `CloudflareStatus` uses, for the same reason: a caller
 * cannot accidentally read `name`/`appId` off a status that has none.
 *
 * `runningJobId` is independent of `provisioned` rather than nested under the `false`
 * branch alone: `TunnelStore`'s record exists from the *second* step of the five-step
 * sequence (`fetch-token`) onward, so `provisioned: true` can be true while the sequence
 * is still running `compose-up` (the last step) and could still fail and roll everything
 * — including that very record — back out. A caller that only checked `provisioned`
 * would announce success before it was earned; `runningJobId` is what lets the panel tell
 * "settled" from "still in flight" regardless of which way `provisioned` happens to read
 * at that instant.
 *
 * `appId` is nullable on the `true` branch for the same reason `TunnelRecord.appId` is
 * (2C Task 1-2's report): the record can exist before `register-app` (step 4) has filled
 * it in.
 */
export type TunnelStatus =
  | { provisioned: false; runningJobId: string | null }
  | { provisioned: true; name: string; appId: string | null; runningJobId: string | null };

/**
 * How long a client waits for `POST /api/cloudflare/tunnel` before giving up. Shared, not
 * server-only, because both ends of that one call need the same number: the server route
 * does not answer until its whole five-step sequence — including `docker compose up -d`,
 * capped at its own `COMPOSE_TIMEOUT_MS` in `provision-tunnel.ts` — has finished, and
 * `@web/api/cloudflare`'s call has to wait at least that long or it abandons the request
 * (via `apiFetch`'s ordinary 30s default) while Cloudflare and Docker keep working
 * server-side, with no jobId ever reaching the browser to check on it. Comfortably above
 * one worst-case `compose-up` rather than derived from it exactly: rollback of an earlier
 * step never itself calls compose (only `compose-up`'s own step, the last one, does), so
 * one interval plus margin is the true worst case, not two.
 */
export const TUNNEL_PROVISION_TIMEOUT_MS = 6 * 60_000;

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

/**
 * `GET /api/cloudflare/monitor`'s shape — a discriminated union on `configured`, the same
 * pattern `CloudflareStatus` uses and for the same reason: a caller cannot accidentally
 * read `clientId`/`expiresAt` off a status that has none. Never carries the secret itself
 * (see `MonitorAccessStore` — the secret is written, never read back through this shape).
 */
export type MonitorAccessStatus =
  | { configured: false }
  | { configured: true; clientId: string; policyId: string; expiresAt: number | null };

/**
 * `GET /api/cloudflare/access`'s shape — a discriminated union on `configured`, the same
 * pattern `CloudflareStatus`/`MonitorAccessStatus` use and for the same reason: a caller
 * cannot accidentally read `teamDomain`/`aud` off a status that has none. Reflects
 * `resolveAccessSettings` (2E Task 2) exactly: `null` there is `{ configured: false }`
 * here, never a half-filled object.
 *
 * `source` on the `true` branch — added by 2F Task 4 — is NOT part of
 * `resolveAccessSettings`'s own return value (that function only ever resolves the
 * settings themselves, never why it picked them). The route recomputes it locally from
 * the same precedence `resolveAccessSettings` documents (environment wins only when it
 * supplies both values, database otherwise) because Settings has to say WHERE a value
 * came from, not just that one exists: an admin staring at a team domain they never
 * typed into Homestead, with no way to tell whether it came from `HOMESTEAD_ACCESS_*` or
 * from Homestead's own self-exposure, cannot know which one to go change.
 */
export type AccessConfigStatus =
  | { configured: false }
  | { configured: true; teamDomain: string; aud: string; source: "environment" | "database" };

/**
 * `GET /api/apps/:id/expose`'s shape — 2F Task 3's read model over the `exposures` row
 * `cloudflare/expose.ts`'s step sequence writes, plus whatever expose (or, in principle, a
 * future re-expose) job is running right now for this app. A discriminated union on
 * `exposed`, the same pattern every other Cloudflare status route in this file uses, for
 * the same reason: a caller cannot accidentally read `hostname` off a status that has
 * none.
 *
 * `runningJobId` sits on BOTH branches, the same way `TunnelStatus.runningJobId` does and
 * for the same reason: `POST /api/apps/:id/expose`'s own sequence writes the `exposures`
 * row from an early step onward (Homestead is exposed, in the `provisioning` state) well
 * before the sequence's last step finishes, and could still fail and roll everything back
 * out — a caller that only checked `exposed` would announce success before it was earned.
 * Independently, the row does not exist AT ALL until that first step runs, so a page
 * loaded the instant after a POST returns its `jobId` needs `runningJobId` on the `false`
 * branch too, to notice a sequence is already under way with nothing exposed yet.
 */
export type AppExposureStatus =
  | { exposed: false; runningJobId: string | null }
  | {
      exposed: true;
      hostname: string;
      state: "provisioning" | "ready" | "error" | "drifted";
      accessAppId: string | null;
      accessAppAud: string | null;
      runningJobId: string | null;
      /** What the last reconcile (2F Task 6) found wrong, if anything — always an array,
       * empty rather than absent when `state !== "drifted"`, so a caller never has to
       * distinguish "never checked" from "checked, nothing wrong" (`GET /api/apps/:id/expose`
       * makes no promise about the former either way; see `reconcile.ts`'s own doc comment
       * on which exposures get checked at all). Never present on the server's own decision
       * to correct anything — see `DriftFinding`'s doc comment for why that property matters
       * enough to repeat here. */
      driftFindings: DriftFinding[];
    };

/**
 * One thing a periodic reconcile (§6, `cloudflare/reconcile.ts`) found does not match
 * between the `exposures` row and Cloudflare's own live state. `kind` is a stable slug a
 * caller can switch on without parsing `message` — the exposure tab uses it to give
 * `"access_app_deleted"` a visibly more urgent treatment than the others, since a deleted
 * Access application is the one drift that means a hostname is routed and unprotected
 * right now, not just recorded slightly wrong. `check_failed` is not really "drift" (the
 * comparison itself couldn't complete — a network error, most likely) but is reported
 * through the same shape rather than swallowed, because an admin needs to know a check
 * didn't run just as much as they need to know what one found.
 *
 * `message` is pre-rendered server-side, not reconstructed from `kind` in the browser —
 * the same "server already knows enough to say the whole sentence" choice
 * `deprovision.ts`'s own per-resource messages make, reused via `describeDeprovisionError`
 * rather than re-derived client-side.
 */
export type DriftFindingKind =
  | "dns_record_missing"
  | "ingress_rule_missing"
  | "ingress_service_mismatch"
  | "access_app_deleted"
  | "access_app_replaced"
  | "check_failed";

/**
 * §6: "flags drift in the UI rather than silently correcting it." Nothing in this type,
 * or in anything that produces it, is a Cloudflare write — `reconcile.ts`'s own doc
 * comment on `checkExposureDrift` is where that property is actually enforced; this type
 * only carries what was found, never an action taken.
 */
export type DriftFinding = { kind: DriftFindingKind; message: string };
