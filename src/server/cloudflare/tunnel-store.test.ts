import { TUNNEL_TOKEN_KEY, TunnelStore } from "@server/cloudflare/tunnel-store";
import { SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { settings } from "@server/db/schema";
import { describe, expect, it } from "vitest";

const KEY = Buffer.alloc(32, 7);
const TOKEN = "tunnel-token-super-secret-value";

async function makeStore() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  const secrets = new SecretStore(db, KEY);
  const store = new TunnelStore(db, secrets);
  return { store, secrets, db };
}

describe("TunnelStore", () => {
  it("returns null when unset", async () => {
    const { store } = await makeStore();
    await expect(store.get()).resolves.toBeNull();
  });

  it("round-trips a record and its token", async () => {
    const { store } = await makeStore();
    const record = {
      tunnelId: "tunnel-1",
      name: "homestead",
      appId: null,
      createdAt: 1_700_000_000,
    };
    await store.set(record, TOKEN);

    await expect(store.get()).resolves.toEqual(record);
  });

  it("round-trips a record with an appId set", async () => {
    const { store } = await makeStore();
    const record = {
      tunnelId: "tunnel-1",
      name: "homestead",
      appId: "app-1",
      createdAt: 1_700_000_000,
    };
    await store.set(record, TOKEN);

    await expect(store.get()).resolves.toEqual(record);
  });

  it("never returns the token itself from get()", async () => {
    const { store } = await makeStore();
    const record = {
      tunnelId: "tunnel-1",
      name: "homestead",
      appId: null,
      createdAt: 1_700_000_000,
    };
    await store.set(record, TOKEN);

    const result = await store.get();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("clear() removes both the record and the token", async () => {
    const { store, secrets } = await makeStore();
    const record = {
      tunnelId: "tunnel-1",
      name: "homestead",
      appId: null,
      createdAt: 1_700_000_000,
    };
    await store.set(record, TOKEN);

    await store.clear();

    await expect(store.get()).resolves.toBeNull();
    await expect(secrets.get(TUNNEL_TOKEN_KEY)).resolves.toBeNull();
  });

  it("re-setting with appId: null removes a previously-set appId", async () => {
    const { store } = await makeStore();
    await store.set(
      { tunnelId: "tunnel-1", name: "homestead", appId: "app-1", createdAt: 1_700_000_000 },
      TOKEN,
    );
    await store.set(
      { tunnelId: "tunnel-1", name: "homestead", appId: null, createdAt: 1_700_000_000 },
      TOKEN,
    );

    await expect(store.get()).resolves.toEqual({
      tunnelId: "tunnel-1",
      name: "homestead",
      appId: null,
      createdAt: 1_700_000_000,
    });
  });

  describe("a partially-written record", () => {
    it("reads as absent when the settings half exists but the token does not", async () => {
      // Simulates provisioning being interrupted after the settings write but before the
      // token was ever persisted — bypassing `set()` entirely is the only way to produce
      // this, since `set()` itself writes both halves in one transaction.
      const { store, db } = await makeStore();
      const now = Math.floor(Date.now() / 1000);
      await db.insert(settings).values([
        { key: "cloudflare.tunnel.id", value: "tunnel-1", updatedAt: now },
        { key: "cloudflare.tunnel.name", value: "homestead", updatedAt: now },
        { key: "cloudflare.tunnel.created_at", value: "1700000000", updatedAt: now },
      ]);

      // Not present as a usable tunnel: a tunnel id with no token cannot serve traffic,
      // so this must read the same as "never provisioned", not as a record with a hole.
      await expect(store.get()).resolves.toBeNull();
    });

    it("reads as absent when the token exists but the settings half does not", async () => {
      const { store, secrets } = await makeStore();
      await secrets.set(TUNNEL_TOKEN_KEY, TOKEN);

      await expect(store.get()).resolves.toBeNull();
    });

    it("treats an empty-string token the same as a missing one", async () => {
      const { store, secrets, db } = await makeStore();
      const now = Math.floor(Date.now() / 1000);
      await db.insert(settings).values([
        { key: "cloudflare.tunnel.id", value: "tunnel-1", updatedAt: now },
        { key: "cloudflare.tunnel.name", value: "homestead", updatedAt: now },
        { key: "cloudflare.tunnel.created_at", value: "1700000000", updatedAt: now },
      ]);
      await secrets.set(TUNNEL_TOKEN_KEY, "");

      await expect(store.get()).resolves.toBeNull();
    });
  });
});
