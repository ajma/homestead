import { eq } from "drizzle-orm";
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
 * create, reading `exposure` — the recorded `exposures` row — as the only source of truth
 * about what Homestead created. This is NOT a rollback: `expose.ts`'s own `undo` handlers
 * exist for unwinding a run that never finished; this instead runs against a row that
 * already reached `state: "ready"`, on a caller's explicit request to take the app back
 * off the internet.
 *
 * Order: probe, then DNS record, then ingress rule, then the Access application LAST —
 * deliberately NOT the reverse of creation order (which would delete the Access
 * application second). See "The Access application is gated on the route it protects,
 * not just its own flag" below for why the order changed.
 *
 * Four invariants, each measured by its own test:
 *
 * 1. **Every `*CreatedByUs: false` resource is left alone.** The exact 2C defect (adoption
 *    and deletion sharing one match), carried forward and fixed one level down for
 *    ingress in `expose.ts`, and one level down again here for the probe (see point 4
 *    below) — this function is the other half of each fix: the flags it reads are
 *    worthless if nothing downstream actually respects them.
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
 * 4. **The probe is deleted by the id `create-probe` recorded, never by `(appId, kind)`.**
 *    2D's whole-branch review (F1) measured the old behaviour: an admin's own
 *    `http_external` probe on the same app — created any time through
 *    `routes/probes.ts`, entirely independent of exposure — matches the same
 *    `(appId, "http_external")` pair Homestead's own probe does, and a kind-only match
 *    deleted BOTH, taking the user's own check history with it. `probeId` is the fourth
 *    adopted-resource case, gated by `probeCreatedByUs` the same way the three
 *    Cloudflare-side resources are. A row created before this column existed has
 *    `probeId: null` — nothing here is safe to delete by kind, so it is left alone,
 *    exactly like any other resource whose ownership cannot be established.
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
 * is currently live for that hostname is Homestead's own service (since the rule was
 * overwritten, not restored, at expose time) — this function does not pretend otherwise;
 * see the next section for what that means for the Access application in front of it.
 *
 * **The Access application is gated on the route it protects, not just its own flag.**
 * Measured (2D's whole-branch review, F3): an exposure with `ingressRuleCreatedByUs:
 * false` AND `dnsRecordCreatedByUs: false` — both legs of the public route adopted, so
 * neither is ever removed here — paired with `accessAppCreatedByUs: true`. The old code
 * deleted the Access application unconditionally on that flag alone, leaving the hostname
 * fully resolving, fully routed, and completely unauthenticated, then deleted the
 * `exposures` row so Homestead forgot this had ever happened. `ok: true` must never mean
 * that.
 *
 * The fix: track whether the DNS record and the ingress rule are STILL LIVE after this
 * run's own attempts (adopted and therefore never touched counts as "still live"; a
 * delete this run attempted but failed also counts as "still live"; only an attempt that
 * actually succeeded makes a leg NOT live). The hostname is reachable through Cloudflare
 * only when BOTH legs are live — DNS resolving to the tunnel AND the tunnel routing that
 * hostname to this app. The Access application is deleted only when the route is NOT
 * live, i.e. when at least one leg is actually coming down as a result of this call. When
 * both legs remain live, deleting a created-by-us Access application is refused outright
 * — reported as a normal `access-app` failure (invariant 3 above applies: the row
 * survives, nothing else already removed is re-attempted on retry) — rather than silently
 * producing `ok: true` over a public, unauthenticated app. If the admin genuinely wants
 * the app fully off the internet, the DNS record or ingress rule blocking that has to be
 * dealt with by hand first (they were never Homestead's to remove); this function will
 * not trade "off the internet" for "on the internet with no login."
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

  // 1. The probe — reverses `create-probe`, the last step `exposeSteps` runs. Gated on
  // `probeCreatedByUs` and deleted by the recorded `probeId`, never by `(appId, kind)` —
  // see this function's own doc comment, invariant 4. An adopted probe (the admin's own)
  // is left alone, exactly like an adopted DNS record, Access application, or ingress
  // rule.
  if (exposure.probeCreatedByUs && exposure.probeId) {
    try {
      await retryOnBusy(() =>
        deps.db.delete(probes).where(eq(probes.id, exposure.probeId as string)),
      );
      await retryOnBusy(() =>
        deps.db
          .update(exposures)
          .set({ probeCreatedByUs: false })
          .where(eq(exposures.id, exposure.id)),
      );
    } catch (error) {
      failures.push({ resource: "probe", error });
    }
  }

  // 2. The DNS record. `dnsStillLive` starts `true` (the record is presumed to still be
  // there — because it was never ours to touch, or because our attempt to remove it
  // below fails) and only becomes `false` once a delete actually succeeds.
  let dnsStillLive = true;
  if (exposure.dnsRecordCreatedByUs && exposure.dnsRecordId && exposure.zoneId) {
    try {
      await deps.client.deleteDnsRecord(exposure.zoneId, exposure.dnsRecordId);
      dnsStillLive = false;
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

  // 3. The ingress rule — see this function's own doc comment on why an adopted rule is
  // never restored here, only ever left untouched. Same `stillLive` bookkeeping as the
  // DNS record above.
  let ingressStillLive = true;
  if (exposure.ingressRuleCreatedByUs && exposure.tunnelId) {
    try {
      await deps.tunnelConfigLock.run(async () => {
        const config = await deps.client.getTunnelConfig(exposure.tunnelId as string);
        const updated = removeIngress(config.ingress, exposure.hostname);
        // `{ ...config, ingress: updated }` — see `expose.ts`'s identical fix and
        // `client.ts`'s `TunnelConfig` doc comment (2D's whole-branch review, F2). A
        // fresh `{ ingress: updated }` would silently erase every other field Cloudflare
        // is holding for this tunnel, including every OTHER hostname's rule.
        await deps.client.putTunnelConfig(exposure.tunnelId as string, {
          ...config,
          ingress: updated,
        });
      });
      ingressStillLive = false;
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

  // 4. The Access application — LAST, and gated on the route it protects, not merely on
  // `accessAppCreatedByUs`. See this function's own doc comment ("The Access application
  // is gated on the route it protects") for the full reasoning and the measured defect
  // this fixes (F3).
  const routeStillLive = dnsStillLive && ingressStillLive;
  if (exposure.accessAppCreatedByUs && exposure.accessAppId) {
    if (routeStillLive) {
      failures.push({
        resource: "access-app",
        error: new Error(
          "refusing to remove the Access application: the hostname is still fully routed " +
            "(its DNS record and/or ingress rule predate this exposure and could not be " +
            "removed here) — deleting the Access application would leave the app on the " +
            "internet with no authentication in front of it",
        ),
      });
    } else {
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
  }

  if (failures.length > 0) return { ok: false, failures };

  // Deleted LAST — see invariant 2 above. If this itself fails, every flag above is
  // already `false` (or was already `false`), so a retry finds nothing left to delete on
  // Cloudflare and only needs to remove this row.
  await retryOnBusy(() => deps.db.delete(exposures).where(eq(exposures.id, exposure.id)));
  return { ok: true };
}
