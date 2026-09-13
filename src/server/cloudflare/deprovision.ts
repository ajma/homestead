import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { exposures, probes } from "../db/schema.js";
import type { CloudflareClient } from "./client.js";
import type { TunnelConfigLock } from "./expose.js";
import { removeIngress } from "./ingress.js";

export type DeprovisionDeps = {
  db: Db;
  client: CloudflareClient;
  /** The SAME per-tunnel mutex `expose.ts`'s `splice-ingress` uses — this module writes
   * the ingress array too (removing this hostname's entry), and that write must be
   * serialised against every concurrent expose or deprovision touching the same tunnel
   * for exactly the reason `TunnelConfigLock`'s own doc comment gives: there is no
   * add/remove-one-rule endpoint, only a whole-array PUT, so two unlocked
   * read-modify-writes can silently erase each other's hostname. NOT `AppLock` — see
   * that same doc comment for why the two must not be confused.
   */
  tunnelConfigLock: TunnelConfigLock;
};

export type ExposureRow = typeof exposures.$inferSelect;

export type DeprovisionResource = "probe" | "access-app" | "dns-record" | "ingress-rule";

export type DeprovisionOutcome =
  | { ok: true }
  | { ok: false; failures: Array<{ resource: DeprovisionResource; error: unknown }> };

/**
 * Reverses a *successful* exposure — the four resources `exposeSteps` (expose.ts) can
 * create, in the reverse of the order they were created in (probe, Access application,
 * DNS record, ingress rule), reading `exposure` — the recorded `exposures` row — as the
 * only source of truth about what Homestead created. This is NOT a rollback: `expose.ts`'s
 * own `undo` handlers exist for unwinding a run that never finished; this instead runs
 * against a row that already reached `state: "ready"`, on a caller's explicit request to
 * take the app back off the internet.
 *
 * Three invariants, each measured by its own test:
 *
 * 1. **Every `*CreatedByUs: false` resource is left alone.** The exact 2C defect (adoption
 *    and deletion sharing one match), carried forward and fixed one level down for
 *    ingress in this same commit's sibling change to `expose.ts` — this function is the
 *    other half of that fix: the flags it reads are worthless if nothing downstream
 *    actually respects them.
 * 2. **The `exposures` row is deleted LAST**, only once every resource above has either
 *    been removed or was never Homestead's to remove. Deleting it first and then hitting
 *    a failure on, say, the DNS record would strand that record with no local record it
 *    even exists — Homestead has no other list of "Cloudflare resources by hostname", and
 *    no UI can name it for a human to clean up by hand.
 * 3. **A partial failure leaves the row in place, with only the flags for what WAS
 *    removed flipped to `false`** — mirroring `step-sequence.ts`'s `rollback`, which
 *    keeps going through a throwing `undo` rather than stopping at the first one. A
 *    resource that failed to delete keeps its flag `true`, so calling this again neither
 *    re-deletes a resource already gone (the flag is now `false`, skipped outright) nor
 *    silently gives up on the one that is not (the flag is still `true`, retried).
 *
 * **The ingress rule never restores an adopted rule's original content.** `expose.ts`'s
 * own `undo` CAN restore a pre-existing rule verbatim, because it still holds
 * `ctx.originalIngressRule` from the very same run that read it. This function has only
 * the `exposures` row — no column here holds what a hostname's rule looked like before
 * Homestead's own successful splice overwrote it (this phase adds no migration for one),
 * and by the time an exposure reaches "ready" that content is already gone from Cloudflare
 * regardless — spec's own replace-not-duplicate rule for a live splice. So "leave it
 * alone" here means exactly that: when `ingressRuleCreatedByUs` is `false`, this never
 * calls `removeIngress` (or anything else) against that hostname's entry, full stop. What
 * is currently live for that hostname — Homestead's own service, since nothing has
 * touched it since the successful expose — is left exactly as it is, for a human to
 * repoint by hand if that hostname was ever theirs.
 *
 * A resource already gone on the Cloudflare side is not an error: `deleteDnsRecord` and
 * `deleteAccessApp` are both documented idempotent (client.ts), and `removeIngress` is a
 * no-op for a hostname that is not present (ingress.ts) — so a retry after a partial
 * failure that already got as far as, say, deleting the DNS record on Cloudflare but not
 * yet recording it locally will not raise when it tries again.
 */
export async function deprovision(
  deps: DeprovisionDeps,
  exposure: ExposureRow,
): Promise<DeprovisionOutcome> {
  const failures: Array<{ resource: DeprovisionResource; error: unknown }> = [];

  // 1. The probe — reverses `create-probe`, the last step `exposeSteps` runs. Unlike the
  // three below, there is no created-by-us flag for it and none is needed: a probe is not
  // a Cloudflare resource, it is Homestead's own local row, and `create-probe` always
  // creates one (no adoption branch exists for it — see expose.ts). Removed unconditionally.
  try {
    await retryOnBusy(() =>
      deps.db
        .delete(probes)
        .where(and(eq(probes.appId, exposure.appId), eq(probes.kind, "http_external"))),
    );
  } catch (error) {
    failures.push({ resource: "probe", error });
  }

  // 2. The Access application.
  if (exposure.accessAppCreatedByUs && exposure.accessAppId) {
    try {
      // Idempotent — see client.ts's own doc comment on `deleteAccessApp`.
      await deps.client.deleteAccessApp(exposure.accessAppId);
      await retryOnBusy(() =>
        deps.db
          .update(exposures)
          .set({ accessAppCreatedByUs: false })
          .where(eq(exposures.id, exposure.id)),
      );
    } catch (error) {
      failures.push({ resource: "access-app", error });
    }
  }

  // 3. The DNS record.
  if (exposure.dnsRecordCreatedByUs && exposure.dnsRecordId && exposure.zoneId) {
    try {
      await deps.client.deleteDnsRecord(exposure.zoneId, exposure.dnsRecordId);
      await retryOnBusy(() =>
        deps.db
          .update(exposures)
          .set({ dnsRecordCreatedByUs: false })
          .where(eq(exposures.id, exposure.id)),
      );
    } catch (error) {
      failures.push({ resource: "dns-record", error });
    }
  }

  // 4. The ingress rule — see this function's own doc comment on why an adopted rule is
  // never restored here, only ever left untouched.
  if (exposure.ingressRuleCreatedByUs && exposure.tunnelId) {
    try {
      await deps.tunnelConfigLock.run(async () => {
        const config = await deps.client.getTunnelConfig(exposure.tunnelId as string);
        const updated = removeIngress(config.ingress, exposure.hostname);
        await deps.client.putTunnelConfig(exposure.tunnelId as string, { ingress: updated });
      });
      await retryOnBusy(() =>
        deps.db
          .update(exposures)
          .set({ ingressRuleCreatedByUs: false })
          .where(eq(exposures.id, exposure.id)),
      );
    } catch (error) {
      failures.push({ resource: "ingress-rule", error });
    }
  }

  if (failures.length > 0) return { ok: false, failures };

  // Deleted LAST — see invariant 2 above. If this itself fails, every flag above is
  // already `false` (or was already `false`), so a retry finds nothing left to delete on
  // Cloudflare and only needs to remove this row.
  await retryOnBusy(() => deps.db.delete(exposures).where(eq(exposures.id, exposure.id)));
  return { ok: true };
}
