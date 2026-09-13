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

    // Audited BEFORE `stepJobs.start`, not after — unlike `routes/jobs.ts`'s lifecycle
    // actions, where `runner.start` returns as soon as the job row is inserted and the
    // audit call right after it effectively still lands "on start". `StepJobRunner.start`
    // is different: it does not return until the WHOLE sequence — including any rollback
    // — has finished (see its own class doc, and the whole-branch review's ruling on why
    // that is deliberate for now, not a bug). An audit call placed after it, as this used
    // to do, produces zero audit rows for the entire run: measured, a crash after
    // `create-tunnel` — power loss, OOM-kill, a restart — leaves a real Cloudflare tunnel
    // with no record that anyone ever asked for it, on the one action this project's
    // audit log exists to catch. Moving it here means the row exists the instant an admin
    // asks, regardless of how the sequence ends.
    //
    // NOT fixed here, and deliberately left for 2D: the blocking `await` inside `start`
    // itself. Detaching it — resolving once the job row is written and letting the
    // sequence run to completion in the background — would let this route return long
    // before a 5-minute `compose-up` finishes, which also fixes the initiating tab's lack
    // of live output (`CloudflarePanel.tsx`) and the 524 this design hits once Homestead
    // is reached through the very tunnel it provisions. Every piece that needs is already
    // built (`GET /api/cloudflare/tunnel`'s `runningJobId`, `jobs.ts`'s `waitForTerminalJob`,
    // the panel's adopt-on-mount effect) — only `await sequence` in `step-job-runner.ts`
    // stands in the way, and touching it is out of scope for this phase.
    await audit(db, ctx, {
      action: "cloudflare.tunnel_provision_started",
      ip: request.ip,
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
      // so a race reads as "try again shortly", not as a server bug. The audit row above
      // still stands in this case — an admin genuinely did ask, even though this
      // particular request lost the race for the lock.
      if (error instanceof AppBusyError) {
        return reply.code(409).send({ error: "tunnel_provision_running" });
      }
      throw error;
    }

    return reply.code(202).send({ jobId: id });
  });
}
