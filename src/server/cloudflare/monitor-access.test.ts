import type { CloudflareClient } from "@server/cloudflare/client";
import {
  ensureMonitorAccess,
  MONITOR_CLIENT_SECRET_KEY,
  MonitorAccessStore,
  rotateMonitorSecret,
} from "@server/cloudflare/monitor-access";
import { SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { describe, expect, it } from "vitest";

const KEY = Buffer.alloc(32, 11);

/** Not used by any test in this file, but required by the `CloudflareClient` type — every
 * method throws so a test that accidentally exercises one fails loudly rather than
 * silently returning `undefined`. */
function unusedMethod(name: string) {
  return async () => {
    throw new Error(`${name} is not used by monitor-access tests`);
  };
}

function fakeClient(overrides: Partial<CloudflareClient> = {}): {
  client: CloudflareClient;
  calls: { createServiceToken: number; createMonitorPolicy: number; deleteServiceToken: string[] };
} {
  const calls = {
    createServiceToken: 0,
    createMonitorPolicy: 0,
    deleteServiceToken: [] as string[],
  };

  const client: CloudflareClient = {
    listZones: unusedMethod("listZones"),
    createTunnel: unusedMethod("createTunnel"),
    listTunnels: unusedMethod("listTunnels"),
    tunnelToken: unusedMethod("tunnelToken"),
    deleteTunnel: unusedMethod("deleteTunnel"),
    getTunnelConfig: unusedMethod("getTunnelConfig"),
    putTunnelConfig: unusedMethod("putTunnelConfig"),
    createDnsRecord: unusedMethod("createDnsRecord"),
    deleteDnsRecord: unusedMethod("deleteDnsRecord"),
    findDnsRecord: unusedMethod("findDnsRecord"),
    createAccessApp: unusedMethod("createAccessApp"),
    deleteAccessApp: unusedMethod("deleteAccessApp"),
    findAccessApp: unusedMethod("findAccessApp"),
    listServiceTokens: unusedMethod("listServiceTokens"),
    async createServiceToken(_name) {
      calls.createServiceToken++;
      return {
        id: "token-1",
        clientId: "client-1",
        clientSecret: "secret-1",
        expiresAt: Date.parse("2027-09-12T00:00:00Z"),
      };
    },
    async rotateServiceToken() {
      return {
        clientId: "client-1",
        clientSecret: "rotated-secret",
        expiresAt: Date.parse("2028-09-12T00:00:00Z"),
      };
    },
    async createMonitorPolicy() {
      calls.createMonitorPolicy++;
      return { id: "policy-1" };
    },
    async deleteServiceToken(tokenId) {
      calls.deleteServiceToken.push(tokenId);
    },
    ...overrides,
  };

  return { client, calls };
}

async function makeStore() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  const secrets = new SecretStore(db, KEY);
  const store = new MonitorAccessStore(db, secrets);
  return { store, secrets, db };
}

describe("MonitorAccessStore", () => {
  it("returns null when unset", async () => {
    const { store } = await makeStore();
    await expect(store.get()).resolves.toBeNull();
  });

  it("round-trips a record, never surfacing the secret through get()", async () => {
    const { store, secrets } = await makeStore();
    const record = {
      tokenId: "token-1",
      clientId: "client-1",
      policyId: "policy-1",
      expiresAt: 1_800_000_000_000,
    };
    await store.set(record, "the-secret");

    const result = await store.get();
    expect(result).toEqual(record);
    expect(JSON.stringify(result)).not.toContain("the-secret");
    // The secret IS stored — just not through this accessor.
    await expect(secrets.get(MONITOR_CLIENT_SECRET_KEY)).resolves.toBe("the-secret");
  });

  it("round-trips a null expiresAt", async () => {
    const { store } = await makeStore();
    const record = {
      tokenId: "token-1",
      clientId: "client-1",
      policyId: "policy-1",
      expiresAt: null,
    };
    await store.set(record, "the-secret");
    await expect(store.get()).resolves.toEqual(record);
  });

  it("clear() removes the record and the secret", async () => {
    const { store, secrets } = await makeStore();
    await store.set(
      { tokenId: "token-1", clientId: "client-1", policyId: "policy-1", expiresAt: null },
      "the-secret",
    );
    await store.clear();
    await expect(store.get()).resolves.toBeNull();
    await expect(secrets.get(MONITOR_CLIENT_SECRET_KEY)).resolves.toBeNull();
  });
});

describe("ensureMonitorAccess", () => {
  it("creates the token and the policy on first call", async () => {
    const { store } = await makeStore();
    const { client, calls } = fakeClient();

    const result = await ensureMonitorAccess({ store, client });

    expect(result).toEqual({
      tokenId: "token-1",
      clientId: "client-1",
      policyId: "policy-1",
      expiresAt: Date.parse("2027-09-12T00:00:00Z"),
    });
    expect(calls.createServiceToken).toBe(1);
    expect(calls.createMonitorPolicy).toBe(1);
    await expect(store.get()).resolves.toEqual(result);
  });

  it("is a no-op on the second call — it must not create a second token", async () => {
    const { store } = await makeStore();
    const { client, calls } = fakeClient();

    const first = await ensureMonitorAccess({ store, client });
    const second = await ensureMonitorAccess({ store, client });

    expect(second).toEqual(first);
    // The binding assertion: exactly one token, exactly one policy, no matter how many
    // times this is called. A second call creating a second token is silent, costs
    // money, and leaves rotation touching only one of two live tokens.
    expect(calls.createServiceToken).toBe(1);
    expect(calls.createMonitorPolicy).toBe(1);
  });

  it("never returns the secret to its caller", async () => {
    const { store } = await makeStore();
    const { client } = fakeClient();

    const result = await ensureMonitorAccess({ store, client });

    expect(result).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(result)).not.toContain("secret-1");
  });

  it("persists expiresAt", async () => {
    const { store, db, secrets } = await makeStore();
    const { client } = fakeClient();

    await ensureMonitorAccess({ store, client });

    // Read through a FRESH store bound to the same db — proves this round-trips through
    // the database, not just an in-memory object the first call happened to return.
    const reloaded = new MonitorAccessStore(db, secrets);
    await expect(reloaded.get()).resolves.toMatchObject({
      expiresAt: Date.parse("2027-09-12T00:00:00Z"),
    });
  });

  it("deletes the token if policy creation fails, and records nothing", async () => {
    const { store } = await makeStore();
    const { client, calls } = fakeClient({
      async createMonitorPolicy() {
        throw new Error("policy creation failed");
      },
    });

    await expect(ensureMonitorAccess({ store, client })).rejects.toThrow("policy creation failed");

    // The compensating delete ran against the exact token this attempt created...
    expect(calls.deleteServiceToken).toEqual(["token-1"]);
    // ...and nothing was recorded locally — a retry starts clean, not half-formed.
    await expect(store.get()).resolves.toBeNull();
  });

  it("surfaces the original policy-creation error even if the compensating delete also fails", async () => {
    const { store } = await makeStore();
    const { client } = fakeClient({
      async createMonitorPolicy() {
        throw new Error("policy creation failed");
      },
      async deleteServiceToken() {
        throw new Error("delete also failed");
      },
    });

    await expect(ensureMonitorAccess({ store, client })).rejects.toThrow("policy creation failed");
  });
});

describe("rotateMonitorSecret", () => {
  it("replaces the secret and keeps the same token id and policy id", async () => {
    const { store } = await makeStore();
    const { client } = fakeClient();
    const created = await ensureMonitorAccess({ store, client });

    const rotated = await rotateMonitorSecret({ store, client });

    expect(rotated.tokenId).toBe(created.tokenId);
    expect(rotated.policyId).toBe(created.policyId);
    expect(rotated.clientId).toBe("client-1");
    expect(rotated.expiresAt).toBe(Date.parse("2028-09-12T00:00:00Z"));
    await expect(store.get()).resolves.toEqual(rotated);
  });

  it("persists the rotated secret, replacing the old one", async () => {
    const { store, secrets } = await makeStore();
    const { client } = fakeClient();
    await ensureMonitorAccess({ store, client });

    await rotateMonitorSecret({ store, client });

    await expect(secrets.get(MONITOR_CLIENT_SECRET_KEY)).resolves.toBe("rotated-secret");
  });

  it("never returns the secret to its caller", async () => {
    const { store } = await makeStore();
    const { client } = fakeClient();
    await ensureMonitorAccess({ store, client });

    const rotated = await rotateMonitorSecret({ store, client });

    expect(rotated).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(rotated)).not.toContain("rotated-secret");
  });

  it("throws if the monitor access was never created", async () => {
    const { store } = await makeStore();
    const { client } = fakeClient();

    await expect(rotateMonitorSecret({ store, client })).rejects.toThrow();
  });
});
