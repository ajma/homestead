import type { CloudflareZone } from "@shared/cloudflare.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireCapability } from "../auth/context.js";
import { createCloudflareClient } from "../cloudflare/client.js";
import { CloudflareCredentialStore } from "../cloudflare/credentials.js";
import { CloudflareError } from "../cloudflare/errors.js";

const putBody = z.object({
  token: z.string().min(1),
  accountId: z.string().min(1),
});

/**
 * Reads a `CloudflareError`'s fault off any thrown value, defaulting to `network` for
 * whatever isn't one — `createCloudflareClient` throws `CloudflareError` for everything
 * it recognises, so anything else reaching here (a bug, an unexpected rejection) is at
 * least as "couldn't reach Cloudflare" as a real network failure is.
 */
function faultOf(error: unknown): CloudflareError["fault"] {
  return error instanceof CloudflareError ? error.fault : "network";
}

export async function cloudflareRoutes(app: FastifyInstance): Promise<void> {
  const { db, secrets } = app.deps;
  const store = new CloudflareCredentialStore(db, secrets);

  /**
   * Verification strategy: `listZones()`, not a dedicated verify endpoint.
   *
   * A verify endpoint would only tell us a token is *live*. Listing zones tells us the
   * token is live AND carries Zone:Read AND that our transport, auth header and envelope
   * parsing all work against the real API — it exercises a permission §6 actually
   * requires, using the one endpoint group this plan could verify at all (the
   * account-owned-token verify path is not on the list of confirmed Cloudflare facts;
   * see docs/superpowers/plans/2026-09-12-homestead-2a-cloudflare-credentials.md).
   *
   * What this does NOT prove: a token that passes has Zone:Read and nothing more. §6
   * lists four account-scoped permissions (Cloudflare Tunnel:Edit, Access: Apps and
   * Policies:Edit, Access: Service Tokens:Edit, DNS:Edit) that this check never touches —
   * a token missing one of those will verify happily here and fail later, in the
   * sub-phase that first needs it. That later failure surfaces through the client's
   * `permission` fault, so it reads as "this token lacks a permission" rather than as an
   * unexplained outage. The token is NOT fully validated by this check.
   */
  async function verify(creds: { token: string; accountId: string }): Promise<void> {
    const client = createCloudflareClient({
      token: creds.token,
      accountId: creds.accountId,
      fetch: app.deps.fetch,
    });
    await client.listZones();
  }

  app.get("/api/cloudflare/credentials", async (request) => {
    requireCapability(request, "cf:read");
    return store.status();
  });

  app.put("/api/cloudflare/credentials", async (request, reply) => {
    const ctx = requireCapability(request, "cf:write");
    const body = putBody.parse(request.body);

    try {
      await verify(body);
    } catch (error) {
      const fault = faultOf(error);
      // Not stored: an unverified token left in place would make every later phase fail
      // confusingly instead of failing here, clearly, at the moment an admin is watching.
      await audit(db, ctx, {
        action: "cloudflare.credentials_verify_failed",
        detail: { fault },
      });
      return reply.code(422).send({ error: "verification_failed", fault });
    }

    const verifiedAt = Math.floor(Date.now() / 1000);
    await store.save(body, verifiedAt);
    await audit(db, ctx, {
      action: "cloudflare.credentials_saved",
      targetId: body.accountId,
    });
    return store.status();
  });

  app.delete("/api/cloudflare/credentials", async (request, reply) => {
    const ctx = requireCapability(request, "cf:write");
    await store.clear();
    await audit(db, ctx, { action: "cloudflare.credentials_deleted" });
    return reply.code(204).send();
  });

  app.get("/api/cloudflare/zones", async (request, reply) => {
    requireCapability(request, "cf:write");
    const creds = await store.get();
    if (!creds) {
      return reply.code(409).send({ error: "not_configured" });
    }

    try {
      const client = createCloudflareClient({
        token: creds.token,
        accountId: creds.accountId,
        fetch: app.deps.fetch,
      });
      const zones = await client.listZones();
      return zones satisfies CloudflareZone[];
    } catch (error) {
      const fault = faultOf(error);
      return reply.code(502).send({ error: "cloudflare_error", fault });
    }
  });
}
