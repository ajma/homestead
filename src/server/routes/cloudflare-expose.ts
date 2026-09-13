import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppBusyError } from "../apps/app-lock.js";
import { audit } from "../audit.js";
import { requireCapability } from "../auth/context.js";
import { createCloudflareClient } from "../cloudflare/client.js";
import { CloudflareCredentialStore } from "../cloudflare/credentials.js";
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

/** The server fetches this exact URL — spec §6's `cloudflared` networking section:
 * `http://localhost:<published-port>`. Validated as http(s) for the same SSRF reason
 * `routes/probes.ts`'s `targetSchema` validates a probe target. */
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
    });

    // Audited BEFORE `stepJobs.start`, not after — same reasoning as
    // `cloudflare-tunnel.ts`'s POST route: `StepJobRunner.start` does not return until the
    // WHOLE sequence (including any rollback) has finished, so an audit call placed after
    // it would produce zero audit rows for a run that crashes mid-sequence.
    await audit(db, ctx, {
      action: "cloudflare.expose_started",
      targetType: "app",
      targetId: id,
      detail: { hostname: body.hostname },
    });

    let jobId: string;
    try {
      ({ id: jobId } = await stepJobs.start(id, EXPOSE_KIND, steps, {}, ctx.userId));
    } catch (error) {
      // This app already has another step job (or compose job — `stepJobs` and `jobs`
      // share one `AppLock`) in flight. A double-click or a race, not a server bug — same
      // mapping `cloudflare-tunnel.ts`'s POST route gives `AppBusyError`.
      if (error instanceof AppBusyError) {
        return reply.code(409).send({ error: "app_busy" });
      }
      throw error;
    }

    return reply.code(202).send({ jobId });
  });
}
