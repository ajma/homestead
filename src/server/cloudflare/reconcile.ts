import type { DriftFinding } from "@shared/cloudflare.js";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { exposures } from "../db/schema.js";
import type { CloudflareClient } from "./client.js";

type ExposureRow = typeof exposures.$inferSelect;

/**
 * Compares ONE exposure's recorded Cloudflare resources — DNS record, ingress rule (and
 * the service it points at), Access application — against Cloudflare's own current state.
 *
 * **Read-only against Cloudflare, by construction.** Every call below is one of
 * `CloudflareClient`'s `find*`/`get*` methods; nothing here calls `create*`, `put*`, or
 * `delete*`. §6: "flags drift in the UI rather than silently correcting it — a tool that
 * fights dashboard edits is worse than one that reports them." A deliberate dashboard
 * edit — an admin repointing a hostname to a different container, say — must survive this
 * function running, not get overwritten the next time it ticks. `reconcile.test.ts`'s
 * "never calls a Cloudflare write method" test is the binding check for this property; see
 * its own doc comment for the mutation that was measured to violate it.
 *
 * Checks run independently and every one that applies always runs — an early finding
 * never short-circuits the rest, because a DNS record and an Access application being
 * simultaneously wrong is exactly the kind of thing an admin needs the full list for, not
 * just the first symptom found.
 */
export async function checkExposureDrift(
  client: CloudflareClient,
  exposure: ExposureRow,
): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = [];

  if (exposure.zoneId !== null && exposure.tunnelId !== null) {
    // Same match `create-dns-record` (`expose.ts`) uses to decide whether a record
    // already exists: a proxied CNAME at this hostname pointing at this tunnel. `null`
    // covers both "gone entirely" and "present but pointing somewhere else" — either way
    // this hostname would not actually reach the tunnel right now.
    const dnsRecord = await client.findDnsRecord(
      exposure.zoneId,
      exposure.hostname,
      `${exposure.tunnelId}.cfargotunnel.com`,
    );
    if (dnsRecord === null) {
      findings.push({
        kind: "dns_record_missing",
        message: `The DNS record for ${exposure.hostname} is missing, or no longer a proxied CNAME to the tunnel.`,
      });
    }
  }

  if (exposure.tunnelId !== null) {
    const config = await client.getTunnelConfig(exposure.tunnelId);
    const rule = config.ingress.find((r) => r.hostname === exposure.hostname);
    if (rule === undefined) {
      findings.push({
        kind: "ingress_rule_missing",
        message: `The tunnel's ingress config no longer has a rule for ${exposure.hostname}.`,
      });
    } else if (rule.service !== exposure.ingressService) {
      findings.push({
        kind: "ingress_service_mismatch",
        message: `${exposure.hostname} is routed to ${rule.service}, not the recorded ${exposure.ingressService}.`,
      });
    }
  }

  // §6's own words for why this is the finding that matters most: a deleted Access
  // application means the hostname is STILL routed (the ingress and DNS checks above are
  // about whether traffic reaches the tunnel at all, a separate question) and no longer
  // protected — anyone who finds the URL can now reach the app with no sign-in at all.
  // Checked whenever this exposure ever had one recorded; `create-access-app`
  // (`expose.ts`) runs unconditionally, so a `ready` or previously-`drifted` exposure with
  // no `accessAppId` at all would itself be a data inconsistency this check cannot
  // meaningfully report — nothing here invents a finding for it.
  //
  // `findAccessApp` matches by HOSTNAME, not by the id this exposure recorded — so an
  // admin deleting the Access application in the dashboard and creating a new one at the
  // same hostname (the most likely way anyone "fixes" one by hand) makes this lookup
  // return a non-null app with a DIFFERENT `id`/`aud`. Phase 2F whole-branch review, F3:
  // comparing only "is it null" reported that as clean, while the stored `accessAppAud`
  // was now stale (breaking the `self` app's own Access sign-in — `access-settings.ts`),
  // the shared monitor policy almost certainly was not attached to the new app (failing
  // every external probe), and `deprovision.ts` would later try to delete the long-gone
  // old id and orphan the replacement. A replacement is reported as its own `kind` rather
  // than folded into `access_app_deleted`: the remedy is different (re-record the new
  // id/aud, not re-create an application) and an admin needs to know which one happened.
  if (exposure.accessAppId !== null) {
    const accessApp = await client.findAccessApp(exposure.hostname);
    if (accessApp === null) {
      findings.push({
        kind: "access_app_deleted",
        message: `The Access application protecting ${exposure.hostname} has been deleted in Cloudflare — this hostname is still routed and no longer requires sign-in.`,
      });
    } else if (accessApp.id !== exposure.accessAppId) {
      findings.push({
        kind: "access_app_replaced",
        message: `The Access application protecting ${exposure.hostname} has been replaced in Cloudflare (a new id and audience tag) — the recorded audience is stale and sign-in checks against it will fail.`,
      });
    }
  }

  return findings;
}

export type ReconcileOutcome = {
  exposureId: string;
  appId: string;
  hostname: string;
  findings: DriftFinding[];
};

/**
 * The periodic reconcile itself (§6): runs `checkExposureDrift` over every exposure
 * currently eligible for it, and records what each one found back onto its own row —
 * `state` becomes `"drifted"` when `findings` is non-empty, `"ready"` when it's empty (an
 * admin who fixes a dashboard edit should see the flag clear on the next run, not stay lit
 * forever), and `driftFindings` carries `findings` JSON-encoded, defaulting to `null` when
 * there is nothing to report. A dedicated column, not `lastError` (which this used before
 * the Phase 2F fix wave that added it): `lastError` is reserved for why the last PROVISION
 * attempt failed, a different fact paired with `state: "error"` — see `schema.ts`'s own
 * doc comment on both columns. JSON-encoded into a plain `text` column rather than
 * `schema.ts` declaring it `mode: "json"`, the same defensive choice `routes/setup.ts`'s
 * `parseCompletedSteps` makes for `completed_steps` and for the same reason: a caller
 * reading this column back (`routes/cloudflare-expose.ts`) controls its own parsing and
 * degrades gracefully on anything unexpected, rather than trusting Drizzle's automatic
 * decode to throw INSIDE the query the moment something doesn't parse.
 *
 * Only `"ready"` and `"drifted"` exposures are read at all. `"provisioning"` means a
 * step-job sequence still owns this row — reading it mid-sequence would race that job's
 * own writes and could report resources it simply hasn't created yet as "missing", which
 * is not drift, it's a sequence still running. `"error"` means the last provision attempt
 * already failed for a reason a Cloudflare-state comparison cannot resolve either;
 * re-checking it here would only produce a second, redundant "something is wrong" signal
 * next to the one already on screen.
 *
 * One exposure's check throwing — a network error, most likely — does not stop the rest
 * from being checked: each iteration has its own `try`/`catch`, and a caught failure is
 * recorded as a `"check_failed"` finding rather than silently skipped, since an admin
 * needs to know a check didn't complete just as much as they need to know one found
 * something. See `reconcile.test.ts`'s "drift on one exposure does not stop the others
 * being checked" test.
 */
export async function reconcileExposures(deps: {
  db: Db;
  client: CloudflareClient;
}): Promise<ReconcileOutcome[]> {
  const rows = await deps.db
    .select()
    .from(exposures)
    .where(inArray(exposures.state, ["ready", "drifted"]));

  const outcomes: ReconcileOutcome[] = [];
  for (const row of rows) {
    let findings: DriftFinding[];
    try {
      findings = await checkExposureDrift(deps.client, row);
    } catch (error) {
      findings = [
        {
          kind: "check_failed",
          message: `Could not check this exposure against Cloudflare: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ];
    }

    await retryOnBusy(() =>
      deps.db
        .update(exposures)
        .set({
          state: findings.length > 0 ? "drifted" : "ready",
          driftFindings: findings.length > 0 ? JSON.stringify(findings) : null,
          lastSyncedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(exposures.id, row.id)),
    );

    outcomes.push({ exposureId: row.id, appId: row.appId, hostname: row.hostname, findings });
  }
  return outcomes;
}

/**
 * Defensive read of `exposures.driftFindings` back into `DriftFinding[]` — the other half
 * of `reconcileExposures`'s JSON-in-a-text-column choice above. `null`, not-JSON, or JSON
 * that isn't an array of the expected shape all degrade to `[]` rather than throwing: a
 * hand-edited or corrupted column should cost an admin the finding list, not the whole
 * route (`routes/setup.ts`'s `parseCompletedSteps` makes the identical trade-off for
 * `completed_steps`). Exported for `routes/cloudflare-expose.ts`, the one caller outside
 * this module that ever reads this column.
 */
export function parseDriftFindings(raw: string | null): DriftFinding[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is DriftFinding =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as DriftFinding).kind === "string" &&
        typeof (value as DriftFinding).message === "string",
    );
  } catch {
    return [];
  }
}
