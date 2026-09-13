import type { IngressRule } from "@shared/cloudflare.js";
import type { ProbeKind } from "@shared/types.js";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Step } from "../apps/step-sequence.js";
import { clearAccessTeamDomain, recordAccessTeamDomain } from "../auth/access-settings.js";
import type { Db, Tx } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { exposures, probes } from "../db/schema.js";
import type { CloudflareClient } from "./client.js";
import { removeIngress, spliceIngress } from "./ingress.js";

/**
 * §6: "The same published ports serve three consumers: LAN devices, the `http_internal`
 * probe, and the launcher's internal URL. One fact about an app rather than three." This is
 * that one fact, computed exactly once rather than three call sites each writing their own
 * `http://localhost:${port}` template literal and risking one of them drifting from the
 * other two (a stray `https://`, a trailing slash, `127.0.0.1` in one place and `localhost`
 * in another).
 *
 * F4 (whole-branch review, Important): this was true of only ONE of the two callers this
 * phase actually added — `routes/cloudflare-expose.ts` (the value passed to `exposeSteps`
 * below as `internalUrl`, used for BOTH the ingress rule's `service` field and the
 * `http_internal` probe's `target` via `create-probe`) called this function, while
 * `GET /api/apps/:id/probes/suggestions` (`routes/probes.ts`) still wrote its own
 * `http://localhost:${port}` literal — the plan's Task 4 asked for that second call site
 * to be the one that triggers this extraction, and it wasn't done. That gap stopped being
 * cosmetic the moment `upsertProbe` below started refusing to create or adopt an
 * `http_internal` probe whose target isn't byte-for-byte equal to what THIS function
 * produces (`ProbeTargetConflictError`) — a second construction drifting from this one by
 * even a trailing slash would make every suggestion `probes.ts` offers permanently
 * rejected by exposure. Both callers now import this rather than reimplement it; a future
 * launcher-URL caller (§6's third consumer, not built this phase) should do the same.
 */
export function internalServiceUrl(port: number): string {
  return `http://localhost:${port}`;
}

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
 * Thrown by `create-probe` (below) when the app's pre-existing `http_external` OR
 * `http_internal` probe targets something other than what this run is exposing. Fix wave
 * 2's Defect 2: the first version of probe adoption matched purely on `(appId, kind)` and
 * adopted whatever it found unconditionally, so an app that already carried its own check —
 * pointed at some other URL, entirely unrelated to this exposure — ended up with NO probe
 * watching the newly exposed target at all, while the UI kept showing a green probe the
 * whole time (it was still successfully checking its own, unrelated target). Silent, and
 * worse than having no probe: nothing here ever told anyone.
 *
 * Task 4 generalises this from `http_external` alone to either kind: 2F's ruling on the
 * external case applies identically to the internal one — an app that already has an
 * `http_internal` probe (created any time through `routes/probes.ts`, independent of
 * exposure) is the adoption case again, and the SAME reasoning against retargeting holds
 * (see below) with nothing about "internal" that changes it.
 *
 * Chosen fix: REFUSE rather than retarget. Retargeting was the other option on the
 * table — it is friendlier (the app comes up fully monitored with no extra step) — but it
 * means this sequence overwrites a `target` value an admin set on a row they created
 * through `routes/probes.ts`, with no exposure-specific column to remember what it was so
 * a later deprovision could put it back (adding one is a bigger, more error-prone change
 * than this wave's scope, and a half-restored target is its own silent-wrong-URL defect
 * one layer down). Refusing costs the admin one extra step — delete or repoint the
 * existing probe, then retry — but it never touches a row this sequence did not create,
 * which is the same principle every OTHER adopted-resource case in this file already
 * follows: adoption never means "assume it's fine to change".
 */
export class ProbeTargetConflictError extends Error {
  constructor(
    readonly kind: ProbeKind,
    readonly existingTarget: string,
    readonly expectedTarget: string,
  ) {
    super(
      `this app already has a ${kind} probe targeting ${existingTarget}, not ` +
        `${expectedTarget} — adopting it unchanged would leave the newly exposed ` +
        `${kind === "http_external" ? "hostname" : "internal service"} unmonitored while its ` +
        `status tile keeps showing a green ${kind === "http_external" ? "external" : "internal"} ` +
        `probe watching something else. Delete or repoint the existing probe, then retry ` +
        `exposing this app.`,
    );
    this.name = "ProbeTargetConflictError";
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
  /** Task 4's sibling to `probeId`/`probeCreatedByUs` above, for the `http_internal` probe
   * `create-probe` now also creates or adopts — tracked separately, by its own id, for the
   * exact reason `deprovision.ts`'s own doc comment gives: deleting by `(appId, kind)`
   * instead of the recorded id is the defect that destroyed an admin's own probe and its
   * whole check history (2D's whole-branch review, F1), and the internal probe carries the
   * identical exposure now that it exists. */
  probeInternalId?: string;
  probeInternalCreatedByUs?: boolean;
  /** `true` only when `record-self-access-settings` (2F Task 2, present only when
   * `ExposeDeps.selfAccessTeamDomain` is set) actually wrote the team-domain setting —
   * `false` when it found one already recorded and left it alone. Gates that step's own
   * `undo` the same "never delete what you merely found" way every flag above does. */
  teamDomainRecorded?: boolean;
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
  /** `internalServiceUrl(port)` — spec §6's `cloudflared` networking section — resolved and
   * validated by the caller (`routes/cloudflare-expose.ts`) against the app's own compose
   * config before this sequence ever runs: deriving and validating it needs the resolved
   * compose file, which is the route's concern, not this sequence's. Used for BOTH the
   * ingress rule's `service` field (`splice-ingress`, below) and the `http_internal`
   * probe's `target` (`create-probe`, below) — one value, two consumers, per §6's "one fact
   * about an app rather than three." Still written into the `exposures.ingress_service`
   * column unchanged (that column's own name and meaning predate this rename). */
  internalUrl: string;
  /** `AccessPolicies.humanPolicyId` (`access-policies.ts`, Task 2/3) — the one reusable
   * `allow` policy every enabled Homestead user's email is kept in, resolved by the
   * caller (`routes/cloudflare-expose.ts`) from `AccessPoliciesStore`, not supplied by the
   * admin. §6's "policy list containing the chosen human policy plus the shared monitor
   * policy by ID" predates Phase 3A, which made Homestead create and keep this policy
   * current itself (`ensureAccessPolicies`, `sync-access-users.ts`) rather than treating it
   * as something an admin pastes in per exposure, the way §6 originally described. */
  humanPolicyId: string;
  /** `AccessPolicies.monitorPolicyId` (`access-policies.ts`, Task 2) — the one reusable
   * `non_identity` policy shared by every exposed app. */
  monitorPolicyId: string;
  /**
   * Set by the caller (`routes/cloudflare-expose.ts`) ONLY when the app being exposed
   * carries `systemKind: "self"` — 2F Task 2, closing the three-times-deferred gap
   * `auth/access-settings.ts`'s `readFromDatabase` doc comment describes. `undefined` for
   * every other app's expose: appending the extra step below for an app that is not
   * `self` would let exposing an ordinary app repoint the account-wide Access
   * verification setting, which is exactly the mistake `recordAccessTeamDomain`'s own doc
   * comment calls out.
   */
  selfAccessTeamDomain?: string;
};

/**
 * Adopts an existing `(appId, kind)` probe whose target already matches, refuses one whose
 * target does not (`ProbeTargetConflictError` — see its own doc comment), or creates a new
 * one — the one piece of logic `create-probe` needs twice (once per probe kind), extracted
 * so both call sites can never drift into checking the conflict differently. Callers pass
 * this the SAME transaction their own write happens in — see `create-probe`'s own comment
 * on why the read and the write must share one transaction.
 */
async function upsertProbe(
  tx: Tx,
  args: { appId: string; kind: ProbeKind; expectedTarget: string },
): Promise<{ id: string; createdByUs: boolean }> {
  const [existing] = await tx
    .select()
    .from(probes)
    .where(and(eq(probes.appId, args.appId), eq(probes.kind, args.kind)));
  if (existing && existing.target !== args.expectedTarget) {
    throw new ProbeTargetConflictError(
      args.kind,
      existing.target ?? "(no target)",
      args.expectedTarget,
    );
  }
  const id = existing?.id ?? ulid();
  const createdByUs = existing === undefined;
  if (createdByUs) {
    await tx
      .insert(probes)
      .values({ id, appId: args.appId, kind: args.kind, target: args.expectedTarget });
  }
  return { id, createdByUs };
}

/**
 * The four-step expose sequence (spec §6), for `runSteps`/`StepJobRunner` — five when
 * exposing the app marked `systemKind: "self"` (2F Task 2 appends `record-self-access-
 * settings`; see `ExposeDeps.selfAccessTeamDomain`). Each step is idempotent (adopts an
 * existing resource rather than duplicating it) and records whether IT created what it
 * is now responsible for — the `exposures` row's
 * `dnsRecordCreatedByUs`/`ingressRuleCreatedByUs`/`accessAppCreatedByUs` columns, designed
 * in Phase 1A, plus `probeId`/`probeCreatedByUs` (added by this fix — see `create-probe`'s
 * doc comment and 2D's whole-branch review, F1). 2C's whole-branch review measured what
 * happens when adoption and deletion share one match: a rollback deleted a tunnel it had
 * only adopted. Every `undo` below that touches a resource which might have pre-existed
 * gates the delete on the flag THIS run set, never on the fact that `ctx` merely holds an
 * id.
 */
export function exposeSteps(deps: ExposeDeps): Array<Step<ExposeCtx>> {
  const steps: Array<Step<ExposeCtx>> = [
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
            service: deps.internalUrl,
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
              ingressService: deps.internalUrl,
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
        // The 2C lesson, applied to the fourth AND fifth resources this sequence touches
        // (2D's whole-branch review, F1; Task 4 adds the internal probe as the fifth): an
        // app can already carry its OWN `http_external` or `http_internal` probe —
        // `routes/probes.ts` lets an admin create either any time, independent of exposure
        // — and this step must not duplicate either. Both checks run under the SAME
        // transaction the writes below happen in, so a concurrent probe creation can't
        // land in the gap between either check and its insert (Postgres-style TOCTOU is
        // not this project's storage engine, but `retryOnBusy` already exists for exactly
        // this kind of write contention — see its own doc comment).
        //
        // Fix wave 2's Defect 2, applied to both kinds: adoption alone is not enough — an
        // adopted probe that targets something other than THIS exposure's own target must
        // not be adopted silently (see `ProbeTargetConflictError`'s own doc comment for
        // why refusing, not retargeting, is the chosen fix, and Task 4's own note there on
        // why the internal case follows the identical ruling). Checked and thrown from
        // inside the same transaction as the read that found it, before anything is
        // written, so a refusal here leaves nothing for this step's own `undo` to clean up
        // — `runSteps` rolls back the three earlier steps exactly as it would for any
        // other failing step.
        const expectedExternalTarget = `https://${deps.hostname}`;
        const expectedInternalTarget = deps.internalUrl;
        let external: { id: string; createdByUs: boolean } | undefined;
        let internal: { id: string; createdByUs: boolean } | undefined;
        // All four writes below (two possible inserts, one exposures update) are local,
        // with no network call between them — unlike the two steps above, they can share
        // ONE transaction: either all land or none does, so there is no partial-failure
        // window for `runSteps`' "the failing step is never undone" rule to strand one
        // probe's half of this pair in without the other.
        await retryOnBusy(() =>
          deps.db.transaction(async (tx) => {
            external = await upsertProbe(tx, {
              appId: deps.appId,
              kind: "http_external",
              expectedTarget: expectedExternalTarget,
            });
            internal = await upsertProbe(tx, {
              appId: deps.appId,
              kind: "http_internal",
              expectedTarget: expectedInternalTarget,
            });
            await tx
              .update(exposures)
              .set({
                state: "ready",
                probeId: external.id,
                probeCreatedByUs: external.createdByUs,
                probeInternalId: internal.id,
                probeInternalCreatedByUs: internal.createdByUs,
              })
              .where(eq(exposures.id, exposureId));
          }),
        );
        ctx.probeId = external?.id;
        ctx.probeCreatedByUs = external?.createdByUs;
        ctx.probeInternalId = internal?.id;
        ctx.probeInternalCreatedByUs = internal?.createdByUs;
      },
      async undo(ctx) {
        // Gated on THIS run's own flag, the same 2C lesson every other undo in this file
        // applies: an adopted probe — the admin's own, predating this exposure — is left
        // alone, never deleted just because `ctx` happens to hold its id. Each probe is
        // gated and deleted independently — one may be adopted while the other was
        // created by this run.
        if (ctx.probeId !== undefined && ctx.probeCreatedByUs) {
          await deps.db.delete(probes).where(eq(probes.id, ctx.probeId));
        }
        if (ctx.probeInternalId !== undefined && ctx.probeInternalCreatedByUs) {
          await deps.db.delete(probes).where(eq(probes.id, ctx.probeInternalId));
        }
      },
    },
  ];

  // Present only for the app marked `systemKind: "self"` — see `ExposeDeps
  // .selfAccessTeamDomain`'s own doc comment for why every other expose omits it
  // entirely rather than receiving it as `undefined` and no-op-ing internally: an app
  // that is not self must never even CONTAIN a step capable of touching this account-wide
  // setting, not merely decline to run it.
  if (deps.selfAccessTeamDomain !== undefined) {
    const teamDomain = deps.selfAccessTeamDomain;
    steps.push({
      name: "record-self-access-settings",
      async run(ctx) {
        // `exposures.accessAppAud` (written by `create-access-app`, above) is already
        // recorded for every exposed app unconditionally — the only piece 2E's database
        // path was still missing is this account-wide team domain, and only for `self`.
        const { wrote } = await recordAccessTeamDomain(deps.db, teamDomain);
        ctx.teamDomainRecorded = wrote;
      },
      async undo(ctx) {
        // Never delete what this run merely found already configured — the same rule
        // every other adopted-resource `undo` in this file follows.
        if (!ctx.teamDomainRecorded) return;
        await clearAccessTeamDomain(deps.db);
      },
    });
  }

  return steps;
}
