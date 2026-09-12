import { CloudflareCredentialStore } from "@server/cloudflare/credentials";
import { SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { describe, expect, it } from "vitest";

const KEY = Buffer.alloc(32, 7);
const TOKEN = "cfat_super-secret-token-value";

async function makeStore() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  const secrets = new SecretStore(db, KEY);
  return new CloudflareCredentialStore(db, secrets);
}

describe("CloudflareCredentialStore", () => {
  it("reports configured:false on an empty database", async () => {
    const store = await makeStore();
    await expect(store.status()).resolves.toEqual({ configured: false });
    await expect(store.get()).resolves.toBeNull();
  });

  it("round-trips a token through SecretStore and lands the account id in settings", async () => {
    const store = await makeStore();
    await store.save({ token: TOKEN, accountId: "acct-123" }, 1_700_000_000);

    const creds = await store.get();
    expect(creds).toEqual({ token: TOKEN, accountId: "acct-123" });
  });

  it("status() reports the last four characters of the token and never the whole thing", async () => {
    const store = await makeStore();
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
    const store = await makeStore();
    await store.save({ token: TOKEN, accountId: "acct-123" }, 1_700_000_000);
    await store.clear();

    await expect(store.get()).resolves.toBeNull();
    await expect(store.status()).resolves.toEqual({ configured: false });
  });
});
