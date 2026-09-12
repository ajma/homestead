import { CloudflareCredentialStore, TOKEN_KEY } from "@server/cloudflare/credentials";
import { SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { describe, expect, it } from "vitest";

const KEY = Buffer.alloc(32, 7);
const TOKEN = "cfat_super-secret-token-value";

async function makeStore() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  const secrets = new SecretStore(db, KEY);
  const store = new CloudflareCredentialStore(db, secrets);
  return { store, secrets };
}

describe("CloudflareCredentialStore", () => {
  it("reports configured:false on an empty database", async () => {
    const { store } = await makeStore();
    await expect(store.status()).resolves.toEqual({ configured: false });
    await expect(store.get()).resolves.toBeNull();
  });

  it("round-trips a token through SecretStore and lands the account id in settings", async () => {
    const { store } = await makeStore();
    await store.save({ token: TOKEN, accountId: "acct-123" }, 1_700_000_000);

    const creds = await store.get();
    expect(creds).toEqual({ token: TOKEN, accountId: "acct-123" });
  });

  it("status() reports the last four characters of the token and never the whole thing", async () => {
    const { store } = await makeStore();
    await store.save({ token: TOKEN, accountId: "acct-123" }, 1_700_000_000);

    const status = await store.status();
    expect(status).toEqual({
      configured: true,
      accountId: "acct-123",
      tokenHint: TOKEN.slice(-4),
      verifiedAt: 1_700_000_000,
    });
    // The binding assertion: search the SERIALISED status, not a variable we already
    // trust, for the full token.
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it("clears both the secret and the setting on delete", async () => {
    const { store } = await makeStore();
    await store.save({ token: TOKEN, accountId: "acct-123" }, 1_700_000_000);
    await store.clear();

    await expect(store.get()).resolves.toBeNull();
    await expect(store.status()).resolves.toEqual({ configured: false });
  });

  it("rolls back the token secret if a later write in save() fails, leaving nothing orphaned", async () => {
    const { store, secrets } = await makeStore();
    // `writeSetting` is private; reaching around it here is the price of exercising
    // "the second write fails after the first succeeded" without a real database error
    // to provoke. The account id write is made to fail; the token write ahead of it in
    // `save()`'s transaction must roll back with it rather than being left committed.
    const target = store as unknown as { writeSetting: (...args: unknown[]) => Promise<void> };
    const original = target.writeSetting.bind(store);
    let calls = 0;
    target.writeSetting = async (...args: unknown[]) => {
      calls++;
      if (calls === 1) throw new Error("simulated account id write failure");
      return original(...args);
    };

    await expect(
      store.save({ token: TOKEN, accountId: "acct-123" }, 1_700_000_000),
    ).rejects.toThrow("simulated account id write failure");

    // Un-transacted, the token's own `secrets` row would already have committed by the
    // time this write failed — an encrypted token nothing in the UI can remove, since
    // `CloudflarePanel`'s "Remove credentials" button only renders once `status()`
    // reports `configured: true`, which requires the account id this save never wrote.
    await expect(secrets.get(TOKEN_KEY)).resolves.toBeNull();
  });
});
