import { MonitorAccessStore } from "@server/cloudflare/monitor-access";
import { SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { buildHttpRunners } from "@server/monitoring/build-runners";
import type { ProbeContext, ProbeRow } from "@server/monitoring/types";
import { describe, expect, it } from "vitest";

const KEY = Buffer.alloc(32, 7);
const ctx = {} as ProbeContext;

const probe = (over: Partial<ProbeRow> = {}): ProbeRow =>
  ({
    id: "p1",
    appId: "a1",
    kind: "http_external",
    target: "https://jellyfin.example.com",
    expectedStatusPattern: "2xx,3xx",
    timeoutMs: 5000,
    insecureTls: false,
    followRedirects: false,
    ...over,
  }) as ProbeRow;

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

async function setup() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  const secrets = new SecretStore(db, KEY);
  const monitorStore = new MonitorAccessStore(db, secrets);
  return { db, secrets, monitorStore };
}

describe("buildHttpRunners", () => {
  it("reports degraded/config, naming the missing configuration, when no monitor access exists", async () => {
    // This is the exact defect the wiring closes: startup.ts never passing a callback
    // meant this branch was permanently unreachable in production. Wired but unset is a
    // different — and correct — outcome from wired and configured.
    const { db, secrets } = await setup();
    const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
    const runners = buildHttpRunners({ fetch: impl, db, secrets });

    const result = await runners.external.run(probe(), ctx);

    expect(result).toMatchObject({
      status: "degraded",
      faultClass: "config",
      detail: { error: "no Access service token configured" },
    });
  });

  it("sends the exact credentials on record as the Access headers", async () => {
    const { db, secrets, monitorStore } = await setup();
    await monitorStore.set(
      { tokenId: "token-1", clientId: "the-client-id", policyId: "policy-1", expiresAt: null },
      "the-client-secret",
    );
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const runners = buildHttpRunners({ fetch: impl, db, secrets });

    const result = await runners.external.run(probe(), ctx);

    expect(result.status).toBe("up");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["cf-access-client-id"]).toBe("the-client-id");
    expect(headers["cf-access-client-secret"]).toBe("the-client-secret");
  });

  it("picks up a rotated secret on the very next run, without rebuilding the runner", async () => {
    // The obvious wrong implementation captures credentials once, in a closure, at
    // construction. That passes every test that only runs one probe. This test runs
    // the SAME runners object twice, rotating the store in between, so a closure over
    // a stale value fails it while a per-call read passes.
    const { db, secrets, monitorStore } = await setup();
    await monitorStore.set(
      { tokenId: "token-1", clientId: "client-old", policyId: "policy-1", expiresAt: null },
      "secret-old",
    );
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const runners = buildHttpRunners({ fetch: impl, db, secrets });

    await runners.external.run(probe(), ctx);
    const firstHeaders = calls[0]?.init?.headers as Record<string, string>;
    expect(firstHeaders["cf-access-client-secret"]).toBe("secret-old");

    await monitorStore.set(
      { tokenId: "token-1", clientId: "client-new", policyId: "policy-1", expiresAt: null },
      "secret-new",
    );
    await runners.external.run(probe(), ctx);
    const secondHeaders = calls[1]?.init?.headers as Record<string, string>;
    expect(secondHeaders["cf-access-client-id"]).toBe("client-new");
    expect(secondHeaders["cf-access-client-secret"]).toBe("secret-new");
  });

  it("never leaks the secret into the probe result", async () => {
    const { db, secrets, monitorStore } = await setup();
    await monitorStore.set(
      { tokenId: "token-1", clientId: "the-client-id", policyId: "policy-1", expiresAt: null },
      "super-secret-value",
    );
    const { impl } = fakeFetch(() => new Response(null, { status: 500 }));
    const runners = buildHttpRunners({ fetch: impl, db, secrets });

    const result = await runners.external.run(probe(), ctx);

    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });
});
