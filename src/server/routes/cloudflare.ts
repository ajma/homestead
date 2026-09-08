import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ExposureSummary } from "../../shared/cloudflare.js";
import { requirePermission } from "../auth/guard.js";
import { deleteApp } from "../cloudflare/access.js";
import {
  type CloudflareClient,
  createCloudflareClient,
} from "../cloudflare/client.js";
import { runSetup } from "../cloudflare/setup.js";
import { reconcileExposures } from "../cloudflare/sync.js";
import { syncAllowPolicy } from "../cloudflare/sync-users.js";
import { deleteDnsRecord } from "../cloudflare/tunnel.js";
import { decrypt, encrypt } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { exposures, settings } from "../db/schema.js";
import { listContainers } from "../docker/engine.js";
import { type DockerRunner, dockerRunner } from "../docker/run.js";
import { writeProjectFiles } from "../projects/store.js";

type Opts = {
  db: Db;
  secretKey: Buffer;
  cloudflare?: (opts: { token: string }) => CloudflareClient;
  /** Where the cloudflared stack is written, as an ordinary project. */
  projectsDir: string;
  /** The only route to `docker`; a fake in tests. */
  docker?: DockerRunner;
};

async function getDecryptedToken(
  db: Db,
  secretKey: Buffer,
): Promise<string | null> {
  const [tokenRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.apiToken"));

  if (!tokenRow) {
    return null;
  }

  return decrypt(tokenRow.value, secretKey);
}

export const cloudflareRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db } = opts;

  app.get(
    "/api/cloudflare/status",
    { preHandler: requirePermission({ tunnel: ["read"] }) },
    async () => {
      const rows = await db.select().from(settings);
      const settingsMap = new Map(rows.map((r) => [r.key, r.value]));

      const accountId = settingsMap.get("cloudflare.accountId") ?? null;
      const tunnelId = settingsMap.get("cloudflare.tunnelId") ?? null;
      const idpId = settingsMap.get("cloudflare.idpId") ?? null;
      const syncState = settingsMap.get("cloudflare.syncState") ?? "synced";

      // For now, return a static runtime - real detection would require docker access
      const runtime = { kind: "none" as const };

      const configured = accountId !== null && tunnelId !== null;

      return {
        configured,
        accountId,
        tunnelId,
        runtime,
        idpId,
        syncState,
      };
    },
  );

  app.post(
    "/api/cloudflare/token",
    { preHandler: requirePermission({ tunnel: ["create"] }) },
    async (request, reply) => {
      const body = z
        .object({
          token: z.string().min(1),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }

      const { token } = body.data;

      // Create client and verify token
      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });

      // Homestead outlives the person who set it up. A user token stops
      // working the day its owner loses access to the account, and every
      // exposed hostname becomes unmanageable with it — so refuse one here
      // rather than let setup succeed and rot later.
      if ((await client.detectTokenKind()) === "user") {
        return reply.status(400).send({
          error: "user_token",
          detail:
            "This is a user API token. Homestead needs an account-owned " +
            "token so it keeps working if you lose access to the account. " +
            "Create one under Manage Account → Account API Tokens (it " +
            "requires Super Administrator and its value starts with cfat_).",
        });
      }

      const verification = await client.verifyToken();
      if (!verification.ok) {
        return reply.status(400).send({
          error: "invalid_token",
          missingScopes: verification.missingScopes,
        });
      }

      // Fetch accounts
      const accounts = await client.listAccounts();

      // Both /accounts and the /memberships fallback came back empty, so the
      // token genuinely cannot see an account and setup cannot continue.
      // Storing it would leave the operator on an empty dropdown with nothing
      // to explain it, which is how this failure was first reported.
      if (accounts.length === 0) {
        return reply.status(400).send({
          error: "no_accounts",
          missingScopes: ["User:Memberships:Read"],
          detail:
            "This token cannot see any Cloudflare account. Add the " +
            "User → Memberships → Read permission — it sits under User, not " +
            "Account or Zone. If it is already there, the token is probably " +
            "account-owned; create a user token from My Profile → API Tokens.",
        });
      }

      // Only store if verification succeeded
      const encryptedToken = encrypt(token, opts.secretKey);

      await db
        .insert(settings)
        .values({ key: "cloudflare.apiToken", value: encryptedToken })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: encryptedToken },
        });

      return { accounts };
    },
  );

  app.post(
    "/api/cloudflare/account",
    { preHandler: requirePermission({ tunnel: ["create"] }) },
    async (request, reply) => {
      const body = z
        .object({
          accountId: z.string().min(1),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }

      const { accountId } = body.data;

      const token = await getDecryptedToken(db, opts.secretKey);
      if (!token) {
        return reply.status(400).send({ error: "no_token_configured" });
      }

      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });

      const zones = await client.listZones(accountId);

      // Cloudflare answers this with an empty list when the account has no
      // identity providers, and with an authentication error when it has some
      // the token may not read. Those mean opposite things to the operator, so
      // do not let the second arrive as a 500 — or worse, get rounded down to
      // "you have none" and send someone to configure what they already have.
      let idps: Awaited<ReturnType<typeof client.listIdentityProviders>>;
      try {
        idps = await client.listIdentityProviders(accountId);
      } catch (error) {
        return reply.status(400).send({
          error: "idp_unreadable",
          missingScopes: ["Access: Identity Providers Read"],
          detail:
            "Could not read this account's identity providers. The token is " +
            "probably missing the Access: Identity Providers Read permission. " +
            `Cloudflare said: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // Store the account ID
      await db
        .insert(settings)
        .values({ key: "cloudflare.accountId", value: accountId })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: accountId },
        });

      return { zones, idps };
    },
  );

  app.post(
    "/api/cloudflare/setup",
    { preHandler: requirePermission({ tunnel: ["create"] }) },
    async (request, reply) => {
      const body = z
        .object({
          idpId: z.string().min(1),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }

      const { idpId } = body.data;

      // Get account ID
      const [accountRow] = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "cloudflare.accountId"));

      if (!accountRow) {
        return reply.status(400).send({ error: "no_account_configured" });
      }

      const accountId = accountRow.value;

      const token = await getDecryptedToken(db, opts.secretKey);
      if (!token) {
        return reply.status(400).send({ error: "no_token_configured" });
      }

      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });

      // Verify that the account has at least one identity provider
      const idps = await client.listIdentityProviders(accountId);
      if (idps.length === 0) {
        return reply.status(400).send({
          error: "no_identity_provider",
          detail:
            "This account has no identity providers configured. Visit the Cloudflare dashboard to set up authentication before creating a tunnel.",
        });
      }

      const result = await runSetup({
        db,
        client,
        accountId,
        idpId,
        secretKey: opts.secretKey,
        // Real dependencies. These were stubs — `async () => []` and a no-op
        // — from the day the module was written, so adoption could never see a
        // running cloudflared and deploy never put a file on disk, while setup
        // still reported a runtime. Nothing caught it because runtime.test.ts
        // injects its own fakes and no test drove this call site.
        runtimeDeps: {
          listContainers: () =>
            listContainers((opts.docker ?? dockerRunner).run),
          writeProject: (slug, files) =>
            writeProjectFiles(opts.projectsDir, slug, files),
        },
      });

      return result;
    },
  );

  app.get(
    "/api/exposures",
    { preHandler: requirePermission({ exposure: ["read"] }) },
    async () => {
      const rows = await db.select().from(exposures);

      const summaries: ExposureSummary[] = rows.map((row) => ({
        id: row.id,
        projectSlug: row.projectSlug,
        serviceName: null, // Derived from docker compose config when needed
        hostPort: row.hostPort,
        hostname: row.hostname,
        scheme: row.scheme as "http" | "https",
        noTlsVerify: row.noTlsVerify,
        label: row.label,
        enabled: row.enabled,
        accessEnabled: row.accessEnabled,
      }));

      return { exposures: summaries };
    },
  );

  app.post(
    "/api/exposures",
    { preHandler: requirePermission({ exposure: ["create"] }) },
    async (request, reply) => {
      const body = z
        .object({
          projectSlug: z.string().optional(),
          hostPort: z.number().int().min(1).max(65535),
          zoneId: z.string().min(1),
          hostname: z.string().min(1),
          scheme: z.enum(["http", "https"]).default("http"),
          noTlsVerify: z.boolean().default(false),
          label: z.string().optional(),
          enabled: z.boolean().default(true),
          accessEnabled: z.boolean().default(true),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }

      const data = body.data;

      // Get required settings
      const settingsRows = await db.select().from(settings);
      const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]));

      const accountId = settingsMap.get("cloudflare.accountId");
      const tunnelId = settingsMap.get("cloudflare.tunnelId");
      const policyAllowId = settingsMap.get("cloudflare.policyAllowId");
      const policyProbeId = settingsMap.get("cloudflare.policyProbeId");

      if (!accountId || !tunnelId) {
        return reply.status(400).send({ error: "tunnel_not_configured" });
      }

      const token = await getDecryptedToken(db, opts.secretKey);
      if (!token) {
        return reply.status(400).send({ error: "no_token_configured" });
      }

      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });

      // Commit the exposure first, then converge remote state
      const id = randomUUID();
      await db.insert(exposures).values({
        id,
        projectSlug: data.projectSlug ?? null,
        hostPort: data.hostPort,
        zoneId: data.zoneId,
        hostname: data.hostname,
        scheme: data.scheme,
        noTlsVerify: data.noTlsVerify,
        label: data.label ?? null,
        enabled: data.enabled,
        accessEnabled: data.accessEnabled,
        accessAppId: null,
      });

      // Reconcile to Cloudflare
      const result = await reconcileExposures(
        db,
        client,
        accountId,
        tunnelId,
        policyAllowId ?? null,
        policyProbeId ?? null,
      );

      if (!result.ok) {
        return reply.status(500).send({
          error: "reconcile_failed",
          conflict: result.conflict,
          detail:
            "Exposure created in database but remote sync failed. Run POST /api/exposures/reconcile to retry.",
        });
      }

      return reply.status(201).send({ id });
    },
  );

  app.patch(
    "/api/exposures/:id",
    { preHandler: requirePermission({ exposure: ["update"] }) },
    async (request, reply) => {
      const params = z
        .object({
          id: z.string(),
        })
        .safeParse(request.params);

      if (!params.success) {
        return reply.status(400).send({ error: "invalid_params" });
      }

      // Define allowed fields for PATCH
      const allowedFields = z.object({
        projectSlug: z.string().nullable().optional(),
        scheme: z.enum(["http", "https"]).optional(),
        noTlsVerify: z.boolean().optional(),
        label: z.string().nullable().optional(),
        enabled: z.boolean().optional(),
        accessEnabled: z.boolean().optional(),
      });

      const body = allowedFields.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }

      // Check for unknown keys
      const bodyKeys = Object.keys(request.body as object);
      const allowedKeys = Object.keys(allowedFields.shape);
      const unknownKeys = bodyKeys.filter((k) => !allowedKeys.includes(k));

      if (unknownKeys.length > 0) {
        return reply.status(400).send({
          error: "unknown_fields",
          fields: unknownKeys,
        });
      }

      const data = body.data;

      // Get required settings
      const settingsRows = await db.select().from(settings);
      const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]));

      const accountId = settingsMap.get("cloudflare.accountId");
      const tunnelId = settingsMap.get("cloudflare.tunnelId");

      if (!accountId || !tunnelId) {
        return reply.status(400).send({ error: "tunnel_not_configured" });
      }

      const token = await getDecryptedToken(db, opts.secretKey);
      if (!token) {
        return reply.status(400).send({ error: "no_token_configured" });
      }

      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });

      // Check if exposure exists first
      const [existing] = await db
        .select()
        .from(exposures)
        .where(eq(exposures.id, params.data.id));

      if (!existing) {
        return reply.status(404).send({ error: "not_found" });
      }

      // Update exposure, then reconcile
      await db
        .update(exposures)
        .set(data)
        .where(eq(exposures.id, params.data.id));

      const policyAllowId = settingsMap.get("cloudflare.policyAllowId");
      const policyProbeId = settingsMap.get("cloudflare.policyProbeId");

      const result = await reconcileExposures(
        db,
        client,
        accountId,
        tunnelId,
        policyAllowId ?? null,
        policyProbeId ?? null,
      );

      if (!result.ok) {
        return reply.status(500).send({
          error: "reconcile_failed",
          conflict: result.conflict,
          detail:
            "Exposure updated in database but remote sync failed. Run POST /api/exposures/reconcile to retry.",
        });
      }

      return { ok: true };
    },
  );

  app.delete(
    "/api/exposures/:id",
    { preHandler: requirePermission({ exposure: ["delete"] }) },
    async (request, reply) => {
      const params = z
        .object({
          id: z.string(),
        })
        .safeParse(request.params);

      if (!params.success) {
        return reply.status(400).send({ error: "invalid_params" });
      }

      // Get required settings
      const settingsRows = await db.select().from(settings);
      const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]));

      const accountId = settingsMap.get("cloudflare.accountId");
      const tunnelId = settingsMap.get("cloudflare.tunnelId");

      if (!accountId || !tunnelId) {
        return reply.status(400).send({ error: "tunnel_not_configured" });
      }

      const token = await getDecryptedToken(db, opts.secretKey);
      if (!token) {
        return reply.status(400).send({ error: "no_token_configured" });
      }

      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });

      // Get the exposure first
      const [existing] = await db
        .select()
        .from(exposures)
        .where(eq(exposures.id, params.data.id));

      if (!existing) {
        return reply.status(404).send({ error: "not_found" });
      }

      // Delete from SQLite first
      await db.delete(exposures).where(eq(exposures.id, params.data.id));

      // Clean up DNS and Access app
      await deleteDnsRecord(client, existing.zoneId, existing.hostname);
      if (existing.accessAppId) {
        await deleteApp(client, accountId, existing.accessAppId);
      }

      // Reconcile remaining exposures
      const policyAllowId = settingsMap.get("cloudflare.policyAllowId");
      const policyProbeId = settingsMap.get("cloudflare.policyProbeId");

      const result = await reconcileExposures(
        db,
        client,
        accountId,
        tunnelId,
        policyAllowId ?? null,
        policyProbeId ?? null,
      );

      if (!result.ok) {
        return reply.status(500).send({
          error: "reconcile_failed",
          conflict: result.conflict,
          detail:
            "Exposure deleted but remote sync failed. Run POST /api/exposures/reconcile to retry.",
        });
      }

      return { ok: true };
    },
  );

  app.post(
    "/api/exposures/reconcile",
    { preHandler: requirePermission({ exposure: ["update"] }) },
    async (_request, reply) => {
      // Get required settings
      const settingsRows = await db.select().from(settings);
      const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]));

      const accountId = settingsMap.get("cloudflare.accountId");
      const tunnelId = settingsMap.get("cloudflare.tunnelId");

      if (!accountId || !tunnelId) {
        return reply.status(400).send({ error: "tunnel_not_configured" });
      }

      const token = await getDecryptedToken(db, opts.secretKey);
      if (!token) {
        return reply.status(400).send({ error: "no_token_configured" });
      }

      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });

      const policyAllowId = settingsMap.get("cloudflare.policyAllowId");
      const policyProbeId = settingsMap.get("cloudflare.policyProbeId");

      const result = await reconcileExposures(
        db,
        client,
        accountId,
        tunnelId,
        policyAllowId ?? null,
        policyProbeId ?? null,
      );

      if (!result.ok) {
        return reply.status(409).send({ conflict: result.conflict });
      }

      return { ok: true };
    },
  );

  app.post(
    "/api/cloudflare/sync-users",
    { preHandler: requirePermission({ tunnel: ["create"] }) },
    async (_request, reply) => {
      // Get required settings
      const settingsRows = await db.select().from(settings);
      const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]));

      const accountId = settingsMap.get("cloudflare.accountId");
      const policyAllowId = settingsMap.get("cloudflare.policyAllowId");
      const idpId = settingsMap.get("cloudflare.idpId");

      if (!accountId || !policyAllowId || !idpId) {
        return reply.status(400).send({ error: "tunnel_not_configured" });
      }

      const token = await getDecryptedToken(db, opts.secretKey);
      if (!token) {
        return reply.status(400).send({ error: "no_token_configured" });
      }

      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });

      const result = await syncAllowPolicy(
        db,
        client,
        accountId,
        policyAllowId,
        idpId,
      );

      if (!result.synced) {
        return reply.status(409).send({ conflict: result.conflict });
      }

      return { ok: true };
    },
  );
};
