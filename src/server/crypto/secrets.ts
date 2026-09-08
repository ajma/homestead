import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

function parseKey(raw: string): Buffer {
  const hex = /^[0-9a-fA-F]+$/.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : null;
  const key =
    hex?.length === KEY_BYTES ? hex : Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `secret key must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

export async function ensureSecretKey(
  dataDir: string,
  envKey: string | undefined,
): Promise<Buffer> {
  if (envKey) return parseKey(envKey);

  const path = join(dataDir, "secret.key");
  try {
    return parseKey(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const key = randomBytes(KEY_BYTES);
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, key.toString("hex"), { mode: 0o600, flag: "wx" });
  return key;
}

export function encrypt(plaintext: string, key: Buffer): string {
  // Callers reach here holding something they believe is a secret. When that
  // belief is wrong the cipher's own error names neither the value nor the
  // caller — a real failure surfaced as "data argument must be of type string"
  // with nothing to say which secret was missing.
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new TypeError(
      `encrypt() needs a non-empty string, received ${plaintext === "" ? "an empty string" : typeof plaintext}`,
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== VERSION || !iv || !tag || !ct) {
    throw new Error("malformed encrypted payload");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
