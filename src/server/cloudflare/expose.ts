import type { IngressRule } from "@shared/cloudflare.js";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Step } from "../apps/step-sequence.js";
import type { Db } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { exposures, probes } from "../db/schema.js";
import type { CloudflareClient } from "./client.js";
import { removeIngress, spliceIngress } from "./ingress.js";

/**
 * Serialises every write to the ONE tunnel's ingress config: read, splice-or-remove,
 * write — as one unit, never two interleaved. There is no "add one rule" endpoint (see
 * `CloudflareClient.putTunnelConfig`'s own doc comment): every write replaces the whole
 * array, so two concurrent read-modify-writes silently erase each other's hostname. §6
 * names this a correctness bug, not a performance concern.
 *
 * **This is NOT `AppLock` (`apps/app-lock.ts`), and the two must not be confused.**
 * `AppLock` is keyed per app and REJECTS a second holder outright (`tryAcquire` returns
 * `false` synchronously) — two different apps being exposed at the same time each get
 * their OWN `AppLock` entry and proceed in parallel, which is exactly the scenario this
 * lock exists to prevent, because both still write the SAME tunnel's ingress array. This
 * lock is per-tunnel — in practice global, since Homestead manages exactly one tunnel
 * (`provision-tunnel.ts`'s `CLOUDFLARED_TUNNEL_NAME`) — and it QUEUES rather than
 * rejects: a caller `await`s its turn instead of getting an error back. They solve
 * different problems and neither substitutes for the other.
 *
 * Implemented as a promise chain rather than a flag-plus-wait-loop. `run` attaches the
 * new work to `queue` and reassigns `queue` to a promise that resolves regardless of
 * whether that work threw — both done synchronously, before the first `await` — so two
 * calls issued in the same tick still queue in order, and one callback throwing can never
 * wedge every call queued after it (the chain itself never rejects, only the individual
 * `result` each caller gets back does).
 */
export class TunnelConfigLock {
  private queue: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Carries what each step hands to the ones after it — same shape and same reasoning as
 * `ProvisionCtx` (`provision-tunnel.ts`): every field optional because it is unset until
 * the step that produces it has run, and every `undo` below checks for `undefined` before
 * acting rather than assuming its own field was ever set.
 */
export type ExposeCtx = {
  /** The `exposures` row's id, set the instant it exists so every later step (and this
   * step's own `undo`) can find it. */
  exposureId?: string;
  ingressRuleCreatedByUs?: boolean;
  /** The ingress entry that already existed for this hostname, if any, captured the
   * instant BEFORE `splice-ingress` overwrote it — the 2C lesson (adoption and deletion
   * must not share one match) applied one level down, per the carry-forward: tunnel
   * ADOPTION (`provision-tunnel.ts`'s `create-tunnel`) means the tunnel Homestead
   * manages may be one a human made by hand, carrying ingress rules they wrote
   * themselves. `undefined` when nothing existed (this run created the entry, and
   * `ingressRuleCreatedByUs` is then `true`). Used only by THIS run's own `undo`, below,
   * to restore the adopted rule verbatim — it is never persisted to `exposures` (no
   * migration this phase adds a column for it), so a deprovision running later, against
   * a fresh process with only the database row to go on, cannot recover it this way. See
   * `deprovision.ts`'s own doc comment for how it handles that gap.
   */
  originalIngressRule?: IngressRule;
  dnsRecordId?: string;
  dnsRecordCreatedByUs?: boolean;
  accessAppId?: string;
  accessAppAud?: string;
  accessAppCreatedByUs?: boolean;
  probeId?: string;
  /** `true` when this run created the `probes` row; `false` when it adopted the app's own
   * pre-existing `http_external` probe (2D's whole-branch review, F1). Gates this step's
   * own `undo` the same way every other adopted-resource flag in this file does — see
   * `create-probe`'s doc comment. */
  probeCreatedByUs?: boolean;
};

export type ExposeDeps = {
  db: Db;
  client: CloudflareClient;
  /** Shared across every concurrent expose in the process — constructed once, at startup,
   * the same lifetime `AppLock` has (see `index.ts`/`test-helpers.ts`). A lock built fresh
   * per call would serialise nothing. */
  tunnelConfigLock: TunnelConfigLock;
  appId: string;
  hostname: string;
  zoneId: string;
  tunnelId: string;
  /** `http://localhost:<published-port>` — spec §6's `cloudflared` networking section.
   * Accepted as-is rather than derived here: deriving it needs the app's compose config,
   * which is the caller's (the route's) concern, not this sequence's. */
  ingressService: string;
  /** The admin-chosen policy demanding a human identity — §6: "policy list containing the
   * chosen human policy plus the shared monitor policy by ID." Homestead does not create
   * or manage this policy; it is referenced by id, the same way the shared monitor policy
   * (below) is. */
  humanPolicyId: string;
  /** `MonitorAccess.policyId` (`monitor-access.ts`, Task 2) — the one reusable
   * `non_identity` policy shared by every exposed app. */
  monitorPolicyId: string;
};

/**
 * The four-step expose sequence (spec §6), for `runSteps`/`StepJobRunner`. Each step is
 * idempotent (adopts an existing resource rather than duplicating it) and records whether
 * IT created what it is now responsible for — the `exposures` row's
 * `dnsRecordCreatedByUs`/`ingressRuleCreatedByUs`/`accessAppCreatedByUs` columns, designed
 * in Phase 1A, plus `probeId`/`probeCreatedByUs` (added by this fix — see `create-probe`'s
 * doc comment and 2D's whole-branch review, F1). 2C's whole-branch review measured what
 * happens when adoption and deletion share one match: a rollback deleted a tunnel it had
 * only adopted. Every `undo` below that touches a resource which might have pre-existed
 * gates the delete on the flag THIS run set, never on the fact that `ctx` merely holds an
 * id.
 */
export function exposeSteps(deps: ExposeDeps): Array<Step<ExposeCtx>> {
  return [
    {
      name: "splice-ingress",
      async run(ctx) {
        const id = ulid();
        let createdByUs = true;
        let originalRule: IngressRule | undefined;
        // Cloudflare write FIRST here, unlike a plain create-and-record step (and unlike
        // this step's own previous shape) — this step must learn whether a rule for this
        // hostname already exists, and that answer is only trustworthy read from the
        // SAME snapshot `spliceIngress` computes against, taken under the lock. An
        // earlier, unlocked peek to decide the flag would let a concurrent write land in
        // the gap, making the flag lie about what was actually there the instant this
        // run overwrote it. This brings `splice-ingress` in line with
        // `create-dns-record`/`create-access-app` below, which already write to
        // Cloudflare first and compensate a failing local write afterward — this step
        // could not both order the read correctly AND still write locally first.
        //
        // Lock, read, determine, modify, write, unlock — never read-then-lock. A re-read
        // outside the lock is the same read-modify-write race with extra steps: two
        // concurrent exposes could still both read before either writes.
        await deps.tunnelConfigLock.run(async () => {
          const config = await deps.client.getTunnelConfig(deps.tunnelId);
          // The 2C lesson, applied one level down: a rule for this hostname may already
          // be here because a human wrote it by hand on an ADOPTED tunnel
          // (`provision-tunnel.ts`'s `create-tunnel`), not because an earlier Homestead
          // attempt got partway through. Recording which is true — never assuming
          // "already exists" always means "our own leftover" — is what lets `undo`
          // below (and `deprovision.ts`) leave a human's rule alone instead of deleting
          // or overwriting it.
          originalRule = config.ingress.find((rule) => rule.hostname === deps.hostname);
          createdByUs = originalRule === undefined;
          const updated = spliceIngress(config.ingress, {
            hostname: deps.hostname,
            service: deps.ingressService,
          });
          // `{ ...config, ingress: updated }`, never a fresh `{ ingress: updated }` — the
          // whole config (`warp-routing`, a tunnel-level `originRequest`, every OTHER
          // rule's own unmodelled fields) has to go back on the wire unchanged, or this
          // write silently erases it for every other hostname on the tunnel (2D's
          // whole-branch review, F2).
          await deps.client.putTunnelConfig(deps.tunnelId, { ...config, ingress: updated });
        });
        try {
          await retryOnBusy(() =>
            deps.db.insert(exposures).values({
              id,
              appId: deps.appId,
              hostname: deps.hostname,
              zoneId: deps.zoneId,
              tunnelId: deps.tunnelId,
              ingressService: deps.ingressService,
              ingressRuleCreatedByUs: createdByUs,
              state: "provisioning",
            }),
          );
        } catch (error) {
          // The local write is what's left after a successful Cloudflare write — the
          // same window `create-dns-record` and `create-access-app` each compensate for
          // inline (their own doc comments): this step is about to report FAILED, and a
          // failing step's own `undo` never runs (step-sequence.ts, rule 1), so nothing
          // else would ever put the ingress array back if this doesn't do it before
          // rethrowing. Mirrors `undo` below exactly: delete what we added if nothing was
          // there before, restore verbatim if something was.
          await deps.tunnelConfigLock
            .run(async () => {
              const config = await deps.client.getTunnelConfig(deps.tunnelId);
              const restored = createdByUs
                ? removeIngress(config.ingress, deps.hostname)
                : spliceIngress(config.ingress, {
                    hostname: deps.hostname,
                    service: (originalRule as IngressRule).service,
                  });
              // Same F2 fix as the write above — the whole config, not a fresh object
              // holding only `ingress`.
              await deps.client.putTunnelConfig(deps.tunnelId, { ...config, ingress: restored });
            })
            .catch(() => {
              // Best effort — the same trade-off `write-files`'s undo makes: the
              // ORIGINAL error is what the caller needs to see, not a secondary cleanup
              // failure masking it.
            });
          throw error;
        }
        ctx.exposureId = id;
        ctx.ingressRuleCreatedByUs = createdByUs;
        ctx.originalIngressRule = originalRule;
      },
      async undo(ctx) {
        if (ctx.exposureId === undefined) return;
        // Removes the Cloudflare rule FIRST, the local row LAST — the same ordering
        // Task 4's deprovisioning uses, for the same reason: if removing the rule fails,
        // the row survives as the only record that a real ingress entry is still out
        // there needing manual attention. Deleting the row first would erase that
        // evidence while the rule — a REAL, live resource — was still out there.
        await deps.tunnelConfigLock.run(async () => {
          const config = await deps.client.getTunnelConfig(deps.tunnelId);
          // Gated on THIS run's own flag, never on the mere fact that a rule sits at
          // this hostname right now — the 2C lesson. `true`: nothing was here before, so
          // this run's own entry is deleted outright. `false`: a human's rule was here;
          // it is restored VERBATIM (same hostname, its original `service`) rather than
          // merely left un-deleted, because `spliceIngress` already overwrote it in
          // place — "leave it alone" here has to mean "put back what was there", not
          // "don't call delete", since there is no delete-free path that already
          // achieves that. `ctx.originalIngressRule` is guaranteed set whenever
          // `ingressRuleCreatedByUs` is `false` — `run` above always sets both from the
          // same branch together.
          const updated = ctx.ingressRuleCreatedByUs
            ? removeIngress(config.ingress, deps.hostname)
            : spliceIngress(config.ingress, {
                hostname: deps.hostname,
                service: (ctx.originalIngressRule as IngressRule).service,
              });
          // Same F2 fix as `run` above.
          await deps.client.putTunnelConfig(deps.tunnelId, { ...config, ingress: updated });
        });
        await deps.db.delete(exposures).where(eq(exposures.id, ctx.exposureId));
      },
    },
    {
      name: "create-dns-record",
      async run(ctx) {
        if (ctx.exposureId === undefined) {
          throw new Error("create-dns-record ran before splice-ingress produced an exposure row");
        }
        const exposureId = ctx.exposureId;
        const existing = await deps.client.findDnsRecord(
          deps.zoneId,
          deps.hostname,
          `${deps.tunnelId}.cfargotunnel.com`,
        );
        const dnsRecordId =
          existing?.id ??
          (
            await deps.client.createDnsRecord(deps.zoneId, {
              name: deps.hostname,
              // §6: "a proxied CNAME to <tunnelId>.cfargotunnel.com" — `createDnsRecord`
              // itself always sends `proxied: true` (client.ts).
              content: `${deps.tunnelId}.cfargotunnel.com`,
            })
          ).id;
        // Adopted (found, not created) vs. created BY US — the 2C lesson, applied here:
        // an adopted record must never be authorised for deletion by the same match that
        // found it.
        const createdByUs = existing === null;
        try {
          await retryOnBusy(() =>
            deps.db
              .update(exposures)
              .set({ dnsRecordId, dnsRecordCreatedByUs: createdByUs })
              .where(eq(exposures.id, exposureId)),
          );
        } catch (error) {
          if (createdByUs) {
            // Same reasoning as `splice-ingress` above: this step is about to report
            // FAILED, and a failing step's own `undo` never runs, so the record just
            // created is stranded in Cloudflare with no local trace of it unless this
            // removes it before rethrowing.
            await deps.client.deleteDnsRecord(deps.zoneId, dnsRecordId).catch(() => {});
          }
          throw error;
        }
        ctx.dnsRecordId = dnsRecordId;
        ctx.dnsRecordCreatedByUs = createdByUs;
      },
      async undo(ctx) {
        if (ctx.dnsRecordId === undefined) return;
        // 2C's lesson, load-bearing here: adoption and deletion must not be authorised by
        // the same match. A record that already existed before this run is left alone —
        // see `client.test.ts`'s seeded-adoption test for the measured failure this
        // guards against.
        if (!ctx.dnsRecordCreatedByUs) return;
        await deps.client.deleteDnsRecord(deps.zoneId, ctx.dnsRecordId);
      },
    },
    {
      name: "create-access-app",
      async run(ctx) {
        if (ctx.exposureId === undefined) {
          throw new Error("create-access-app ran before splice-ingress produced an exposure row");
        }
        const exposureId = ctx.exposureId;
        const existing = await deps.client.findAccessApp(deps.hostname);
        const accessApp =
          existing ??
          (await deps.client.createAccessApp({
            domain: deps.hostname,
            name: deps.hostname,
            // §6: "policy list containing the chosen human policy plus the shared
            // monitor policy by ID."
            policyIds: [deps.humanPolicyId, deps.monitorPolicyId],
          }));
        const createdByUs = existing === null;
        try {
          await retryOnBusy(() =>
            deps.db
              .update(exposures)
              .set({
                accessAppId: accessApp.id,
                accessAppAud: accessApp.aud,
                accessAppCreatedByUs: createdByUs,
              })
              .where(eq(exposures.id, exposureId)),
          );
        } catch (error) {
          if (createdByUs) {
            await deps.client.deleteAccessApp(accessApp.id).catch(() => {});
          }
          throw error;
        }
        ctx.accessAppId = accessApp.id;
        ctx.accessAppAud = accessApp.aud;
        ctx.accessAppCreatedByUs = createdByUs;
      },
      async undo(ctx) {
        if (ctx.accessAppId === undefined) return;
        // Same 2C gate as `create-dns-record`'s undo, for the same reason.
        if (!ctx.accessAppCreatedByUs) return;
        await deps.client.deleteAccessApp(ctx.accessAppId);
      },
    },
    {
      name: "create-probe",
      async run(ctx) {
        if (ctx.exposureId === undefined) {
          throw new Error("create-probe ran before splice-ingress produced an exposure row");
        }
        const exposureId = ctx.exposureId;
        // The 2C lesson, applied to the fourth resource this sequence touches (2D's
        // whole-branch review, F1): an app can already carry its OWN `http_external`
        // probe — `routes/probes.ts` lets an admin create one any time, independent of
        // exposure — and this step must not duplicate it. Read under the same transaction
        // the write below happens in, so a concurrent probe creation can't land in the
        // gap between this check and the insert (Postgres-style TOCTOU is not this
        // project's storage engine, but `retryOnBusy` already exists for exactly this
        // kind of write contention — see its own doc comment).
        let probeId: string | undefined;
        let createdByUs: boolean | undefined;
        // Both writes below are local, with no network call between them — unlike the two
        // steps above, they can share ONE transaction: either both land or neither does,
        // so there is no partial-failure window for `runSteps`' "the failing step is
        // never undone" rule to strand one half of this pair in.
        await retryOnBusy(() =>
          deps.db.transaction(async (tx) => {
            const [existing] = await tx
              .select()
              .from(probes)
              .where(and(eq(probes.appId, deps.appId), eq(probes.kind, "http_external")));
            const thisProbeId = existing?.id ?? ulid();
            const thisCreatedByUs = existing === undefined;
            if (thisCreatedByUs) {
              await tx.insert(probes).values({
                id: thisProbeId,
                appId: deps.appId,
                kind: "http_external",
                target: `https://${deps.hostname}`,
              });
            }
            await tx
              .update(exposures)
              .set({ state: "ready", probeId: thisProbeId, probeCreatedByUs: thisCreatedByUs })
              .where(eq(exposures.id, exposureId));
            probeId = thisProbeId;
            createdByUs = thisCreatedByUs;
          }),
        );
        ctx.probeId = probeId;
        ctx.probeCreatedByUs = createdByUs;
      },
      async undo(ctx) {
        if (ctx.probeId === undefined) return;
        // Gated on THIS run's own flag, the same 2C lesson every other undo in this file
        // applies: an adopted probe — the admin's own, predating this exposure — is left
        // alone, never deleted just because `ctx` happens to hold its id.
        if (!ctx.probeCreatedByUs) return;
        await deps.db.delete(probes).where(eq(probes.id, ctx.probeId));
      },
    },
  ];
}
