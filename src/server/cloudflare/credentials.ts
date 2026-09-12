import type { CloudflareStatus } from "@shared/cloudflare.js";
import { eq } from "drizzle-orm";
import type { SecretStore } from "../crypto/secrets.js";
import type { Db, Tx } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { settings } from "../db/schema.js";

/** The token lives in `secrets` (encrypted); the account id and last-verified time live
 * in `settings` (plaintext, neither is sensitive on its own). Both tables are flat
 * key→value stores that already exist — no migration for this phase.
 *
 * Exported for `credentials.test.ts` alone, so a test that proves `save()` rolls back
 * atomically can check the raw `secrets` row directly rather than through `get()`/
 * `status()`, both of which already read `null` the instant either half is missing. */
export const TOKEN_KEY = "cloudflare.api_token";
const ACCOUNT_ID_KEY = "cloudflare.account_id";
const VERIFIED_AT_KEY = "cloudflare.verified_at";

export type CloudflareCredentials = { token: string; accountId: string };

/**
 * Reads and writes the stored Cloudflare token and account id.
 *
 * Deliberately dumb: this module does no verification and knows nothing about the
 * Cloudflare wire format. `save` is called only after a caller (the route) has already
 * proven the token works by listing zones — see `routes/cloudflare.ts` for why that is
 * the verification strategy and what it does and does not prove.
 */
export class CloudflareCredentialStore {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
  ) {}

  /** The full credentials, or `null` if either half is missing. Used at request time to
   * build a client — never cached, so a rotated token takes effect on the next call. */
  async get(): Promise<CloudflareCredentials | null> {
    const [accountId, token] = await Promise.all([
      this.readSetting(ACCOUNT_ID_KEY),
      this.secrets.get(TOKEN_KEY),
    ]);
    if (accountId === null || token === null) return null;
    return { token, accountId };
  }

  /**
   * The token itself never appears here — only its last four characters, enough to tell
   * two tokens apart and useless if this response leaked.
   */
  async status(): Promise<CloudflareStatus> {
    const creds = await this.get();
    if (!creds) return { configured: false };
    const verifiedAtRaw = await this.readSetting(VERIFIED_AT_KEY);
    return {
      configured: true,
      accountId: creds.accountId,
      tokenHint: creds.token.slice(-4),
      verifiedAt: verifiedAtRaw === null ? null : Number(verifiedAtRaw),
    };
  }

  /**
   * Called by the route only after `listZones()` has already succeeded against these
   * exact credentials — see `routes/cloudflare.ts`.
   *
   * All three writes — the encrypted token, the account id, the verified-at timestamp —
   * share one transaction. Un-transacted, a failure on the second or third write would
   * leave the token committed in `secrets` with no account id to pair it with:
   * `get()`/`status()` both require both halves, so the store would report
   * `configured: false` while an encrypted token sat there regardless — orphaned, and
   * with no button in the not-configured view to remove it (`CloudflarePanel`'s "Remove
   * credentials" button only renders once `configured` is true). `retryOnBusy` wraps it
   * for the same reason `persistResult` and app creation do: the scheduler can open its
   * own transaction on this one shared connection at the same instant (`db/retry.ts`).
   */
  async save(creds: CloudflareCredentials, verifiedAt: number): Promise<void> {
    await retryOnBusy(() =>
      this.db.transaction(async (tx) => {
        await this.secrets.withDb(tx).set(TOKEN_KEY, creds.token);
        await this.writeSetting(ACCOUNT_ID_KEY, creds.accountId, tx);
        await this.writeSetting(VERIFIED_AT_KEY, String(verifiedAt), tx);
      }),
    );
  }

  async clear(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
    await this.deleteSetting(ACCOUNT_ID_KEY);
    await this.deleteSetting(VERIFIED_AT_KEY);
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
