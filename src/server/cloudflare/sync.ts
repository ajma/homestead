// Reconciles ingress and exposures to Cloudflare.
// (sync-users.ts syncs the allow policy; this one reconciles ingress and exposures.)

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { exposures, settings } from "../db/schema.js";
import { createApp } from "./access.js";
import type { CloudflareClient } from "./client.js";
import {
  checkForClobber,
  desiredIngress,
  type ExposureRow,
  fingerprint,
} from "./reconcile.js";
import { getIngress, putIngress, upsertDnsRecord } from "./tunnel.js";

/**
 * Simple async mutex for serializing ingress push operations.
 * Two Homestead instances sharing one tunnel is out of scope;
 * this only prevents interleaving within a single process.
 */
class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.locked = true;
    return () => {
      this.locked = false;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

const ingressMutex = new AsyncMutex();

export type ReconcileResult = { ok: true } | { ok: false; conflict: string };

/**
 * Synchronize all exposures to Cloudflare: push ingress, ensure DNS records
 * and Access apps exist for enabled exposures. Serialized behind a mutex
 * to prevent concurrent mutations from interleaving.
 */
export async function reconcileExposures(
  db: Db,
  client: CloudflareClient,
  accountId: string,
  tunnelId: string,
  policyAllowId: string | null,
  policyProbeId: string | null,
): Promise<ReconcileResult> {
  const release = await ingressMutex.acquire();
  try {
    // Read current state
    const allExposures = await db.select().from(exposures);

    // Fail closed, before any remote write. An exposure that asks for Access
    // but has no policy ids to attach would otherwise be published through the
    // tunnel with no login in front of it, while its row still says
    // accessEnabled and the UI renders it as protected. Refusing the whole
    // reconcile is the safe direction: nothing goes live unprotected, and the
    // operator is told which hostnames are affected and why.
    const unprotectable = allExposures.filter(
      (e) => e.enabled && e.accessEnabled && !(policyAllowId && policyProbeId),
    );
    if (unprotectable.length > 0) {
      return {
        ok: false,
        conflict:
          `Access is enabled for ${unprotectable.map((e) => e.hostname).join(", ")} ` +
          "but no Access policies are configured. Re-run Cloudflare setup; " +
          "publishing without them would expose these hostnames with no login.",
      };
    }

    const exposureRows: ExposureRow[] = allExposures.map((e) => ({
      hostname: e.hostname,
      hostPort: e.hostPort,
      scheme: e.scheme as "http" | "https",
      noTlsVerify: e.noTlsVerify,
      enabled: e.enabled,
    }));

    const desired = desiredIngress(exposureRows);

    // Check for clobber
    const remote = await getIngress(client, accountId, tunnelId);
    const [lastPushedRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.lastPushedIngress"));
    const lastPushed = lastPushedRow?.value ?? null;
    const check = checkForClobber(remote, lastPushed);

    if (!check.ok) {
      return { ok: false, conflict: check.reason };
    }

    // Push ingress
    await putIngress(client, accountId, tunnelId, desired);

    // Re-read what was actually pushed and fingerprint that
    const actualPushed = await getIngress(client, accountId, tunnelId);
    const newFingerprint = fingerprint(actualPushed);

    // Store the fingerprint
    await db
      .insert(settings)
      .values({
        key: "cloudflare.lastPushedIngress",
        value: newFingerprint,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: newFingerprint },
      });

    // Ensure DNS and Access apps exist for all enabled exposures
    for (const exposure of allExposures) {
      if (!exposure.enabled) continue;

      // Ensure DNS record exists
      await upsertDnsRecord(
        client,
        exposure.zoneId,
        exposure.hostname,
        tunnelId,
      );

      // Ensure Access app exists if requested
      if (exposure.accessEnabled && policyAllowId && policyProbeId) {
        if (!exposure.accessAppId) {
          const app = await createApp(client, accountId, exposure.hostname, [
            policyAllowId,
            policyProbeId,
          ]);
          await db
            .update(exposures)
            .set({ accessAppId: app.id })
            .where(eq(exposures.id, exposure.id));
        }
      }
    }

    return { ok: true };
  } finally {
    release();
  }
}
