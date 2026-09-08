import { expect, it } from "vitest";
import type { CloudflareClient } from "./client.js";
import {
  createTunnel,
  getIngress,
  getTunnelToken,
  type IngressRule,
  putIngress,
  upsertDnsRecord,
} from "./tunnel.js";

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
    detectTokenKind: async () => "account" as const,
    verifyToken: async () => ({ ok: true }),
    listAccounts: async () => [],
    listZones: async () => [],
    listIdentityProviders: async () => [],
  };
}

it("creates a remotely-managed tunnel", async () => {
  const c = fakeClient({ "POST /accounts/a/cfd_tunnel": { id: "t1" } });
  const r = await createTunnel(c, "a", "homestead");
  expect(r.id).toBe("t1");
  expect(c.calls[0]?.body).toMatchObject({ config_src: "cloudflare" });
});

it("reads the run token from a bare string result", async () => {
  // Cloudflare returns the run token as the result itself, not wrapped in an
  // object. Reading result.token gave undefined, which reached encrypt() and
  // died there as "data argument must be of type string" — three frames away
  // from the cause, at the last step of tunnel setup.
  const c = fakeClient({
    "GET /accounts/a/cfd_tunnel/t1/token": "eyJhIjoiYWJjIn0=",
  });
  await expect(getTunnelToken(c, "a", "t1")).resolves.toBe("eyJhIjoiYWJjIn0=");
});

it("still reads a run token wrapped in an object", async () => {
  // Defensive: the shape is undocumented enough that it was got wrong once.
  const c = fakeClient({
    "GET /accounts/a/cfd_tunnel/t1/token": { token: "wrapped-token" },
  });
  await expect(getTunnelToken(c, "a", "t1")).resolves.toBe("wrapped-token");
});

it("fails by name when the run token is missing entirely", async () => {
  // Better here, where the tunnel id is in the message, than four frames later
  // inside a cipher.
  const c = fakeClient({ "GET /accounts/a/cfd_tunnel/t1/token": null });
  await expect(getTunnelToken(c, "a", "t1")).rejects.toThrow(/t1/);
});

it("reads a freshly created tunnel as having no ingress", async () => {
  // A tunnel that has never been configured has a null configuration, not an
  // empty one. Dereferencing it made Reconcile fail with "Cannot read
  // properties of null" on exactly the tunnel Homestead had just created —
  // so the first reconcile after setup could never succeed.
  const c = fakeClient({
    "GET /accounts/a/cfd_tunnel/t1/configurations": null,
  });
  await expect(getIngress(c, "a", "t1")).resolves.toEqual([]);
});

it("reads a tunnel whose config exists but has no ingress", async () => {
  const c = fakeClient({
    "GET /accounts/a/cfd_tunnel/t1/configurations": { config: {} },
  });
  await expect(getIngress(c, "a", "t1")).resolves.toEqual([]);
});

it("still reads the ingress array when one is configured", async () => {
  // The empty cases must not be achieved by ignoring real configuration:
  // returning [] for a populated tunnel would make reconcile delete every
  // hostname on the account.
  const rules = [{ hostname: "a.example.com", service: "http://localhost:1" }];
  const c = fakeClient({
    "GET /accounts/a/cfd_tunnel/t1/configurations": {
      config: { ingress: rules },
    },
  });
  await expect(getIngress(c, "a", "t1")).resolves.toEqual(rules);
});

it("always ends the ingress array with a catch-all", async () => {
  // cloudflared rejects a configuration whose last rule is not a catch-all.
  const c = fakeClient({});
  await putIngress(c, "a", "t1", [
    { hostname: "app.example.com", service: "http://localhost:8080" },
  ]);
  const sent = c.calls[0]?.body as { config: { ingress: IngressRule[] } };
  expect(sent.config.ingress.at(-1)).toEqual({ service: "http_status:404" });
});

it("does not add a second catch-all when one is already present", async () => {
  const c = fakeClient({});
  await putIngress(c, "a", "t1", [
    { hostname: "a.example.com", service: "http://localhost:1" },
    { service: "http_status:404" },
  ]);
  const sent = c.calls[0]?.body as { config: { ingress: IngressRule[] } };
  expect(sent.config.ingress.filter((r) => !r.hostname)).toHaveLength(1);
});

it("passes noTLSVerify through for a self-signed origin", async () => {
  const c = fakeClient({});
  await putIngress(c, "a", "t1", [
    {
      hostname: "unifi.example.com",
      service: "https://localhost:8443",
      originRequest: { noTLSVerify: true },
    },
  ]);
  const sent = c.calls[0]?.body as { config: { ingress: IngressRule[] } };
  expect(sent.config.ingress[0]?.originRequest).toEqual({ noTLSVerify: true });
});

it("points the DNS record at the tunnel and proxies it", async () => {
  const c = fakeClient({ "GET /zones/z1/dns_records": [] });
  await upsertDnsRecord(c, "z1", "app.example.com", "t1");
  const post = c.calls.find((k) => k.method === "POST");
  expect(post?.body).toMatchObject({
    type: "CNAME",
    name: "app.example.com",
    content: "t1.cfargotunnel.com",
    proxied: true,
  });
});

it("updates an existing CNAME pointing at our tunnel (idempotent)", async () => {
  const c = fakeClient({
    "GET /zones/z1/dns_records": [
      {
        id: "r1",
        name: "app.example.com",
        type: "CNAME",
        content: "t1.cfargotunnel.com",
      },
    ],
  });
  await upsertDnsRecord(c, "z1", "app.example.com", "t1");
  expect(c.calls.some((k) => k.method === "POST")).toBe(false);
  expect(c.calls.some((k) => k.method === "PATCH")).toBe(true);
});

it("refuses to overwrite an A record with a CNAME", async () => {
  const c = fakeClient({
    "GET /zones/z1/dns_records": [
      { id: "r1", name: "app.example.com", type: "A", content: "192.0.2.1" },
    ],
  });
  await expect(
    upsertDnsRecord(c, "z1", "app.example.com", "t1"),
  ).rejects.toThrow(/conflict.*app\.example\.com.*type A.*192\.0\.2\.1/i);
});

it("refuses to overwrite a CNAME pointing elsewhere", async () => {
  const c = fakeClient({
    "GET /zones/z1/dns_records": [
      {
        id: "r1",
        name: "app.example.com",
        type: "CNAME",
        content: "other.example.com",
      },
    ],
  });
  await expect(
    upsertDnsRecord(c, "z1", "app.example.com", "t1"),
  ).rejects.toThrow(/conflict.*app\.example\.com.*CNAME.*other\.example\.com/i);
});

it("refuses when multiple records exist for the hostname", async () => {
  const c = fakeClient({
    "GET /zones/z1/dns_records": [
      { id: "r1", name: "app.example.com", type: "A", content: "192.0.2.1" },
      {
        id: "r2",
        name: "app.example.com",
        type: "AAAA",
        content: "2001:db8::1",
      },
    ],
  });
  await expect(
    upsertDnsRecord(c, "z1", "app.example.com", "t1"),
  ).rejects.toThrow(/conflict.*app\.example\.com/i);
});

it("emits a lone catch-all when the input array is empty", async () => {
  const c = fakeClient({});
  await putIngress(c, "a", "t1", []);
  const sent = c.calls[0]?.body as { config: { ingress: IngressRule[] } };
  expect(sent.config.ingress).toEqual([{ service: "http_status:404" }]);
});

it("removes catch-alls from the middle and keeps exactly one at the end", async () => {
  const c = fakeClient({});
  await putIngress(c, "a", "t1", [
    { hostname: "a.example.com", service: "http://localhost:1" },
    { service: "http_status:404" },
    { hostname: "b.example.com", service: "http://localhost:2" },
  ]);
  const sent = c.calls[0]?.body as { config: { ingress: IngressRule[] } };
  expect(sent.config.ingress.filter((r) => !r.hostname)).toHaveLength(1);
  expect(sent.config.ingress.at(-1)).toEqual({ service: "http_status:404" });
  expect(sent.config.ingress).toHaveLength(3); // Two hostnames + one catch-all
});
