import type { TunnelRuntime } from "@shared/cloudflare.js";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { settings, user } from "../db/schema.js";
import {
  createAllowPolicy,
  createProbePolicy,
  createServiceToken,
} from "./access.js";
import type { CloudflareClient } from "./client.js";
import { deployTunnel, detectRuntime, type RuntimeDeps } from "./runtime.js";
import { createTunnel, getTunnelToken } from "./tunnel.js";

type SetupDeps = {
  db: Db;
  client: CloudflareClient;
  accountId: string;
  idpId: string;
  secretKey: Buffer;
  runtimeDeps: RuntimeDeps;
};

async function upsertSetting(
  db: Db,
  key: string,
  value: string,
): Promise<void> {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({
    target: settings.key,
    set: { value },
  });
}

export async function runSetup(
  deps: SetupDeps,
): Promise<{ tunnelId: string; runtime: TunnelRuntime }> {
  const { db, client, accountId, idpId, secretKey, runtimeDeps } = deps;

  // Check for existing tunnel
  const [existingTunnelRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.tunnelId"));

  let tunnelId: string;
  if (existingTunnelRow) {
    tunnelId = existingTunnelRow.value;
  } else {
    // Create tunnel and store immediately
    const tunnel = await createTunnel(client, accountId, "homestead");
    tunnelId = tunnel.id;
    await upsertSetting(db, "cloudflare.tunnelId", tunnelId);
  }

  // Get tunnel run token if not already stored
  const [existingRunTokenRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.runToken"));

  if (!existingRunTokenRow) {
    const runToken = await getTunnelToken(client, accountId, tunnelId);
    const encryptedRunToken = encrypt(runToken, secretKey);
    await upsertSetting(db, "cloudflare.runToken", encryptedRunToken);
  }

  // Store idpId if not already stored
  const [existingIdpRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.idpId"));

  if (!existingIdpRow) {
    await upsertSetting(db, "cloudflare.idpId", idpId);
  }

  // Create service token if not already stored
  const [existingServiceTokenRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.serviceTokenSecret"));

  let serviceTokenId: string;
  if (existingServiceTokenRow) {
    // Service token exists, fetch its ID
    const [serviceTokenIdRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.serviceTokenId"));
    if (!serviceTokenIdRow) {
      throw new Error("Service token secret exists but ID is missing");
    }
    serviceTokenId = serviceTokenIdRow.value;
  } else {
    const serviceToken = await createServiceToken(
      client,
      accountId,
      "Homestead probe",
    );
    // Store the secret immediately after creation (it's returned only once)
    const encryptedServiceSecret = encrypt(
      serviceToken.clientSecret,
      secretKey,
    );
    await upsertSetting(
      db,
      "cloudflare.serviceTokenSecret",
      encryptedServiceSecret,
    );
    // Store other service token fields
    await upsertSetting(db, "cloudflare.serviceTokenId", serviceToken.id);
    await upsertSetting(
      db,
      "cloudflare.serviceTokenClientId",
      serviceToken.clientId,
    );
    serviceTokenId = serviceToken.id;
  }

  // Create allow policy if not already stored
  // Contract: key name is cloudflare.policyAllowId (adjective follows noun)
  const [existingAllowPolicyRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.policyAllowId"));

  if (!existingAllowPolicyRow) {
    const users = await db.select().from(user);
    const emails = users.map((u) => u.email);
    const allowPolicy = await createAllowPolicy(
      client,
      accountId,
      idpId,
      emails,
    );
    await upsertSetting(db, "cloudflare.policyAllowId", allowPolicy.id);
  }

  // Create probe policy if not already stored
  // Contract: key name is cloudflare.policyProbeId (adjective follows noun)
  const [existingProbePolicyRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.policyProbeId"));

  if (!existingProbePolicyRow) {
    const probePolicy = await createProbePolicy(
      client,
      accountId,
      serviceTokenId,
    );
    await upsertSetting(db, "cloudflare.policyProbeId", probePolicy.id);
  }

  // Deploy runtime - this is idempotent
  const [runTokenRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.runToken"));
  if (!runTokenRow) {
    throw new Error("Run token missing after setup");
  }
  const decryptedRunToken = decrypt(runTokenRow.value, secretKey);

  // Adopt before deploying. detectRuntime was written, exported and tested and
  // then called from nowhere, so setup always wrote its own stack — which is
  // how two cloudflared daemons end up competing for one tunnel on a box that
  // already had one.
  const detected = await detectRuntime(runtimeDeps);
  const runtime =
    detected.kind === "none"
      ? await deployTunnel(runtimeDeps, decryptedRunToken)
      : detected;

  return { tunnelId, runtime };
}
