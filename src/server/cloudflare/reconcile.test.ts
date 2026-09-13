import { LOCAL_HOST_ID } from "@server/bootstrap";
import type { CloudflareClient } from "@server/cloudflare/client";
import {
  checkExposureDrift,
  parseDriftFindings,
  reconcileExposures,
} from "@server/cloudflare/reconcile";
import type { Db } from "@server/db/client";
import { createDb, runMigrations } from "@server/db/client";
import { apps, exposures, hosts } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";

/**
 * Every method a `vi.fn`, so a test can assert `expect(client.createDnsRecord).not
 * .toHaveBeenCalled()` directly rather than relying on a thrown error to notice a write
 * slipped through — the shape the "never writes" tests below need. Write methods default
 * to rejecting (the same "fails loudly, not silently returns undefined" idiom
 * `expose.test.ts`'s `unusedMethod` uses) since nothing in `reconcile.ts` should ever
 * reach one; the three read methods this module actually calls default to "everything
 * matches, no drift" so a test overrides only the one thing it means to break.
 */
function fakeClient(overrides: Partial<CloudflareClient> = {}): CloudflareClient {
  function unusedWrite(name: string) {
    return vi.fn(async () => {
      throw new Error(`${name} is a Cloudflare write method — reconcile must never call it`);
    });
  }
  function unusedRead(name: string) {
    return vi.fn(async () => {
      throw new Error(`${name} is not used by reconcile`);
    });
  }
  return {
    listZones: unusedRead("listZones"),
    createTunnel: unusedWrite("createTunnel"),
    listTunnels: unusedRead("listTunnels"),
    tunnelToken: unusedRead("tunnelToken"),
    deleteTunnel: unusedWrite("deleteTunnel"),
    getTunnelConfig: vi.fn(async () => ({
      ingress: [{ hostname: "app.example.com", service: "http://localhost:8096" }],
    })),
    putTunnelConfig: unusedWrite("putTunnelConfig"),
    createDnsRecord: unusedWrite("createDnsRecord"),
    deleteDnsRecord: unusedWrite("deleteDnsRecord"),
    findDnsRecord: vi.fn(async () => ({ id: "dns-1" })),
    createAccessApp: unusedWrite("createAccessApp"),
    deleteAccessApp: unusedWrite("deleteAccessApp"),
    findAccessApp: vi.fn(async () => ({ id: "access-1", aud: "aud-1" })),
    createServiceToken: unusedWrite("createServiceToken"),
    rotateServiceToken: unusedWrite("rotateServiceToken"),
    listServiceTokens: unusedRead("listServiceTokens"),
    deleteServiceToken: unusedWrite("deleteServiceToken"),
    createMonitorPolicy: unusedWrite("createMonitorPolicy"),
    ...overrides,
  };
}

/** Every `CloudflareClient` method this module could ever be tempted to call to "fix"
 * what it finds — asserted un-called after every scenario below, including the ones
 * where every single check finds something wrong. This list, not a handful of the more
 * obvious ones, is the actual binding check for §6's "flags, never corrects" rule. */
function writeMethods(client: CloudflareClient) {
  return [
    client.createTunnel,
    client.deleteTunnel,
    client.putTunnelConfig,
    client.createDnsRecord,
    client.deleteDnsRecord,
    client.createAccessApp,
    client.deleteAccessApp,
    client.createServiceToken,
    client.rotateServiceToken,
    client.deleteServiceToken,
    client.createMonitorPolicy,
  ];
}

function expectNoWrites(client: CloudflareClient) {
  for (const method of writeMethods(client)) {
    expect(method).not.toHaveBeenCalled();
  }
}

async function seedDb(): Promise<Db> {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({
    id: LOCAL_HOST_ID,
    name: "local",
    composeRoot: "/v",
    dockerSocket: "/s",
  });
  return db;
}

async function seedApp(db: Db, slug: string): Promise<string> {
  const id = ulid();
  await db.insert(apps).values({
    id,
    hostId: LOCAL_HOST_ID,
    slug,
    displayName: slug,
    directory: slug,
    composeFile: "compose.yaml",
    projectName: slug,
  });
  return id;
}

/** A fully-provisioned exposure — the state every real row is in once `expose.ts`'s
 * sequence finishes — matching exactly what the default `fakeClient` above reports, so a
 * test only has to override the one client method it means to disagree with. `hostname`
 * defaults to the same value `fakeClient`'s defaults reference; a test exposing a second
 * app must override it (and, if it cares about isolation, the client's own responses). */
async function seedExposure(
  db: Db,
  appId: string,
  overrides: Partial<typeof exposures.$inferInsert> = {},
): Promise<typeof exposures.$inferSelect> {
  const id = ulid();
  await db.insert(exposures).values({
    id,
    appId,
    hostname: "app.example.com",
    zoneId: "zone-1",
    tunnelId: "tunnel-1",
    ingressService: "http://localhost:8096",
    accessAppId: "access-1",
    accessAppAud: "aud-1",
    state: "ready",
    ...overrides,
  });
  const [row] = await db.select().from(exposures).where(eq(exposures.id, id));
  if (!row) throw new Error("seedExposure: row not found after insert");
  return row;
}

describe("checkExposureDrift", () => {
  it("reports nothing when Cloudflare agrees with the recorded exposure", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId);
    const client = fakeClient();

    await expect(checkExposureDrift(client, exposure)).resolves.toEqual([]);
  });

  it("flags a missing DNS record without recreating it", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId);
    const client = fakeClient({ findDnsRecord: vi.fn(async () => null) });

    const findings = await checkExposureDrift(client, exposure);

    expect(findings).toEqual([
      { kind: "dns_record_missing", message: expect.stringContaining("app.example.com") },
    ]);
    expectNoWrites(client);
  });

  it("flags an ingress rule missing from the tunnel config", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId);
    const client = fakeClient({ getTunnelConfig: vi.fn(async () => ({ ingress: [] })) });

    const findings = await checkExposureDrift(client, exposure);

    expect(findings).toEqual([
      { kind: "ingress_rule_missing", message: expect.stringContaining("app.example.com") },
    ]);
    expectNoWrites(client);
  });

  it("flags a hostname routed to a different service than recorded", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId);
    const client = fakeClient({
      getTunnelConfig: vi.fn(async () => ({
        ingress: [{ hostname: "app.example.com", service: "http://localhost:9999" }],
      })),
    });

    const findings = await checkExposureDrift(client, exposure);

    expect(findings).toEqual([
      {
        kind: "ingress_service_mismatch",
        message: expect.stringMatching(/localhost:9999.*localhost:8096/),
      },
    ]);
    expectNoWrites(client);
  });

  it("flags a deleted Access application — the finding that matters most", async () => {
    // §6: this is the one that means a hostname is routed and no longer protected, not
    // just recorded slightly wrong.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId);
    const client = fakeClient({ findAccessApp: vi.fn(async () => null) });

    const findings = await checkExposureDrift(client, exposure);

    expect(findings).toEqual([
      {
        kind: "access_app_deleted",
        message: expect.stringContaining("no longer requires sign-in"),
      },
    ]);
    expectNoWrites(client);
  });

  it("reports every applicable finding at once, not just the first", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId);
    const client = fakeClient({
      findDnsRecord: vi.fn(async () => null),
      getTunnelConfig: vi.fn(async () => ({ ingress: [] })),
      findAccessApp: vi.fn(async () => null),
    });

    const findings = await checkExposureDrift(client, exposure);

    expect(findings.map((f) => f.kind).sort()).toEqual(
      ["access_app_deleted", "dns_record_missing", "ingress_rule_missing"].sort(),
    );
    expectNoWrites(client);
  });

  it("never calls any Cloudflare write method, even when every check finds drift", async () => {
    // The binding check for §6's whole design decision: a well-meaning "just recreate the
    // missing record" fix is exactly one line away, and this is what would catch it.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId);
    const client = fakeClient({
      findDnsRecord: vi.fn(async () => null),
      getTunnelConfig: vi.fn(async () => ({
        ingress: [{ hostname: "app.example.com", service: "http://localhost:9999" }],
      })),
      findAccessApp: vi.fn(async () => null),
    });

    await checkExposureDrift(client, exposure);

    expectNoWrites(client);
  });
});

describe("reconcileExposures", () => {
  it("records drift onto the exposure row: state flips to drifted, lastError carries the findings", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId);
    const client = fakeClient({ findDnsRecord: vi.fn(async () => null) });

    const outcomes = await reconcileExposures({ db, client });

    expect(outcomes).toEqual([
      {
        exposureId: exposure.id,
        appId,
        hostname: "app.example.com",
        findings: [{ kind: "dns_record_missing", message: expect.any(String) }],
      },
    ]);

    const [row] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    expect(row?.state).toBe("drifted");
    expect(parseDriftFindings(row?.lastError ?? null)).toEqual([
      { kind: "dns_record_missing", message: expect.any(String) },
    ]);
    expect(row?.lastSyncedAt).not.toBeNull();
  });

  it("clears drift and returns to ready once Cloudflare state is fixed", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const exposure = await seedExposure(db, appId, {
      state: "drifted",
      lastError: JSON.stringify([{ kind: "dns_record_missing", message: "was missing" }]),
    });
    const client = fakeClient();

    await reconcileExposures({ db, client });

    const [row] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    expect(row?.state).toBe("ready");
    expect(row?.lastError).toBeNull();
  });

  it("never calls any Cloudflare write method", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    await seedExposure(db, appId);
    const client = fakeClient({
      findDnsRecord: vi.fn(async () => null),
      getTunnelConfig: vi.fn(async () => ({ ingress: [] })),
      findAccessApp: vi.fn(async () => null),
    });

    await reconcileExposures({ db, client });

    expectNoWrites(client);
  });

  it("checks only ready and drifted exposures — never one still provisioning or already errored", async () => {
    const db = await seedDb();
    const provisioningApp = await seedApp(db, "provisioning-app");
    const errorApp = await seedApp(db, "error-app");
    await seedExposure(db, provisioningApp, {
      hostname: "provisioning.example.com",
      state: "provisioning",
    });
    await seedExposure(db, errorApp, { hostname: "error.example.com", state: "error" });
    const client = fakeClient();

    const outcomes = await reconcileExposures({ db, client });

    expect(outcomes).toEqual([]);
    expect(client.findDnsRecord).not.toHaveBeenCalled();
    expect(client.getTunnelConfig).not.toHaveBeenCalled();
    expect(client.findAccessApp).not.toHaveBeenCalled();
  });

  it("drift on one exposure does not stop the others being checked", async () => {
    const db = await seedDb();
    const brokenApp = await seedApp(db, "broken-app");
    const healthyApp = await seedApp(db, "healthy-app");
    const broken = await seedExposure(db, brokenApp, { hostname: "broken.example.com" });
    const healthy = await seedExposure(db, healthyApp, { hostname: "healthy.example.com" });

    const client = fakeClient({
      findDnsRecord: vi.fn(async (_zoneId: string, name: string) => {
        if (name === "broken.example.com") throw new Error("Cloudflare timed out");
        return { id: "dns-1" };
      }),
      getTunnelConfig: vi.fn(async () => ({
        ingress: [
          { hostname: "broken.example.com", service: "http://localhost:8096" },
          { hostname: "healthy.example.com", service: "http://localhost:8096" },
        ],
      })),
    });

    const outcomes = await reconcileExposures({ db, client });

    expect(outcomes).toHaveLength(2);
    const brokenOutcome = outcomes.find((o) => o.exposureId === broken.id);
    const healthyOutcome = outcomes.find((o) => o.exposureId === healthy.id);
    expect(brokenOutcome?.findings).toEqual([
      { kind: "check_failed", message: expect.stringContaining("Cloudflare timed out") },
    ]);
    // The failure on the first exposure did not prevent the second from being checked
    // and correctly found clean.
    expect(healthyOutcome?.findings).toEqual([]);

    const [brokenRow] = await db.select().from(exposures).where(eq(exposures.id, broken.id));
    const [healthyRow] = await db.select().from(exposures).where(eq(exposures.id, healthy.id));
    expect(brokenRow?.state).toBe("drifted");
    expect(healthyRow?.state).toBe("ready");
    expectNoWrites(client);
  });
});

describe("parseDriftFindings", () => {
  it("parses a valid findings array", () => {
    const raw = JSON.stringify([{ kind: "dns_record_missing", message: "gone" }]);
    expect(parseDriftFindings(raw)).toEqual([{ kind: "dns_record_missing", message: "gone" }]);
  });

  it("degrades to an empty array for null", () => {
    expect(parseDriftFindings(null)).toEqual([]);
  });

  it("degrades to an empty array for invalid JSON rather than throwing", () => {
    expect(parseDriftFindings("not-json")).toEqual([]);
  });

  it("degrades to an empty array for JSON that isn't an array", () => {
    expect(parseDriftFindings(JSON.stringify({ kind: "dns_record_missing" }))).toEqual([]);
  });

  it("drops entries missing kind or message rather than passing them through", () => {
    const raw = JSON.stringify([
      { kind: "dns_record_missing", message: "gone" },
      { kind: "dns_record_missing" },
      "just a string",
      null,
    ]);
    expect(parseDriftFindings(raw)).toEqual([{ kind: "dns_record_missing", message: "gone" }]);
  });
});
