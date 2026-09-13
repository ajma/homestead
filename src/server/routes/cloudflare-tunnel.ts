import type { TunnelStatus } from "@shared/cloudflare.js";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AppBusyError } from "../apps/app-lock.js";
import { audit } from "../audit.js";
import { requireCapability } from "../auth/context.js";
import { createCloudflareClient } from "../cloudflare/client.js";
import { CloudflareCredentialStore } from "../cloudflare/credentials.js";
import { CLOUDFLARED_TUNNEL_NAME, tunnelProvisionSteps } from "../cloudflare/provision-tunnel.js";
import { TunnelStore } from "../cloudflare/tunnel-store.js";
import { jobs } from "../db/schema.js";

/** The `jobs.kind` this route records under — never in `JOB_KINDS` (`job-runner.ts`), the
 * same reason every other step-job kind is not: `runningJobs` filters on `JOB_KINDS`
 * deliberately, so this job never makes an inventory row's busy indicator (`useAppActions`,
 * also `JOB_KINDS`-filtered) light up — that gap is accepted for the general inventory case
 * (2C Task 4's brief) and is not what this constant is about. `GET /api/jobs/:jobId/stream`
 * itself CAN follow this kind: `jobs.ts` polls a job with no `live` handle until it reaches
 * a terminal status rather than assuming `!live` means "already finished", precisely so a
 * kind outside `JOB_KINDS` (like this one) can still be streamed by `JobOutput`. */
export const TUNNEL_PROVISION_KIND = "cloudflare_tunnel_provision";

export async function cloudflareTunnelRoutes(app: FastifyInstance): Promise<void> {
  const { db, secrets, host, stepJobs } = app.deps;
  const credentialStore = new CloudflareCredentialStore(db, secrets);
  const tunnelStore = new TunnelStore(db, secrets);

  /** The provision sequence's own currently-running job, if any — system-wide, since
   * `StepJobRunner`'s `NO_APP_LOCK_KEY` already limits this to at most one at a time (its
   * own doc comment). Read fresh on every `GET`, not cached: this is exactly the fact a
   * reloaded panel (or a second admin's tab) has no other way to learn, since the job's
   * `appId` is `null` and so is invisible to every app-scoped job listing. */
  async function runningProvisionJobId(): Promise<string | null> {
    const [row] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, TUNNEL_PROVISION_KIND), eq(jobs.status, "running")));
    return row?.id ?? null;
  }

  app.get("/api/cloudflare/tunnel", async (request) => {
    // Read-only, gated like `GET /api/cloudflare/zones` — the same reasoning applies
    // (`routes/cloudflare.ts`'s own comment): every role today has both `cf:read` and
    // `cf:write` or neither, so this is cosmetic until that changes, at which point a
    // `cf:read`-only role should see this and not 403.
    requireCapability(request, "cf:read");
    const [record, runningJobId] = await Promise.all([tunnelStore.get(), runningProvisionJobId()]);
    if (record) {
      return {
        provisioned: true,
        name: record.name,
        appId: record.appId,
        runningJobId,
      } satisfies TunnelStatus;
    }
    return { provisioned: false, runningJobId } satisfies TunnelStatus;
  });

  app.post("/api/cloudflare/tunnel", async (request, reply) => {
    const ctx = requireCapability(request, "cf:write");

    // The primary "already provisioned" guard (see `provision-tunnel.ts`'s doc on
    // `tunnelProvisionSteps` for why the rest of the idempotency story lives in
    // `create-tunnel` instead): cheap, no Cloudflare round trip, and answers the common
    // case — a double-clicked Provision button, or a tunnel that is already fully set up
    // — before a job row or the app lock is ever taken.
    const existingTunnel = await tunnelStore.get();
    if (existingTunnel) {
      return reply.code(409).send({ error: "tunnel_exists" });
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

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });

    let id: string;
    try {
      // `appId: null` — see `StepJobRunner.start`'s doc: this sequence's own steps create
      // the app it eventually registers, so there is no row to key the lock or the job's
      // `appId` column on when the sequence starts.
      ({ id } = await stepJobs.start(null, TUNNEL_PROVISION_KIND, steps, {}, ctx.userId));
    } catch (error) {
      // The `existingTunnel` check above only catches the case where a PREVIOUS attempt
      // already finished; it says nothing about one still in flight right now, holding
      // `StepJobRunner`'s `NO_APP_LOCK_KEY`. A second POST landing in that window — a
      // double-click, or a race between two admins — reaches `stepJobs.start` itself and
      // gets `AppBusyError` there, same as `JobRunner.start` throws for an app-scoped
      // lock. Uncaught, that error has no `statusCode` and would 500 through the generic
      // handler in `app.ts`; mapped here the same way `routes/jobs.ts` maps `JobBusyError`,
      // so a race reads as "try again shortly", not as a server bug.
      if (error instanceof AppBusyError) {
        return reply.code(409).send({ error: "tunnel_provision_running" });
      }
      throw error;
    }

    // Audited on start, not on completion — the same convention `routes/jobs.ts` uses for
    // a lifecycle action: this records that an admin asked for the tunnel to be
    // provisioned, not that it succeeded. The job row (and, on failure, its transcript and
    // `undoFailures`) is the record of the outcome.
    await audit(db, ctx, {
      action: "cloudflare.tunnel_provision_started",
      ip: request.ip,
    });

    return reply.code(202).send({ jobId: id });
  });
}
