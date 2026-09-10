import { decrypt, encrypt, SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { secrets } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const key = Buffer.alloc(32, 3);

describe("encrypt / decrypt", () => {
  it("round-trips a value", () => {
    expect(decrypt(key, encrypt(key, "cf-api-token", "cf-api-token"), "cf-api-token")).toBe(
      "cf-api-token",
    );
  });

  it("produces a different ciphertext each time", () => {
    expect(encrypt(key, "same", "aad").ciphertext).not.toBe(encrypt(key, "same", "aad").ciphertext);
  });

  it("rejects a tampered ciphertext", () => {
    const parts = encrypt(key, "secret", "aad");
    const bytes = Buffer.from(parts.ciphertext, "base64");
    const firstByte = bytes[0];
    if (firstByte !== undefined) {
      bytes[0] = firstByte ^ 0xff;
    }
    expect(() => decrypt(key, { ...parts, ciphertext: bytes.toString("base64") }, "aad")).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => decrypt(Buffer.alloc(32, 9), encrypt(key, "secret", "aad"), "aad")).toThrow();
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

describe("name binding", () => {
  it("refuses to decrypt a secret whose row was swapped with another", async () => {
    const { db } = await createDb(":memory:");
    await runMigrations(db);
    const store = new SecretStore(db, key);

    await store.set("cf_api_token", "the-cloudflare-token");
    await store.set("tunnel_token", "the-tunnel-token");

    // Simulate an attacker with DB write access, or a partially restored backup,
    // moving the tunnel token's encrypted payload into the API token's row.
    const [tunnelRow] = await db.select().from(secrets).where(eq(secrets.key, "tunnel_token"));
    if (tunnelRow) {
      await db
        .update(secrets)
        .set({
          ciphertext: tunnelRow.ciphertext,
          iv: tunnelRow.iv,
          tag: tunnelRow.tag,
        })
        .where(eq(secrets.key, "cf_api_token"));
    }

    // Without AAD this returns 'the-tunnel-token' with a valid auth tag.
    await expect(store.get("cf_api_token")).rejects.toThrow();
  });

  it("rejects a value encrypted under a different name", () => {
    const parts = encrypt(key, "value", "name-a");
    expect(() => decrypt(key, parts, "name-b")).toThrow();
    expect(decrypt(key, parts, "name-a")).toBe("value");
  });
});
