import { eq } from "drizzle-orm";
import type { SecretStore } from "../crypto/secrets.js";
import type { Db, Tx } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { settings } from "../db/schema.js";
import type { CloudflareClient } from "./client.js";

/**
 * §6: "Homestead creates a single `Homestead Monitor` service token and a single
 * **reusable** `non_identity` policy including it... One token and one policy for N
 * apps, so rotation is a single operation." Fixed names, not user-chosen — there is
 * exactly one of each, the same reasoning `CLOUDFLARED_TUNNEL_NAME` in
 * `provision-tunnel.ts` is fixed rather than derived from anything a caller passes in.
 */
export const MONITOR_TOKEN_NAME = "Homestead Monitor";
export const MONITOR_POLICY_NAME = "Homestead Monitor";

/**
 * What Homestead records locally about the one shared monitor token and policy.
 * `clientId` is not secret (it identifies the token, the way a username does — Cloudflare
 * sends it back on every rotation and it is safe to log). `clientSecret` never appears
 * on this type; see `MonitorAccessStore` for where it actually lives.
 */
export type MonitorAccess = {
  tokenId: string;
  clientId: string;
  policyId: string;
  /** Epoch ms, or `null` if Cloudflare returned no expiry. §6: tokens come back with
   * `duration: "8760h"` and a concrete `expires_at` — persisted here so a later phase
   * (2F) has something to warn from before every external probe starts failing at once. */
  expiresAt: number | null;
};

const TOKEN_ID_KEY = "cloudflare.monitor.token_id";
const CLIENT_ID_KEY = "cloudflare.monitor.client_id";
const POLICY_ID_KEY = "cloudflare.monitor.policy_id";
const EXPIRES_AT_KEY = "cloudflare.monitor.expires_at";

/** Exported for `monitor-access.test.ts` alone, the same reason `TunnelStore` exports
 * `TUNNEL_TOKEN_KEY` — so a test proving `set()`/`clear()` touch the raw `secrets` row,
 * and that the secret is never surfaced through `get()`, can check it directly. */
export const MONITOR_CLIENT_SECRET_KEY = "cloudflare.monitor_client_secret";

/**
 * Reads and writes the one service token and reusable policy every exposed app shares.
 *
 * Same split as `TunnelStore`/`CloudflareCredentialStore`: the non-secret fields live in
 * `settings`, the secret lives encrypted in `secrets`, both flat key-value tables that
 * already exist — no migration for this phase. `get()` never returns the secret — see
 * `MonitorAccess`'s doc comment — so a caller cannot accidentally leak it into a log line
 * or a response body just by round-tripping a status through this store.
 */
export class MonitorAccessStore {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
  ) {}

  /** `null` if any piece is missing — the same "no half-formed record" treatment
   * `TunnelStore.get()` gives its own five pieces. The secret is deliberately not part of
   * this check: whether the secret itself is present is `set()`'s problem (it is written
   * in the same transaction as everything else, so it cannot be the ONLY thing missing),
   * and `get()`'s contract is that it never reads the secret at all. */
  async get(): Promise<MonitorAccess | null> {
    const [tokenId, clientId, policyId, expiresAtRaw] = await Promise.all([
      this.readSetting(TOKEN_ID_KEY),
      this.readSetting(CLIENT_ID_KEY),
      this.readSetting(POLICY_ID_KEY),
      this.readSetting(EXPIRES_AT_KEY),
    ]);
    if (tokenId === null || clientId === null || policyId === null) return null;
    return {
      tokenId,
      clientId,
      policyId,
      expiresAt: expiresAtRaw === null ? null : Number(expiresAtRaw),
    };
  }

  /**
   * All four settings plus the encrypted secret share one transaction, for the same
   * "no half-written state" reason `TunnelStore.set()` and `CloudflareCredentialStore.save()`
   * do. `clientSecret` is a separate parameter rather than a field on `MonitorAccess` —
   * this is the ONE place in this module that ever sees the plaintext secret in memory,
   * and it goes straight into the transaction, never onto anything this method returns.
   */
  async set(value: MonitorAccess, clientSecret: string): Promise<void> {
    await retryOnBusy(() =>
      this.db.transaction(async (tx) => {
        await this.secrets.withDb(tx).set(MONITOR_CLIENT_SECRET_KEY, clientSecret);
        await this.writeSetting(TOKEN_ID_KEY, value.tokenId, tx);
        await this.writeSetting(CLIENT_ID_KEY, value.clientId, tx);
        await this.writeSetting(POLICY_ID_KEY, value.policyId, tx);
        if (value.expiresAt === null) {
          await tx.delete(settings).where(eq(settings.key, EXPIRES_AT_KEY));
        } else {
          await this.writeSetting(EXPIRES_AT_KEY, String(value.expiresAt), tx);
        }
      }),
    );
  }

  /**
   * The secret, alongside the client id — unlike `get()`, which exists for status
   * display and deliberately never reads it (see that method's doc comment). This is
   * for the one caller that actually has to authenticate as the monitor: the
   * `http_external` probe runner (2E), which needs a fresh read on every run so a
   * rotation (`rotateMonitorSecret`) takes effect on the very next probe rather than
   * whenever the process that captured a stale value happens to restart.
   *
   * `null` if either half is missing — a client id with no secret, or a secret with
   * no record, is not usable credentials either way.
   */
  async getCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
    const access = await this.get();
    if (!access) return null;
    const clientSecret = await this.secrets.get(MONITOR_CLIENT_SECRET_KEY);
    if (clientSecret === null) return null;
    return { clientId: access.clientId, clientSecret };
  }

  /** Not transactional, the same reasoning as `TunnelStore.clear()`: a partial clear
   * still gets `get()` to `null` (any one of the three required settings missing is
   * already "absent"), which is the outcome this method promises. */
  async clear(): Promise<void> {
    await this.secrets.delete(MONITOR_CLIENT_SECRET_KEY);
    await this.deleteSetting(TOKEN_ID_KEY);
    await this.deleteSetting(CLIENT_ID_KEY);
    await this.deleteSetting(POLICY_ID_KEY);
    await this.deleteSetting(EXPIRES_AT_KEY);
  }

  private async readSetting(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key));
    return row?.value ?? null;
  }

  private async writeSetting(key: string, value: string, db: Db | Tx = this.db): Promise<void> {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: Math.floor(Date.now() / 1000) },
      });
  }

  private async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}

/**
 * Creates the one shared service token and reusable policy on first call; every call
 * after that is a no-op that returns the already-recorded `MonitorAccess` — §6 requires
 * exactly one token and one policy for every app, so a second creation is not "safe to
 * repeat", it is a bug: a second live token nobody references, silently billed and
 * silently rotatable-out-of-sync with the one every app actually uses.
 *
 * If policy creation fails after the token was created, the token is deleted rather than
 * kept and recorded: `deleteServiceToken` exists on the client for exactly this (see its
 * own doc comment in `client.ts`), and the same "compensate inline, don't leave an
 * orphan for nobody to clean up" idiom `provision-tunnel.ts`'s `register-app` step and
 * `write-files` step already use elsewhere in this codebase. The alternative — recording
 * the orphan and leaving it for a human — was considered and rejected: it would need a
 * new place to record it (nothing in `MonitorAccessStore`'s shape has room for a token
 * with no policy) and a new UI affordance to surface it, for a case this compensation
 * removes outright. The token-deletion call itself is best-effort: if IT also fails, the
 * original policy-creation error is what the caller needs to see, not a secondary
 * cleanup failure masking it (the same trade-off `write-files`'s undo makes).
 *
 * Deliberately NOT compensated: `store.set` failing after both the token and the policy
 * were created successfully in Cloudflare. That failure is a local database write, not a
 * network call to a third party, and the brief's compensation requirement is scoped to
 * "policy creation fails after the token is created" — extending it further would need a
 * `deleteAccessPolicy` method this batch does not have and the plan does not ask for.
 */
export async function ensureMonitorAccess(deps: {
  store: MonitorAccessStore;
  client: CloudflareClient;
}): Promise<MonitorAccess> {
  const existing = await deps.store.get();
  if (existing) return existing;

  const token = await deps.client.createServiceToken(MONITOR_TOKEN_NAME);

  let policy: { id: string };
  try {
    policy = await deps.client.createMonitorPolicy(MONITOR_POLICY_NAME, token.id);
  } catch (error) {
    await deps.client.deleteServiceToken(token.id).catch(() => {
      // Best effort — see the doc comment above.
    });
    throw error;
  }

  const record: MonitorAccess = {
    tokenId: token.id,
    clientId: token.clientId,
    policyId: policy.id,
    expiresAt: token.expiresAt,
  };
  await deps.store.set(record, token.clientSecret);
  return record;
}

/**
 * Replaces the secret on the existing token and re-persists it — the token id and the
 * policy id never change, which is the whole point (§6: N apps keep pointing at one
 * policy through one token id; only the secret every probe authenticates with rotates).
 */
export async function rotateMonitorSecret(deps: {
  store: MonitorAccessStore;
  client: CloudflareClient;
}): Promise<MonitorAccess> {
  const existing = await deps.store.get();
  if (!existing) {
    throw new Error("cannot rotate the monitor service token before it has been created");
  }

  const rotated = await deps.client.rotateServiceToken(existing.tokenId);
  const record: MonitorAccess = {
    tokenId: existing.tokenId,
    clientId: rotated.clientId,
    policyId: existing.policyId,
    expiresAt: rotated.expiresAt,
  };
  await deps.store.set(record, rotated.clientSecret);
  return record;
}
