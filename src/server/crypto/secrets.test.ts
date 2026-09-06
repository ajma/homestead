import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt, ensureSecretKey } from "./secrets.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hs-secrets-"));
});

describe("ensureSecretKey", () => {
  it("generates a 32-byte key and persists it with 0600", async () => {
    const key = await ensureSecretKey(dir, undefined);
    expect(key).toHaveLength(32);
    const s = await stat(join(dir, "secret.key"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("returns the same key on a second call", async () => {
    const a = await ensureSecretKey(dir, undefined);
    const b = await ensureSecretKey(dir, undefined);
    expect(b.equals(a)).toBe(true);
  });

  it("prefers an env-supplied key and does not write a file", async () => {
    const provided = randomBytes(32).toString("hex");
    const key = await ensureSecretKey(dir, provided);
    expect(key.toString("hex")).toBe(provided);
    await expect(readFile(join(dir, "secret.key"))).rejects.toThrow();
  });
});

describe("encrypt/decrypt", () => {
  it("round-trips a value", async () => {
    const key = await ensureSecretKey(dir, undefined);
    expect(decrypt(encrypt("cf-api-token", key), key)).toBe("cf-api-token");
  });

  it("produces a different ciphertext each time", async () => {
    const key = await ensureSecretKey(dir, undefined);
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("rejects a tampered payload", async () => {
    const key = await ensureSecretKey(dir, undefined);
    const parts = encrypt("secret", key).split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), key)).toThrow();
  });

  it("rejects the wrong key", async () => {
    const key = await ensureSecretKey(dir, undefined);
    const payload = encrypt("secret", key);
    expect(() => decrypt(payload, randomBytes(32))).toThrow();
  });
});
