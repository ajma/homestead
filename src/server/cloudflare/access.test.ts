import { describe, expect, it } from "vitest";
import type { PolicyRule } from "./access.js";
import {
  createAllowPolicy,
  createApp,
  createProbePolicy,
  createServiceToken,
  deleteApp,
  updateAllowPolicy,
} from "./access.js";
import type { CloudflareClient } from "./client.js";

type FakeClientCall = {
  method: string;
  path: string;
  body?: unknown;
};

function fakeClient(
  responses: Record<string, unknown>,
): CloudflareClient & { calls: FakeClientCall[] } {
  const calls: FakeClientCall[] = [];

  return {
    calls,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      const response = responses[key];
      if (response === undefined) {
        throw new Error(`No fake response for ${key}`);
      }
      return response as T;
    },
    async detectTokenKind() {
      return "account" as const;
    },
    async verifyToken() {
      return { ok: true as const };
    },
    async listAccounts() {
      return [];
    },
    async listZones() {
      return [];
    },
    async listIdentityProviders() {
      return [];
    },
  };
}

describe("Access policies and applications", () => {
  it("puts emails in include and the identity provider in require", async () => {
    // include is ANY-of and require is ALL-of. Swapping them admits anyone who can
    // authenticate with the provider at all, which for a public IdP is everyone.
    const c = fakeClient({ "POST /accounts/a/access/policies": { id: "p1" } });
    await createAllowPolicy(c, "a", "idp1", [
      "me@example.com",
      "you@example.com",
    ]);
    const body = c.calls[0]?.body as {
      include: PolicyRule[];
      require: PolicyRule[];
    };
    expect(body.include).toEqual([
      { email: { email: "me@example.com" } },
      { email: { email: "you@example.com" } },
    ]);
    expect(body.require).toEqual([{ login_method: { id: "idp1" } }]);
  });

  it("never places the identity provider in include", async () => {
    const c = fakeClient({ "POST /accounts/a/access/policies": { id: "p1" } });
    await createAllowPolicy(c, "a", "idp1", ["me@example.com"]);
    const body = c.calls[0]?.body as { include: PolicyRule[] };
    expect(JSON.stringify(body.include)).not.toContain("login_method");
  });

  it("creates the probe policy as a non-identity service-auth rule", async () => {
    const c = fakeClient({ "POST /accounts/a/access/policies": { id: "p2" } });
    await createProbePolicy(c, "a", "st1");
    const body = c.calls[0]?.body as {
      decision: string;
      include: PolicyRule[];
    };
    expect(body.decision).toBe("non_identity");
    expect(body.include).toEqual([{ service_token: { token_id: "st1" } }]);
  });

  it("creates a self-hosted app that references policies by id", async () => {
    const c = fakeClient({ "POST /accounts/a/access/apps": { id: "app1" } });
    await createApp(c, "a", "app.example.com", ["p1", "p2"]);
    const body = c.calls[0]?.body as {
      type: string;
      domain: string;
      policies: { id: string }[];
    };
    expect(body.type).toBe("self_hosted");
    expect(body.domain).toBe("app.example.com");
    expect(body.policies).toEqual([{ id: "p1" }, { id: "p2" }]);
  });

  it("deleting an app does not delete any policy", async () => {
    // Cloudflare deletes a LEGACY inline policy when it is detached from an app.
    // Reusable policies must survive, or removing one exposure destroys access for all.
    const c = fakeClient({ "DELETE /accounts/a/access/apps/app1": {} });
    await deleteApp(c, "a", "app1");
    expect(c.calls.every((k) => !k.path.includes("/access/policies"))).toBe(
      true,
    );
  });

  it("throws when creating an allow policy with an empty email list", async () => {
    const c = fakeClient({});
    await expect(createAllowPolicy(c, "a", "idp1", [])).rejects.toThrow(
      "Access policy must name at least one user",
    );
  });

  it("throws when updating an allow policy with an empty email list", async () => {
    const c = fakeClient({});
    await expect(updateAllowPolicy(c, "a", "p1", "idp1", [])).rejects.toThrow(
      "Access policy must name at least one user",
    );
  });

  it("throws when updating an allow policy with only blank emails", async () => {
    const c = fakeClient({});
    await expect(
      updateAllowPolicy(c, "a", "p1", "idp1", ["  ", "\t", ""]),
    ).rejects.toThrow("Access policy must name at least one user");
  });

  it("normalizes emails by trimming, lowercasing, and deduplicating", async () => {
    const c = fakeClient({ "POST /accounts/a/access/policies": { id: "p1" } });
    await createAllowPolicy(c, "a", "idp1", [
      " Me@Example.COM ",
      "me@example.com",
      "YOU@example.com",
    ]);
    const body = c.calls[0]?.body as { include: PolicyRule[] };
    expect(body.include).toEqual([
      { email: { email: "me@example.com" } },
      { email: { email: "you@example.com" } },
    ]);
  });

  it("throws when creating an app with a hostname containing a scheme", async () => {
    const c = fakeClient({});
    await expect(
      createApp(c, "a", "https://app.example.com", ["p1"]),
    ).rejects.toThrow("Hostname must not include a scheme");
  });

  it("throws when creating an app with a hostname containing a path", async () => {
    const c = fakeClient({});
    await expect(
      createApp(c, "a", "app.example.com/path", ["p1"]),
    ).rejects.toThrow("Hostname must not include a path");
  });

  it("throws when creating an app with a hostname containing a trailing dot", async () => {
    const c = fakeClient({});
    await expect(createApp(c, "a", "app.example.com.", ["p1"])).rejects.toThrow(
      "Hostname must not have a trailing dot",
    );
  });

  it("lowercases hostname when creating an app", async () => {
    const c = fakeClient({ "POST /accounts/a/access/apps": { id: "app1" } });
    await createApp(c, "a", "App.Example.COM", ["p1"]);
    const body = c.calls[0]?.body as { domain: string };
    expect(body.domain).toBe("app.example.com");
  });

  it("throws when service token response is missing client_secret", async () => {
    const c = fakeClient({
      "POST /accounts/a/access/service_tokens": {
        id: "st1",
        client_id: "cid",
      },
    });
    await expect(createServiceToken(c, "a", "token-name")).rejects.toThrow(
      "Service token response missing client_secret",
    );
  });
});
