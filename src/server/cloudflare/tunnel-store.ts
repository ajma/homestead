import { eq } from "drizzle-orm";
import type { SecretStore } from "../crypto/secrets.js";
import type { Db, Tx } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { settings } from "../db/schema.js";

/**
 * One remotely-managed tunnel (spec §6) — there is exactly one record, never a table of
 * them, which is why these are singleton keys rather than a row keyed by tunnel id.
 *
 * The token is deliberately NOT a field here: it is a credential (see `credentials.ts`'s
 * `CloudflareCredentials.token` for the same treatment) and lives only in `secrets`,
 * encrypted, passed to `set()` alongside the record rather than carried on it — a
 * `TunnelRecord` can safely appear in a log line or be handed to a template; this cannot.
 */
export type TunnelRecord = {
  tunnelId: string;
  name: string;
  appId: string | null;
  createdAt: number;
};

const TUNNEL_ID_KEY = "cloudflare.tunnel.id";
const TUNNEL_NAME_KEY = "cloudflare.tunnel.name";
const TUNNEL_APP_ID_KEY = "cloudflare.tunnel.app_id";
const TUNNEL_CREATED_AT_KEY = "cloudflare.tunnel.created_at";

/** Exported for `tunnel-store.test.ts` alone, the same reason `credentials.ts` exports
 * `TOKEN_KEY` — so a test proving `set()`/`clear()` touch the raw `secrets` row can check
 * it directly rather than only through `get()`, which already reads `null` the instant
 * the token is missing. */
export const TUNNEL_TOKEN_KEY = "cloudflare.tunnel_token";

/**
 * Reads and writes the one tunnel Homestead manages, and its token.
 *
 * Both tables this uses — `settings` (the record) and `secrets` (the token) — are flat
 * key-value stores that already exist; no migration for this phase. That split mirrors
 * `CloudflareCredentialStore` exactly, including the failure mode it guards against: a
 * tunnel id written with no token paired to it is not a usable tunnel (nothing could ever
 * mint an ingress into it), so `get()` reads that state as absent rather than surfacing a
 * half-formed record a caller would have to specially handle. A caller that sees `null`
 * where it expected a tunnel does the same thing whether the cause is "never provisioned"
 * or "provisioning was interrupted after the first write" — retry provisioning — so
 * collapsing both into one state costs nothing and removes a third case every caller would
 * otherwise need to consider.
 */
export class TunnelStore {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
  ) {}

  async get(): Promise<TunnelRecord | null> {
    const [tunnelId, name, appId, createdAtRaw, token] = await Promise.all([
      this.readSetting(TUNNEL_ID_KEY),
      this.readSetting(TUNNEL_NAME_KEY),
      this.readSetting(TUNNEL_APP_ID_KEY),
      this.readSetting(TUNNEL_CREATED_AT_KEY),
      this.secrets.get(TUNNEL_TOKEN_KEY),
    ]);
    // `appId` is legitimately absent (null) for a tunnel not yet linked to a scaffolded
    // app — that is a normal state, not a partial write, so it is excluded from this
    // check. `tunnelId`, `name`, `createdAtRaw` and `token` are not: any one of them
    // missing while the others are present is exactly the "tunnel id with no token" (or
    // vice versa) case the brief calls out, and it reads as absent here rather than as a
    // record with a hole in it. An empty-string token is treated the same as a missing
    // one for the same reason `CloudflareClient.tunnelToken` never resolves with "" —
    // see `client.ts`.
    if (tunnelId === null || name === null || createdAtRaw === null || !token) {
      return null;
    }
    return { tunnelId, name, appId, createdAt: Number(createdAtRaw) };
  }

  /**
   * `token` is a separate parameter rather than a field on `TunnelRecord` — the record is
   * safe to pass around and log, the token is not (see the type's doc comment). All five
   * writes (four settings plus the encrypted secret) share one transaction for the same
   * reason `CloudflareCredentialStore.save` does: un-transacted, a failure partway through
   * would leave exactly the half-written state `get()` above has to treat as absent,
   * silently discarding whichever half did commit. `retryOnBusy` wraps it because the
   * scheduler can open its own transaction on this one shared connection at the same
   * instant (`db/retry.ts`).
   */
  async set(record: TunnelRecord, token: string): Promise<void> {
    await retryOnBusy(() =>
      this.db.transaction(async (tx) => {
        await this.secrets.withDb(tx).set(TUNNEL_TOKEN_KEY, token);
        await this.writeSetting(TUNNEL_ID_KEY, record.tunnelId, tx);
        await this.writeSetting(TUNNEL_NAME_KEY, record.name, tx);
        if (record.appId === null) {
          await tx.delete(settings).where(eq(settings.key, TUNNEL_APP_ID_KEY));
        } else {
          await this.writeSetting(TUNNEL_APP_ID_KEY, record.appId, tx);
        }
        await this.writeSetting(TUNNEL_CREATED_AT_KEY, String(record.createdAt), tx);
      }),
    );
  }

  /** Removes the record and the token together. Not wrapped in a transaction the way
   * `set()` is: unlike a partial write, a partial clear cannot leave a record that reads
   * back as usable — `get()` already treats any one of these five pieces as absent as the
   * whole record being absent, so a clear that only gets partway still gets `get()` to
   * `null`, which is the outcome `clear()` promises. */
  async clear(): Promise<void> {
    await this.secrets.delete(TUNNEL_TOKEN_KEY);
    await this.deleteSetting(TUNNEL_ID_KEY);
    await this.deleteSetting(TUNNEL_NAME_KEY);
    await this.deleteSetting(TUNNEL_APP_ID_KEY);
    await this.deleteSetting(TUNNEL_CREATED_AT_KEY);
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
