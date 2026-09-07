import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { settings, user } from "../db/schema.js";
import type { CloudflareClient } from "./client.js";
import { fingerprint } from "./reconcile.js";
import { syncAllowPolicy } from "./sync-users.js";

type Call = { method: string; path: string; body?: unknown };

function fakeClient(
  canned: Record<string, unknown>,
): CloudflareClient & { calls: Call[] } {
  const calls: Call[] = [];

  return {
    calls,
    request: async <T>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<T> => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      const result = canned[key];
      return result as T;
    },
    verifyToken: async () => ({ ok: true }),
    listAccounts: async () => [],
    listZones: async () => [],
    listIdentityProviders: async () => [],
  };
}

/** Emails become `include` rules; the IdP is a `require` rule (never `include`). */
const policyBody = (emails: string[]) => ({
  include: emails.map((email) => ({ email: { email } })),
  require: [{ login_method: { id: "idp1" } }],
});

async function seedUsers(
  admins: string[],
  viewers: string[] = [],
): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db);
  let n = 0;
  for (const [role, list] of [
    ["admin", admins],
    ["viewer", viewers],
  ] as const) {
    for (const email of list) {
      n += 1;
      await db
        .insert(user)
        .values({ id: `u${n}`, name: email, email, role, emailVerified: true });
    }
  }
  return db;
}

async function setFingerprint(db: Db, emails: string[]): Promise<void> {
  await db.insert(settings).values({
    key: "cloudflare.lastPushedPolicy",
    value: fingerprint(policyBody(emails)),
  });
}

describe("syncAllowPolicy", () => {
  it("rewrites the policy to match Homestead's users", async () => {
    const db = await seedUsers(["a@example.com", "b@example.com"]);
    await setFingerprint(db, ["a@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody(["a@example.com"]),
    });
    const r = await syncAllowPolicy(db, c, "a", "p1", "idp1");
    expect(r.synced).toBe(true);
    const put = c.calls.find((k) => k.method === "PUT");
    const body = put?.body as ReturnType<typeof policyBody>;
    expect(body.include).toEqual([
      { email: { email: "a@example.com" } },
      { email: { email: "b@example.com" } },
    ]);
    expect(body.require).toEqual([{ login_method: { id: "idp1" } }]);
  });

  it("includes viewers as well as admins", async () => {
    // Access governs reaching the published app, not administering Homestead.
    const db = await seedUsers(["admin@example.com"], ["viewer@example.com"]);
    await setFingerprint(db, ["admin@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody(["admin@example.com"]),
    });
    await syncAllowPolicy(db, c, "a", "p1", "idp1");
    const put = c.calls.find((k) => k.method === "PUT");
    if (!put) throw new Error("No PUT call found");
    const emails = (put.body as ReturnType<typeof policyBody>).include.map(
      (r) => r.email.email,
    );
    expect(emails).toContain("viewer@example.com");
  });

  it("refuses to overwrite a rule added by hand in Cloudflare", async () => {
    // Continuous sync asserts ownership of this policy. This guard is what makes
    // that safe: a foreign edit is surfaced, not destroyed.
    const db = await seedUsers(["a@example.com"]);
    await setFingerprint(db, ["a@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody([
        "a@example.com",
        "stranger@example.com",
      ]),
    });
    const r = await syncAllowPolicy(db, c, "a", "p1", "idp1");
    expect(r.synced).toBe(false);
    expect(r.conflict).toMatch(/changed outside/i);
    expect(c.calls.some((k) => k.method === "PUT")).toBe(false);
  });

  it("does not raise a conflict when only Homestead's own user list changed", async () => {
    // Adding a user locally changes desired state, not remote state. Reporting
    // that as foreign drift would make the conflict prompt meaningless noise.
    const db = await seedUsers(["a@example.com", "new@example.com"]);
    await setFingerprint(db, ["a@example.com"]);
    const c = fakeClient({
      "GET /accounts/a/access/policies/p1": policyBody(["a@example.com"]),
    });
    const r = await syncAllowPolicy(db, c, "a", "p1", "idp1");
    expect(r.synced).toBe(true);
    expect(r.conflict).toBeUndefined();
  });

  it("stores the new fingerprint so the next run sees no drift", async () => {
    const db = await seedUsers(["a@example.com", "b@example.com"]);
    await setFingerprint(db, ["a@example.com"]);

    let getCount = 0;
    const c = fakeClient({});
    c.request = async <T>(
      method: string,
      path: string,
      _body?: unknown,
    ): Promise<T> => {
      if (method === "GET" && path.includes("/access/policies/")) {
        getCount += 1;
        if (getCount === 1) {
          // First GET: check for clobber
          return policyBody(["a@example.com"]) as T;
        }
        // Second GET: after PUT, return what was stored
        return policyBody(["a@example.com", "b@example.com"]) as T;
      }
      return {} as T;
    };

    await syncAllowPolicy(db, c, "a", "p1", "idp1");
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "cloudflare.lastPushedPolicy"));
    expect(row?.value).toBe(
      fingerprint(policyBody(["a@example.com", "b@example.com"])),
    );
  });

  it("fingerprints what the API returned, not what was sent", async () => {
    // Cloudflare may normalize the stored policy (e.g., sort emails). If we
    // fingerprint what we sent rather than what was stored, every subsequent
    // sync reports a false conflict.
    const db = await seedUsers(["z@example.com", "a@example.com"]);
    await setFingerprint(db, ["a@example.com"]);

    let callCount = 0;
    const c = fakeClient({});
    c.request = async <T>(
      method: string,
      path: string,
      _body?: unknown,
    ): Promise<T> => {
      if (method === "GET" && path.includes("/access/policies/")) {
        callCount += 1;
        if (callCount === 1) {
          // First sync, first GET: check for clobber - return old state
          return policyBody(["a@example.com"]) as T;
        }
        if (callCount === 2) {
          // First sync, second GET: after PUT - return normalized (sorted)
          return policyBody(["a@example.com", "z@example.com"]) as T;
        }
        // Second sync onwards: always return the normalized state
        return policyBody(["a@example.com", "z@example.com"]) as T;
      }
      return {} as T;
    };

    // First sync
    await syncAllowPolicy(db, c, "a", "p1", "idp1");

    // Second sync with no user changes - should see no conflict
    const r = await syncAllowPolicy(db, c, "a", "p1", "idp1");
    expect(r.synced).toBe(true);
    expect(r.conflict).toBeUndefined();
  });
});
