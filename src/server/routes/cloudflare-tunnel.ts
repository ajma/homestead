import type { FastifyInstance } from "fastify";
import { audit } from "../audit.js";
import { requireCapability } from "../auth/context.js";
import { createCloudflareClient } from "../cloudflare/client.js";
import { CloudflareCredentialStore } from "../cloudflare/credentials.js";
import { CLOUDFLARED_TUNNEL_NAME, tunnelProvisionSteps } from "../cloudflare/provision-tunnel.js";
import { TunnelStore } from "../cloudflare/tunnel-store.js";

/** The `jobs.kind` this route records under — never in `JOB_KINDS` (`job-runner.ts`), the
 * same reason every other step-job kind is not: `runningJobs` filters on `JOB_KINDS`
 * deliberately, so a `GET /api/jobs/:id/stream` client never gets handed a job id that
 * route cannot follow (`StepJobRunner` has no `live`/streaming — see its class doc). */
export const TUNNEL_PROVISION_KIND = "cloudflare_tunnel_provision";

export async function cloudflareTunnelRoutes(app: FastifyInstance): Promise<void> {
  const { db, secrets, host, stepJobs } = app.deps;
  const credentialStore = new CloudflareCredentialStore(db, secrets);
  const tunnelStore = new TunnelStore(db, secrets);

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

    // `appId: null` — see `StepJobRunner.start`'s doc: this sequence's own steps create
    // the app it eventually registers, so there is no row to key the lock or the job's
    // `appId` column on when the sequence starts.
    const { id } = await stepJobs.start(null, TUNNEL_PROVISION_KIND, steps, {}, ctx.userId);

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
