import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { secrets } from "../db/schema.js";

const ALGORITHM = "aes-256-gcm";

export type EncryptedParts = { ciphertext: string; iv: string; tag: string };

export function encrypt(key: Buffer, plaintext: string): EncryptedParts {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt(key: Buffer, parts: EncryptedParts): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parts.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parts.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  async set(name: string, value: string): Promise<void> {
    const parts = encrypt(this.key, value);
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
    return row ? decrypt(this.key, row) : null;
  }

  async delete(name: string): Promise<void> {
    await this.db.delete(secrets).where(eq(secrets.key, name));
  }
}
