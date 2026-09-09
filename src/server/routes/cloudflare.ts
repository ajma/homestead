import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ExposureSummary } from "../../shared/cloudflare.js";
import { syncAppMonitors } from "../apps/sync.js";
import { requirePermission } from "../auth/guard.js";
import { deleteApp } from "../cloudflare/access.js";
import {
  type CloudflareClient,
  createCloudflareClient,
} from "../cloudflare/client.js";
import { detectRuntime } from "../cloudflare/runtime.js";
import { runSetup } from "../cloudflare/setup.js";
import { reconcileExposures } from "../cloudflare/sync.js";
import { syncAllowPolicy } from "../cloudflare/sync-users.js";
import { deleteDnsRecord } from "../cloudflare/tunnel.js";
import { resolveZoneId } from "../cloudflare/zone.js";
import { decrypt, encrypt } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { exposures, settings } from "../db/schema.js";
import { argsFor, composeConfig } from "../docker/compose.js";
import { listContainers } from "../docker/engine.js";
import { type DockerRunner, dockerRunner } from "../docker/run.js";
import { scanProjects, writeProjectFiles } from "../projects/store.js";

type Opts = {
  db: Db;
  secretKey: Buffer;
  cloudflare?: (opts: { token: string }) => CloudflareClient;
  /** Where the cloudflared stack is written, as an ordinary project. */
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
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

  /**
   * Re-derives app monitors after an exposure changes.
   *
   * An app's `dns` and `reachability` monitors exist only when its port has a
   * hostname, so creating an exposure should add them and deleting one should
   * take them away. Nothing told the reconciler that, and it runs on a ten
   * minute timer: a newly exposed app sat without its public checks until the
   * timer came round. Project create, edit and delete already resync for the
   * same reason.
   *
   * Fire and forget, like those: a sync failure must not fail a request whose
   * own work is already committed.
   */
  const resyncAppMonitors = (request: { log: FastifyBaseLogger }) =>
    syncAppMonitors(opts.db, {
      listProjects: async () => {
        const entries = await scanProjects(opts.projectsDir);
        return entries.map((e) => e.slug);
      },
      composeConfig: async (slug: string) =>
        composeConfig(
          {
            projectsDir: opts.projectsDir,
            projectsHostDir: opts.projectsHostDir,
            dataDir: opts.dataDir,
            slug,
          },
          (opts.docker ?? dockerRunner).run,
        ),
      hostnameFor: async (slug: string, hostPort: number) => {
        const [exposure] = await opts.db
          .select({ hostname: exposures.hostname })
          .from(exposures)
          .where(
            and(
              eq(exposures.projectSlug, slug),
              eq(exposures.hostPort, hostPort),
            ),
          );
        return exposure?.hostname ?? null;
      },
    }).catch((err) => {
      request.log.error(
        { err },
        "Failed to sync app monitors after an exposure change",
      );
    });

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

      // Real detection. This was hardcoded to none, so the screen reported
      // nothing running while a healthy connector was attached — and, worse,
      // reported "Setup complete" over a tunnel with no connector at all.
      const runtime = await detectRuntime({
        listContainers: () => listContainers((opts.docker ?? dockerRunner).run),
      });

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

  app.get(
    "/api/cloudflare/zones",
    { preHandler: requirePermission({ tunnel: ["read"] }) },
    async (_request, reply) => {
      // Feeds the hostname picker: an exposure's zone is derived from its
      // hostname, so the form offers the zones rather than asking for a
      // fully-qualified name and hoping it lands in one.
      const [accountRow] = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "cloudflare.accountId"));
      const token = await getDecryptedToken(db, opts.secretKey);

      if (!accountRow || !token) {
        return reply.status(400).send({ error: "tunnel_not_configured" });
      }

      const clientFactory = opts.cloudflare ?? createCloudflareClient;
      const client = clientFactory({ token });
      return { zones: await client.listZones(accountRow.value) };
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
          startProject: async (slug) => {
            const args = await argsFor(
              {
                projectsDir: opts.projectsDir,
                projectsHostDir: opts.projectsHostDir,
                dataDir: opts.dataDir,
                slug,
              },
              null,
              ["up", "-d"],
            );
            await (opts.docker ?? dockerRunner).run(args);
          },
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
          // nullable, not just optional: the form sends null for an empty
          // field, and `.optional()` rejects it.
          projectSlug: z.string().nullish(),
          hostPort: z.number().int().min(1).max(65535),
          // Derived from the hostname below. There is no zone field in the
          // form, and requiring one here failed every submission.
          zoneId: z.string().min(1).optional(),
          hostname: z.string().min(1),
          scheme: z.enum(["http", "https"]).default("http"),
          noTlsVerify: z.boolean().default(false),
          label: z.string().nullish(),
          enabled: z.boolean().default(true),
          accessEnabled: z.boolean().default(true),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "invalid_body",
          // A bare refusal tells the operator nothing about which field is
          // wrong, and this endpoint refused every submission for a week.
          detail: body.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        });
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

      // The hostname already determines the zone, so derive it rather than
      // asking for it twice.
      let zoneId = data.zoneId;
      if (!zoneId) {
        const zones = await client.listZones(accountId);
        const resolved = resolveZoneId(data.hostname, zones);
        if (!resolved) {
          return reply.status(400).send({
            error: "unknown_zone",
            detail:
              `No Cloudflare zone in this account covers ${data.hostname}. ` +
              `Available: ${zones.map((z) => z.name).join(", ") || "none"}.`,
          });
        }
        zoneId = resolved;
      }

      // Commit the exposure first, then converge remote state
      const id = randomUUID();
      await db.insert(exposures).values({
        id,
        projectSlug: data.projectSlug ?? null,
        hostPort: data.hostPort,
        zoneId,
        hostname: data.hostname,
        scheme: data.scheme,
        noTlsVerify: data.noTlsVerify,
        label: data.label ?? null,
        enabled: data.enabled,
        accessEnabled: data.accessEnabled,
        accessAppId: null,
      });
      await resyncAppMonitors(request);

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
        // 409, not 500: this is a conflict the operator can resolve, and a
        // 5xx body is masked to {"error":"internal_error"} — which is how the
        // one useful fact, the record standing in the way, went missing.
        return reply.status(409).send({
          error: "reconcile_conflict",
          conflict: result.conflict,
          detail: `Exposure saved, but Cloudflare was not updated: ${result.conflict}. Resolve it and retry with Reconcile.`,
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
      await resyncAppMonitors(request);

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
        return reply.status(409).send({
          error: "reconcile_conflict",
          conflict: result.conflict,
          detail: `Exposure saved, but Cloudflare was not updated: ${result.conflict}. Resolve it and retry with Reconcile.`,
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
      await resyncAppMonitors(request);

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
        return reply.status(409).send({
          error: "reconcile_conflict",
          conflict: result.conflict,
          detail: `Exposure deleted, but Cloudflare was not updated: ${result.conflict}. Resolve it and retry with Reconcile.`,
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
        return reply.status(409).send({
          error: "reconcile_conflict",
          conflict: result.conflict,
          detail: `Cloudflare was not fully updated: ${result.conflict}`,
        });
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
        return reply.status(409).send({
          error: "reconcile_conflict",
          conflict: result.conflict,
          detail: `Cloudflare was not fully updated: ${result.conflict}`,
        });
      }

      return { ok: true };
    },
  );
};
