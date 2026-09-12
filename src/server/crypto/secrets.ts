import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { secrets } from "../db/schema.js";

const ALGORITHM = "aes-256-gcm";

export type EncryptedParts = { ciphertext: string; iv: string; tag: string };

/** `aad` binds the ciphertext to the secret's name. See the note above. */
export function encrypt(key: Buffer, plaintext: string, aad: string): EncryptedParts {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt(key: Buffer, parts: EncryptedParts, aad: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parts.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(parts.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export class SecretStore {
  constructor(
    private readonly db: Db | Tx,
    private readonly key: Buffer,
  ) {}

  /** The same store, bound to a different handle — a transaction, most often — while
   * reusing this store's already-derived key. Lets a caller fold a secret write into the
   * same transaction as other writes, the way `CloudflareCredentialStore.save` does, so a
   * later write's failure rolls the secret back too instead of orphaning it. */
  withDb(db: Db | Tx): SecretStore {
    return new SecretStore(db, this.key);
  }

  async set(name: string, value: string): Promise<void> {
    const parts = encrypt(this.key, value, name);
    await this.db
      .insert(secrets)
      .values({
        key: name,
        ...parts,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: secrets.key,
        set: { ...parts, updatedAt: Math.floor(Date.now() / 1000) },
      });
  }

  async get(name: string): Promise<string | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.key, name));
    // AAD is the *queried* name, never row.key — see the note above.
    return row ? decrypt(this.key, row, name) : null;
  }

  async delete(name: string): Promise<void> {
    await this.db.delete(secrets).where(eq(secrets.key, name));
  }
}
