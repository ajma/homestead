import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppBusyError } from "../apps/app-lock.js";
import { audit } from "../audit.js";
import { requireCapability } from "../auth/context.js";
import { createCloudflareClient } from "../cloudflare/client.js";
import { CloudflareCredentialStore } from "../cloudflare/credentials.js";
import { deprovision } from "../cloudflare/deprovision.js";
import { exposeSteps } from "../cloudflare/expose.js";
import { MonitorAccessStore } from "../cloudflare/monitor-access.js";
import { TunnelStore } from "../cloudflare/tunnel-store.js";
import { exposures } from "../db/schema.js";
import { loadApp } from "./apps.js";

/** The `jobs.kind` this route records under. Never in `JOB_KINDS` (`job-runner.ts`) —
 * same reason `TUNNEL_PROVISION_KIND` (`cloudflare-tunnel.ts`) is not, and the exact name
 * `running-jobs.ts`'s own doc comment already uses as its example of a step-job kind
 * outside that filter. */
export const EXPOSE_KIND = "cloudflare_expose";

/** `cloudflared` fetches this exact URL — spec §6's networking section:
 * `http://localhost:<published-port>`, dialled from inside the `cloudflared` container
 * (`network_mode: host`, so it can reach anything on the NAS or its LAN — §6), NOT the
 * Homestead server itself. This is not the same SSRF exposure `routes/probes.ts`'s
 * `targetSchema` guards against (the server fetching a probe target), even though it
 * reuses the same http(s)-only shape: the value here is written into the tunnel's
 * ingress array, which is why `ssh://`, `unix:`, `tcp://` and the special `http_status:`
 * services are still worth rejecting through this route — an admin has no other reason to
 * write one of those here, and cloudflared's own ingress config already has room for
 * behaviour this project does not want to expose through a plain string field. */
const ingressServiceSchema = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "ingressService must be an http or https URL");

const exposeBody = z.object({
  hostname: z.string().trim().min(1),
  zoneId: z.string().trim().min(1),
  ingressService: ingressServiceSchema,
  /** The admin-chosen Access policy demanding a human identity — spec §6. Homestead does
   * not create or manage this policy; it is referenced by id, the same way the shared
   * monitor policy is (see `expose.ts`'s `ExposeDeps.humanPolicyId`). */
  policyId: z.string().trim().min(1),
  /**
   * Required ONLY when the app being exposed is `systemKind: "self"` — checked below,
   * not in this schema, since that depends on a database row the schema cannot see. The
   * account's Cloudflare Zero Trust team domain has no API this project's existing
   * credentials are known to reach (unlike everything else this route already resolves
   * — zones, the tunnel, the monitor policy) and no other place in this codebase
   * captures it (`grep`-verified: `HOMESTEAD_ACCESS_TEAM_DOMAIN` is the only other
   * source), so the admin — who necessarily already knows it, the same way they already
   * know the human `policyId` above — supplies it here, once, at the moment 2E's
   * database path actually needs it: when Homestead exposes itself.
   */
  teamDomain: z.string().trim().min(1).optional(),
});

export async function cloudflareExposeRoutes(app: FastifyInstance): Promise<void> {
  const { db, secrets, stepJobs, tunnelConfigLock } = app.deps;
  const credentialStore = new CloudflareCredentialStore(db, secrets);
  const tunnelStore = new TunnelStore(db, secrets);
  const monitorStore = new MonitorAccessStore(db, secrets);

  app.post("/api/apps/:id/expose", async (request, reply) => {
    const ctx = requireCapability(request, "cf:write");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = exposeBody.parse(request.body);

    // 404, not 403 or 409, for an app outside the caller's scope or that does not exist —
    // `loadApp` composes `visibleAppsWhere` so this never confirms an app the caller may
    // not see exists (its own doc comment, `apps.ts`).
    const appRow = await loadApp(db, ctx, id);
    if (!appRow) return reply.code(404).send({ error: "not_found" });

    const [existingExposure] = await db.select().from(exposures).where(eq(exposures.appId, id));
    if (existingExposure) {
      return reply.code(409).send({ error: "already_exposed" });
    }

    // 2F Task 2: the one case `teamDomain` is required — see `exposeBody`'s own comment
    // on why this route asks for it here rather than resolving it some other way.
    const isSelf = appRow.systemKind === "self";
    if (isSelf && body.teamDomain === undefined) {
      return reply.code(422).send({ error: "team_domain_required" });
    }

    // `exposures.hostname` is `.unique()` (schema.ts) same as `appId` above, but was never
    // pre-checked here — a second app exposed at a hostname another app already holds hit
    // the unique constraint deep inside `splice-ingress`'s insert, surfacing as a bare 500
    // after already splicing the new app's service into the tunnel over the first app's
    // rule (2D's whole-branch review, F11). Checked here for the same reason
    // `already_exposed` is: a clean 409 before anything is touched, not a failure a job's
    // own inline compensation has to unwind.
    const [hostnameTaken] = await db
      .select()
      .from(exposures)
      .where(eq(exposures.hostname, body.hostname));
    if (hostnameTaken) {
      return reply.code(409).send({ error: "hostname_taken" });
    }

    const tunnel = await tunnelStore.get();
    if (!tunnel) {
      return reply.code(409).send({ error: "tunnel_not_provisioned" });
    }

    const monitorAccess = await monitorStore.get();
    if (!monitorAccess) {
      return reply.code(409).send({ error: "monitor_not_configured" });
    }

    const credentials = await credentialStore.get();
    if (!credentials) {
      return reply.code(409).send({ error: "not_configured" });
    }

    const client = createCloudflareClient({
      token: credentials.token,
      accountId: credentials.accountId,
      fetch: app.deps.fetch,
    });

    const steps = exposeSteps({
      db,
      client,
      tunnelConfigLock,
      appId: id,
      hostname: body.hostname,
      zoneId: body.zoneId,
      tunnelId: tunnel.tunnelId,
      ingressService: body.ingressService,
      humanPolicyId: body.policyId,
      monitorPolicyId: monitorAccess.policyId,
      // `undefined` for every non-self app — see `ExposeDeps.selfAccessTeamDomain`'s own
      // doc comment for why that must be an absent field, not merely an unused one.
      selfAccessTeamDomain: isSelf ? body.teamDomain : undefined,
    });

    let jobId: string;
    try {
      ({ id: jobId } = await stepJobs.start(id, EXPOSE_KIND, steps, {}, ctx.userId));
    } catch (error) {
      // This app already has another step job (or compose job — `stepJobs` and `jobs`
      // share one `AppLock`) in flight. A double-click or a race, not a server bug — same
      // mapping `cloudflare-tunnel.ts`'s POST route gives `AppBusyError`. Nothing is
      // audited for this attempt, matching `routes/jobs.ts`'s convention for
      // `JobBusyError`: the sequence never actually started.
      if (error instanceof AppBusyError) {
        return reply.code(409).send({ error: "app_busy" });
      }
      throw error;
    }

    // Audited AFTER `stepJobs.start`, matching `routes/jobs.ts`'s convention — not the
    // workaround this route needed through 2D/2E. `StepJobRunner.start` used to block for
    // the WHOLE sequence, so an audit call placed after it would have produced zero audit
    // rows for a run that crashed mid-sequence; 2F Task 1 detached `start` from the
    // sequence it kicks off, so it now returns as soon as the job row is inserted, and
    // this call lands just as promptly as the pre-2D workaround did.
    await audit(db, ctx, {
      action: "cloudflare.expose_started",
      targetType: "app",
      targetId: id,
      detail: { hostname: body.hostname },
    });

    return reply.code(202).send({ jobId });
  });

  app.delete("/api/apps/:id/expose", async (request, reply) => {
    const ctx = requireCapability(request, "cf:write");
    const { id } = z.object({ id: z.string() }).parse(request.params);

    // Same 404-not-403/409 reasoning as the POST route above: an app outside the
    // caller's scope (or that does not exist at all) must never distinguish itself from
    // "not exposed" or any other 409 below — a 409 here would confirm the app exists.
    const appRow = await loadApp(db, ctx, id);
    if (!appRow) return reply.code(404).send({ error: "not_found" });

    const [exposure] = await db.select().from(exposures).where(eq(exposures.appId, id));
    if (!exposure) {
      return reply.code(409).send({ error: "not_exposed" });
    }

    const credentials = await credentialStore.get();
    if (!credentials) {
      return reply.code(409).send({ error: "not_configured" });
    }

    // The SAME `AppLock` the POST route's `stepJobs.start` (above) takes on this app id —
    // without it, this route could race the app's OWN in-flight expose job, not just a
    // concurrent compose action (2D's whole-branch review, F7 — the measured outcome was
    // an orphaned CNAME and Access application, a stranded probe row, a deleted
    // `exposures` row, and BOTH operations reporting success). `AppBusyError` is the same
    // 409 mapping the POST route already gives it.
    if (!app.deps.appLock.tryAcquire(id, "cloudflare_expose_deprovision")) {
      return reply.code(409).send({ error: "app_busy" });
    }
    try {
      // Audited BEFORE `deprovision` runs, not after — same reasoning as the POST route's
      // own audit call: a crash partway through a real, multi-Cloudflare-call teardown
      // must still leave a record that someone asked for it, not zero audit rows for the
      // one action that starts pulling live resources down.
      await audit(db, ctx, {
        action: "cloudflare.expose_deprovision_started",
        targetType: "app",
        targetId: id,
        detail: { hostname: exposure.hostname },
      });

      const client = createCloudflareClient({
        token: credentials.token,
        accountId: credentials.accountId,
        fetch: app.deps.fetch,
      });

      const outcome = await deprovision({ db, client, tunnelConfigLock }, exposure);

      if (!outcome.ok) {
        // Not a rollback and not a 4xx — the caller's request was well-formed and the app
        // WAS exposed; some subset of the four resources could not be removed right now.
        // The `exposures` row still exists (deliberately — see `deprovision.ts`'s own doc
        // comment on why it is deleted last) with the flags for what succeeded already
        // flipped, so calling this same endpoint again resumes exactly where it left off.
        return reply.code(500).send({
          error: "deprovision_incomplete",
          failures: outcome.failures.map((f) => f.resource),
        });
      }

      return reply.code(200).send({ ok: true });
    } finally {
      app.deps.appLock.release(id);
    }
  });
}
