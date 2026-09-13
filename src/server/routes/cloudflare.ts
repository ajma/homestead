import type {
  AccessConfigStatus,
  CloudflareZone,
  MonitorAccessStatus,
} from "@shared/cloudflare.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { resolveAccessSettings } from "../auth/access-settings.js";
import { requireCapability } from "../auth/context.js";
import { createCloudflareClient } from "../cloudflare/client.js";
import { CloudflareCredentialStore } from "../cloudflare/credentials.js";
import { CloudflareError } from "../cloudflare/errors.js";
import {
  ensureMonitorAccess,
  MonitorAccessStore,
  rotateMonitorSecret,
} from "../cloudflare/monitor-access.js";

// `.trim()` before `.min(1)`: a token pasted out of the Cloudflare dashboard frequently
// carries a trailing newline or space, invisible in a `type="password"` field. Untrimmed,
// that whitespace makes a correct token fail verification as `auth` — a support question
// that is genuinely hard to self-diagnose from the browser. Trimming first also means a
// whitespace-only value correctly fails `.min(1)` rather than sneaking through as
// "non-empty".
const putBody = z.object({
  token: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
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
  const monitorStore = new MonitorAccessStore(db, secrets);

  /** `MonitorAccess` (never carries the secret — see `monitor-access.ts`) to the wire
   * shape `MonitorAccessStatus` — the same discriminated-union treatment
   * `CloudflareCredentialStore.status()` gives credentials, for the same reason: a
   * caller cannot accidentally read `clientId` off a status that has none. */
  function toMonitorStatus(
    access: Awaited<ReturnType<typeof monitorStore.get>>,
  ): MonitorAccessStatus {
    if (!access) return { configured: false };
    return {
      configured: true,
      clientId: access.clientId,
      policyId: access.policyId,
      expiresAt: access.expiresAt,
    };
  }

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
    // A read, gated on the read capability — the same as `GET /credentials` above, and
    // deliberately not `cf:write`. Every role today either holds both `cf:read` and
    // `cf:write` or neither (see `src/shared/capabilities.ts`), so this was cosmetic
    // until the first role is granted `cf:read` alone; at that point a role meant to see
    // Cloudflare status would 403 on this route while `GET /credentials` succeeded,
    // rendering a half-built panel silently. See `cloudflare-read-capability.test.ts` for
    // the binding test — nothing at the role level exercises this today.
    requireCapability(request, "cf:read");
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

  /**
   * Read-only status of the one shared monitor service token and policy — gated on
   * `cf:read` like `GET /zones` and `GET /tunnel` above, for the same reason (every role
   * today holds both `cf:read` and `cf:write` or neither, so this is cosmetic until a
   * read-only role exists). Never touches Cloudflare: this reads what `MonitorAccessStore`
   * already has recorded, the same "status is a local read" shape `GET /credentials` and
   * `GET /tunnel` both use.
   */
  app.get("/api/cloudflare/monitor", async (request) => {
    requireCapability(request, "cf:read");
    return toMonitorStatus(await monitorStore.get());
  });

  /**
   * Creates the one shared monitor token and policy if they do not exist yet, or
   * returns the existing ones unchanged — `ensureMonitorAccess`'s own idempotency (see
   * its doc comment) is what makes a double-click or a retry safe here, not anything
   * this route does on top of it.
   */
  app.post("/api/cloudflare/monitor", async (request, reply) => {
    const ctx = requireCapability(request, "cf:write");
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
      const access = await ensureMonitorAccess({ store: monitorStore, client });
      await audit(db, ctx, {
        action: "cloudflare.monitor_access_ensured",
        targetId: access.tokenId,
      });
      return toMonitorStatus(access);
    } catch (error) {
      const fault = faultOf(error);
      return reply.code(502).send({ error: "cloudflare_error", fault });
    }
  });

  /**
   * Rotates the shared monitor token's secret in place — same token id, same policy id,
   * a new secret every app's probe picks up on its next credential read (2E). 409s if
   * there is nothing to rotate yet, the same "not configured" shape the credentials and
   * zones routes use, rather than surfacing `rotateMonitorSecret`'s internal error text.
   */
  app.post("/api/cloudflare/monitor/rotate", async (request, reply) => {
    const ctx = requireCapability(request, "cf:write");
    const existing = await monitorStore.get();
    if (!existing) {
      return reply.code(409).send({ error: "monitor_not_configured" });
    }

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
      const access = await rotateMonitorSecret({ store: monitorStore, client });
      await audit(db, ctx, {
        action: "cloudflare.monitor_secret_rotated",
        targetId: access.tokenId,
      });
      return toMonitorStatus(access);
    } catch (error) {
      const fault = faultOf(error);
      return reply.code(502).send({ error: "cloudflare_error", fault });
    }
  });

  /**
   * Read-only status of the resolved Access team domain and audience — same `cf:read`
   * gate as the other status routes above, and the same "status is a local read" shape:
   * `resolveAccessSettings` never calls Cloudflare, it only reads the environment and
   * `settings`/`exposures` (2E Task 2). `null` there becomes `{ configured: false }`
   * here, the same discriminated-union treatment every other status route in this file
   * gives its own nullable record.
   */
  app.get("/api/cloudflare/access", async (request) => {
    requireCapability(request, "cf:read");
    const resolved = await resolveAccessSettings({ db, config: app.deps.config });
    return (
      resolved
        ? { configured: true, teamDomain: resolved.teamDomain, aud: resolved.aud }
        : { configured: false }
    ) satisfies AccessConfigStatus;
  });
}
