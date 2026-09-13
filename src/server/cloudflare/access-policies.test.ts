import {
  AccessPoliciesStore,
  ensureAccessPolicies,
  HUMAN_POLICY_NAME,
  MONITOR_CLIENT_SECRET_KEY,
  rotateMonitorSecret,
} from "@server/cloudflare/access-policies";
import type { CloudflareClient } from "@server/cloudflare/client";
import { SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { settings, users } from "@server/db/schema";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const KEY = Buffer.alloc(32, 11);

/** Not used by any test in this file, but required by the `CloudflareClient` type — every
 * method throws so a test that accidentally exercises one fails loudly rather than
 * silently returning `undefined`. */
function unusedMethod(name: string) {
  return async () => {
    throw new Error(`${name} is not used by access-policies tests`);
  };
}

function fakeClient(overrides: Partial<CloudflareClient> = {}): {
  client: CloudflareClient;
  calls: {
    createServiceToken: number;
    createMonitorPolicy: number;
    createEmailPolicy: Array<{ name: string; emails: string[] }>;
    deleteServiceToken: string[];
  };
} {
  const calls = {
    createServiceToken: 0,
    createMonitorPolicy: 0,
    createEmailPolicy: [] as Array<{ name: string; emails: string[] }>,
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
    updateEmailPolicy: unusedMethod("updateEmailPolicy"),
    getPolicy: unusedMethod("getPolicy"),
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
      return { id: "policy-monitor" };
    },
    async createEmailPolicy(name, emails) {
      calls.createEmailPolicy.push({ name, emails });
      return { id: "policy-human" };
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
  const store = new AccessPoliciesStore(db, secrets);
  return { store, secrets, db };
}

/** Inserts one user row directly — `createUser`/`userRoutes` go through Better-Auth's own
 * hashing and validation, none of which this module's own tests need; a direct insert is
 * the same shortcut `provision-tunnel.test.ts`'s `seedDb` already takes for its one admin
 * row. `disabled` defaults to `false` (an enabled user) so a test only has to say
 * `disabled: true` for the one row that matters. */
async function insertUser(
  db: Awaited<ReturnType<typeof makeStore>>["db"],
  opts: { email: string; disabled?: boolean },
): Promise<void> {
  await db.insert(users).values({
    id: ulid(),
    email: opts.email,
    name: opts.email,
    role: "viewer",
    emailVerified: true,
    disabledAt: opts.disabled ? Date.now() : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe("AccessPoliciesStore", () => {
  it("returns null when unset", async () => {
    const { store } = await makeStore();
    await expect(store.get()).resolves.toBeNull();
  });

  it("returns null when the human policy id is missing, even with the monitor half set", async () => {
    // Phase 3A extends the "no half-formed record" check to the human policy: an install
    // whose monitor token and policy already exist but whose human policy has not been
    // created yet is not "configured" by this store's own definition.
    const { store, db } = await makeStore();
    const secrets = new SecretStore(db, KEY);
    // Write only the monitor half directly, bypassing `set()` (which always writes all
    // five pieces together) to simulate exactly that partial state.
    await db.insert(settings).values([
      { key: "cloudflare.monitor.token_id", value: "token-1" },
      { key: "cloudflare.monitor.client_id", value: "client-1" },
      { key: "cloudflare.monitor.policy_id", value: "policy-monitor" },
    ]);
    await secrets.set(MONITOR_CLIENT_SECRET_KEY, "the-secret");
    await expect(store.get()).resolves.toBeNull();
  });

  it("round-trips a record, never surfacing the secret through get()", async () => {
    const { store, secrets } = await makeStore();
    const record = {
      tokenId: "token-1",
      clientId: "client-1",
      monitorPolicyId: "policy-monitor",
      humanPolicyId: "policy-human",
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
      monitorPolicyId: "policy-monitor",
      humanPolicyId: "policy-human",
      expiresAt: null,
    };
    await store.set(record, "the-secret");
    await expect(store.get()).resolves.toEqual(record);
  });

  it("getCredentials() returns null when unset", async () => {
    const { store } = await makeStore();
    await expect(store.getCredentials()).resolves.toBeNull();
  });

  it("getCredentials() returns the client id and secret together", async () => {
    const { store } = await makeStore();
    await store.set(
      {
        tokenId: "token-1",
        clientId: "client-1",
        monitorPolicyId: "policy-monitor",
        humanPolicyId: "policy-human",
        expiresAt: null,
      },
      "the-secret",
    );
    await expect(store.getCredentials()).resolves.toEqual({
      clientId: "client-1",
      clientSecret: "the-secret",
    });
  });

  it("getCredentials() reflects a rotation on the very next read", async () => {
    // The whole reason this method reads live rather than returning a cached value: a
    // caller holding onto a stale secret past a rotation would keep authenticating with
    // a credential Cloudflare no longer accepts.
    const { store } = await makeStore();
    await store.set(
      {
        tokenId: "token-1",
        clientId: "client-1",
        monitorPolicyId: "policy-monitor",
        humanPolicyId: "policy-human",
        expiresAt: null,
      },
      "old-secret",
    );
    await expect(store.getCredentials()).resolves.toEqual({
      clientId: "client-1",
      clientSecret: "old-secret",
    });

    await store.set(
      {
        tokenId: "token-1",
        clientId: "client-2",
        monitorPolicyId: "policy-monitor",
        humanPolicyId: "policy-human",
        expiresAt: null,
      },
      "new-secret",
    );
    await expect(store.getCredentials()).resolves.toEqual({
      clientId: "client-2",
      clientSecret: "new-secret",
    });
  });

  it("clear() removes the record and the secret", async () => {
    const { store, secrets } = await makeStore();
    await store.set(
      {
        tokenId: "token-1",
        clientId: "client-1",
        monitorPolicyId: "policy-monitor",
        humanPolicyId: "policy-human",
        expiresAt: null,
      },
      "the-secret",
    );
    await store.clear();
    await expect(store.get()).resolves.toBeNull();
    await expect(secrets.get(MONITOR_CLIENT_SECRET_KEY)).resolves.toBeNull();
    await expect(store.getCredentials()).resolves.toBeNull();
  });
});

describe("ensureAccessPolicies", () => {
  it("creates the token and both policies on first call", async () => {
    const { store, db } = await makeStore();
    const { client, calls } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });

    const result = await ensureAccessPolicies({ store, client, db });

    expect(result).toEqual({
      tokenId: "token-1",
      clientId: "client-1",
      monitorPolicyId: "policy-monitor",
      humanPolicyId: "policy-human",
      expiresAt: Date.parse("2027-09-12T00:00:00Z"),
    });
    expect(calls.createServiceToken).toBe(1);
    expect(calls.createMonitorPolicy).toBe(1);
    expect(calls.createEmailPolicy).toEqual([
      { name: HUMAN_POLICY_NAME, emails: ["admin@example.com"] },
    ]);
    await expect(store.get()).resolves.toEqual(result);
  });

  it("seeds the human policy with every enabled user's email, excluding disabled ones", async () => {
    // Phase 3A's own point: a disabled user who keeps internet access through this policy
    // defeats the entire reason for disabling them.
    const { store, db } = await makeStore();
    const { client, calls } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });
    await insertUser(db, { email: "viewer@example.com" });
    await insertUser(db, { email: "gone@example.com", disabled: true });

    await ensureAccessPolicies({ store, client, db });

    expect(calls.createEmailPolicy).toHaveLength(1);
    expect(calls.createEmailPolicy[0]?.emails.sort()).toEqual(
      ["admin@example.com", "viewer@example.com"].sort(),
    );
  });

  it("is a no-op on the second call — it must not create a second token or a second human policy", async () => {
    const { store, db } = await makeStore();
    const { client, calls } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });

    const first = await ensureAccessPolicies({ store, client, db });
    const second = await ensureAccessPolicies({ store, client, db });

    expect(second).toEqual(first);
    // The binding assertion: exactly one token, one monitor policy, one human policy, no
    // matter how many times this is called. 2F measured a double-click creating two real,
    // billed Cloudflare service tokens when this was a check-then-create race — the same
    // protection now has to cover the human policy too.
    expect(calls.createServiceToken).toBe(1);
    expect(calls.createMonitorPolicy).toBe(1);
    expect(calls.createEmailPolicy).toHaveLength(1);
  });

  it("never returns the secret to its caller", async () => {
    const { store, db } = await makeStore();
    const { client } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });

    const result = await ensureAccessPolicies({ store, client, db });

    expect(result).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(result)).not.toContain("secret-1");
  });

  it("persists expiresAt", async () => {
    const { store, db, secrets } = await makeStore();
    const { client } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });

    await ensureAccessPolicies({ store, client, db });

    // Read through a FRESH store bound to the same db — proves this round-trips through
    // the database, not just an in-memory object the first call happened to return.
    const reloaded = new AccessPoliciesStore(db, secrets);
    await expect(reloaded.get()).resolves.toMatchObject({
      expiresAt: Date.parse("2027-09-12T00:00:00Z"),
    });
  });

  it("collapses two concurrent calls onto one token creation and one human policy creation", async () => {
    // The race this closes: `await deps.store.get()` is a real gap, and two callers that
    // land in it — a double-click, or two requests hitting the credentials-save path at
    // once — must not both create real, billed Cloudflare resources.
    const { store, db } = await makeStore();
    const { client, calls } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });

    const [first, second] = await Promise.all([
      ensureAccessPolicies({ store, client, db }),
      ensureAccessPolicies({ store, client, db }),
    ]);

    expect(calls.createServiceToken).toBe(1);
    expect(calls.createMonitorPolicy).toBe(1);
    expect(calls.createEmailPolicy).toHaveLength(1);
    expect(second).toEqual(first);
    await expect(store.get()).resolves.toEqual(first);
  });

  it("does not collapse concurrent calls against two independent stores", async () => {
    // The WeakMap is keyed on the store instance so two genuinely separate installs (or,
    // here, two separate test fixtures) never share an in-flight promise.
    const { store: storeA, db: dbA } = await makeStore();
    const { store: storeB, db: dbB } = await makeStore();
    const { client, calls } = fakeClient();
    await insertUser(dbA, { email: "a@example.com" });
    await insertUser(dbB, { email: "b@example.com" });

    await Promise.all([
      ensureAccessPolicies({ store: storeA, client, db: dbA }),
      ensureAccessPolicies({ store: storeB, client, db: dbB }),
    ]);

    expect(calls.createServiceToken).toBe(2);
    expect(calls.createMonitorPolicy).toBe(2);
    expect(calls.createEmailPolicy).toHaveLength(2);
  });

  it("completes only the human policy when the monitor half already exists — the Phase 2 upgrade path", async () => {
    // The carried fix from Task 2's report: `get()` requires the human policy too, so an
    // install that already ran Phase 2's `ensureMonitorAccess` (monitor token + policy,
    // no human policy) used to fall through to full recreation here — a NEW service token,
    // orphaning the old one in the account and failing every external probe until the new
    // one propagates. This proves the fix: the existing token id survives unchanged, and
    // no new token is ever requested.
    const { store, db, secrets } = await makeStore();
    const { client, calls } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });
    await db.insert(settings).values([
      { key: "cloudflare.monitor.token_id", value: "existing-token" },
      { key: "cloudflare.monitor.client_id", value: "existing-client" },
      { key: "cloudflare.monitor.policy_id", value: "existing-monitor-policy" },
    ]);
    await secrets.set(MONITOR_CLIENT_SECRET_KEY, "existing-secret");

    const result = await ensureAccessPolicies({ store, client, db });

    expect(result).toEqual({
      tokenId: "existing-token",
      clientId: "existing-client",
      monitorPolicyId: "existing-monitor-policy",
      humanPolicyId: "policy-human",
      expiresAt: null,
    });
    expect(calls.createServiceToken).toBe(0);
    expect(calls.createMonitorPolicy).toBe(0);
    expect(calls.createEmailPolicy).toEqual([
      { name: HUMAN_POLICY_NAME, emails: ["admin@example.com"] },
    ]);
    // The secret is carried through byte-for-byte, never rewritten.
    await expect(secrets.get(MONITOR_CLIENT_SECRET_KEY)).resolves.toBe("existing-secret");
    await expect(store.get()).resolves.toEqual(result);
  });

  it("deletes the token if monitor-policy creation fails, and records nothing", async () => {
    const { store, db } = await makeStore();
    const { client, calls } = fakeClient({
      async createMonitorPolicy() {
        throw new Error("policy creation failed");
      },
    });
    await insertUser(db, { email: "admin@example.com" });

    await expect(ensureAccessPolicies({ store, client, db })).rejects.toThrow(
      "policy creation failed",
    );

    expect(calls.deleteServiceToken).toEqual(["token-1"]);
    await expect(store.get()).resolves.toBeNull();
  });

  it("deletes the token if the human policy fails after the monitor policy succeeded, and records nothing", async () => {
    // The precedent this follows: 2D's `ensureMonitorAccess` deletes an orphaned token on
    // policy failure. Phase 3A adds a second failure point (the human policy) after the
    // first one (the monitor policy) succeeds, and treats it exactly the same way — no
    // half-made state is left for a retry to trip over.
    const { store, db } = await makeStore();
    const { client, calls } = fakeClient({
      async createEmailPolicy() {
        throw new Error("human policy creation failed");
      },
    });
    await insertUser(db, { email: "admin@example.com" });

    await expect(ensureAccessPolicies({ store, client, db })).rejects.toThrow(
      "human policy creation failed",
    );

    // The compensating delete ran against the exact token this attempt created. The
    // monitor policy itself is left in Cloudflare with no client method to remove it — see
    // `createAccessPolicies`'s own doc comment for why that is a tidiness issue, not a
    // security one (it is `non_identity`, pointing at a now-deleted token).
    expect(calls.deleteServiceToken).toEqual(["token-1"]);
    expect(calls.createMonitorPolicy).toBe(1);
    await expect(store.get()).resolves.toBeNull();
  });

  it("surfaces the original human-policy-creation error even if the compensating delete also fails", async () => {
    const { store, db } = await makeStore();
    const { client } = fakeClient({
      async createEmailPolicy() {
        throw new Error("human policy creation failed");
      },
      async deleteServiceToken() {
        throw new Error("delete also failed");
      },
    });
    await insertUser(db, { email: "admin@example.com" });

    await expect(ensureAccessPolicies({ store, client, db })).rejects.toThrow(
      "human policy creation failed",
    );
  });
});

describe("rotateMonitorSecret", () => {
  it("replaces the secret and keeps the same token id and both policy ids", async () => {
    const { store, db } = await makeStore();
    const { client } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });
    const created = await ensureAccessPolicies({ store, client, db });

    const rotated = await rotateMonitorSecret({ store, client });

    expect(rotated.tokenId).toBe(created.tokenId);
    expect(rotated.monitorPolicyId).toBe(created.monitorPolicyId);
    expect(rotated.humanPolicyId).toBe(created.humanPolicyId);
    expect(rotated.clientId).toBe("client-1");
    expect(rotated.expiresAt).toBe(Date.parse("2028-09-12T00:00:00Z"));
    await expect(store.get()).resolves.toEqual(rotated);
  });

  it("persists the rotated secret, replacing the old one", async () => {
    const { store, db, secrets } = await makeStore();
    const { client } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });
    await ensureAccessPolicies({ store, client, db });

    await rotateMonitorSecret({ store, client });

    await expect(secrets.get(MONITOR_CLIENT_SECRET_KEY)).resolves.toBe("rotated-secret");
  });

  it("never returns the secret to its caller", async () => {
    const { store, db } = await makeStore();
    const { client } = fakeClient();
    await insertUser(db, { email: "admin@example.com" });
    await ensureAccessPolicies({ store, client, db });

    const rotated = await rotateMonitorSecret({ store, client });

    expect(rotated).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(rotated)).not.toContain("rotated-secret");
  });

  it("throws if the access policies were never created", async () => {
    const { store } = await makeStore();
    const { client } = fakeClient();

    await expect(rotateMonitorSecret({ store, client })).rejects.toThrow();
  });
});
