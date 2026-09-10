import { decrypt, encrypt, SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { describe, expect, it } from "vitest";

const key = Buffer.alloc(32, 3);

describe("encrypt / decrypt", () => {
  it("round-trips a value", () => {
    expect(decrypt(key, encrypt(key, "cf-api-token"))).toBe("cf-api-token");
  });

  it("produces a different ciphertext each time", () => {
    expect(encrypt(key, "same").ciphertext).not.toBe(encrypt(key, "same").ciphertext);
  });

  it("rejects a tampered ciphertext", () => {
    const parts = encrypt(key, "secret");
    const bytes = Buffer.from(parts.ciphertext, "base64");
    const firstByte = bytes[0];
    if (firstByte !== undefined) {
      bytes[0] = firstByte ^ 0xff;
    }
    expect(() => decrypt(key, { ...parts, ciphertext: bytes.toString("base64") })).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => decrypt(Buffer.alloc(32, 9), encrypt(key, "secret"))).toThrow();
  });
});

describe("SecretStore", () => {
  it("stores, reads back, overwrites, and deletes", async () => {
    const { db } = await createDb(":memory:");
    await runMigrations(db);
    const store = new SecretStore(db, key);

    expect(await store.get("cf_api_token")).toBeNull();
    await store.set("cf_api_token", "token-one");
    expect(await store.get("cf_api_token")).toBe("token-one");
    await store.set("cf_api_token", "token-two");
    expect(await store.get("cf_api_token")).toBe("token-two");
    await store.delete("cf_api_token");
    expect(await store.get("cf_api_token")).toBeNull();
  });
});
