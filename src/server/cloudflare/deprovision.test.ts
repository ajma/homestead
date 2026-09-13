import { LOCAL_HOST_ID } from "@server/bootstrap";
import type { CloudflareClient } from "@server/cloudflare/client";
import {
  type DeprovisionDeps,
  deprovision,
  type ExposureRow,
} from "@server/cloudflare/deprovision";
import { TunnelConfigLock } from "@server/cloudflare/expose";
import type { Db } from "@server/db/client";
import { createDb, runMigrations } from "@server/db/client";
import { apps, exposures, hosts, probes } from "@server/db/schema";
import type { IngressRule } from "@shared/cloudflare.js";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const TUNNEL_ID = "tunnel-1";
const ZONE_ID = "zone-1";
const HOSTNAME = "jellyfin.example.com";

/** Not used by any test in this file, but required by the `CloudflareClient` type — every
 * method throws so an accidental call fails loudly. Same idiom `expose.test.ts` uses. */
function unusedMethod(name: string) {
  return async () => {
    throw new Error(`${name} is not used by deprovision tests`);
  };
}

/**
 * A hand-written `CloudflareClient` double — same reasoning `expose.test.ts`'s `fakeClient`
 * gives: this file tests `deprovision`'s composition against the client's INTERFACE, not
 * the wire format. No test here makes a network call.
 *
 * Delete methods here are idempotent the same way the real client documents them
 * (client.ts): deleting an id/hostname not present resolves rather than throwing, so a
 * test proving "already gone is not an error" can call this fake exactly like the real
 * thing would behave against a 404.
 */
function fakeClient(
  initialIngress: IngressRule[] = [
    { hostname: HOSTNAME, service: "http://localhost:8096" },
    { service: "http_status:404" },
  ],
): {
  client: CloudflareClient;
  ingress: () => IngressRule[];
  dnsRecords: Map<string, { id: string }>;
  deletedDnsRecordCalls: string[];
  accessApps: Map<string, { id: string; aud: string }>;
  deletedAccessAppCalls: string[];
  putTunnelConfigCalls: number;
} {
  let ingress: IngressRule[] = initialIngress;
  const dnsRecords = new Map<string, { id: string }>();
  const accessApps = new Map<string, { id: string; aud: string }>();
  const deletedDnsRecordCalls: string[] = [];
  const deletedAccessAppCalls: string[] = [];
  let putTunnelConfigCalls = 0;

  const client: CloudflareClient = {
    listZones: unusedMethod("listZones"),
    createTunnel: unusedMethod("createTunnel"),
    listTunnels: unusedMethod("listTunnels"),
    tunnelToken: unusedMethod("tunnelToken"),
    deleteTunnel: unusedMethod("deleteTunnel"),
    async getTunnelConfig() {
      return { ingress: ingress.map((r) => ({ ...r })) };
    },
    async putTunnelConfig(_tunnelId, config) {
      putTunnelConfigCalls++;
      ingress = config.ingress.map((r) => ({ ...r }));
    },
    createDnsRecord: unusedMethod("createDnsRecord"),
    async deleteDnsRecord(_zoneId, recordId) {
      deletedDnsRecordCalls.push(recordId);
      for (const [name, record] of dnsRecords) {
        if (record.id === recordId) dnsRecords.delete(name);
      }
    },
    findDnsRecord: unusedMethod("findDnsRecord"),
    createAccessApp: unusedMethod("createAccessApp"),
    async deleteAccessApp(appId) {
      deletedAccessAppCalls.push(appId);
      for (const [domain, a] of accessApps) {
        if (a.id === appId) accessApps.delete(domain);
      }
    },
    findAccessApp: unusedMethod("findAccessApp"),
    createServiceToken: unusedMethod("createServiceToken"),
    rotateServiceToken: unusedMethod("rotateServiceToken"),
    listServiceTokens: unusedMethod("listServiceTokens"),
    deleteServiceToken: unusedMethod("deleteServiceToken"),
    createMonitorPolicy: unusedMethod("createMonitorPolicy"),
  };

  return {
    client,
    ingress: () => ingress,
    dnsRecords,
    deletedDnsRecordCalls,
    accessApps,
    deletedAccessAppCalls,
    get putTunnelConfigCalls() {
      return putTunnelConfigCalls;
    },
  };
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

/** Inserts a fully "ready" exposure row plus the probe `create-probe` would have made —
 * every flag defaults to `true` (everything created by Homestead), overridable per test. */
async function seedExposure(
  db: Db,
  appId: string,
  overrides: Partial<ExposureRow> = {},
): Promise<ExposureRow> {
  const id = ulid();
  await db.insert(exposures).values({
    id,
    appId,
    hostname: HOSTNAME,
    zoneId: ZONE_ID,
    tunnelId: TUNNEL_ID,
    ingressService: "http://localhost:8096",
    dnsRecordId: "dns-1",
    dnsRecordCreatedByUs: true,
    accessAppId: "access-1",
    accessAppAud: "aud-access-1",
    accessAppCreatedByUs: true,
    ingressRuleCreatedByUs: true,
    state: "ready",
    ...overrides,
  });
  await db.insert(probes).values({
    id: ulid(),
    appId,
    kind: "http_external",
    target: `https://${HOSTNAME}`,
  });
  const [row] = await db.select().from(exposures).where(eq(exposures.id, id));
  if (!row) throw new Error("seedExposure: row not found after insert");
  return row;
}

function baseDeps(
  db: Db,
  client: CloudflareClient,
  tunnelConfigLock: TunnelConfigLock,
): DeprovisionDeps {
  return { db, client, tunnelConfigLock };
}

describe("deprovision — happy path", () => {
  it("removes all four resources and deletes the exposures row", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, ingress, dnsRecords, accessApps } = fakeClient();
    dnsRecords.set(HOSTNAME, { id: "dns-1" });
    accessApps.set(HOSTNAME, { id: "access-1", aud: "aud-access-1" });
    const exposure = await seedExposure(db, appId);

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
    expect(dnsRecords.has(HOSTNAME)).toBe(false);
    expect(accessApps.has(HOSTNAME)).toBe(false);
    expect(ingress()).toEqual([{ service: "http_status:404" }]);

    const [row] = await db.select().from(exposures).where(eq(exposures.appId, appId));
    expect(row).toBeUndefined();

    const probeRows = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRows).toHaveLength(0);
  });

  it("a resource already gone in Cloudflare is not an error", async () => {
    // Neither `dnsRecords` nor `accessApps` is seeded with an entry for this hostname —
    // the fake's delete methods are idempotent, same as the real client's documented
    // behaviour (client.ts), so deleting an id that is not there must not raise.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client } = fakeClient();
    const exposure = await seedExposure(db, appId);

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
    const [row] = await db.select().from(exposures).where(eq(exposures.appId, appId));
    expect(row).toBeUndefined();
  });

  it("succeeds even if the probe row was already gone", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client } = fakeClient();
    const exposure = await seedExposure(db, appId);
    await db.delete(probes).where(eq(probes.appId, appId));

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
  });
});

describe("deprovision — every *CreatedByUs: false resource is left alone", () => {
  it("does not delete an adopted Access application", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, accessApps, deletedAccessAppCalls } = fakeClient();
    accessApps.set(HOSTNAME, { id: "access-preexisting", aud: "aud-preexisting" });
    const exposure = await seedExposure(db, appId, {
      accessAppId: "access-preexisting",
      accessAppAud: "aud-preexisting",
      accessAppCreatedByUs: false,
    });

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
    expect(accessApps.get(HOSTNAME)).toEqual({ id: "access-preexisting", aud: "aud-preexisting" });
    expect(deletedAccessAppCalls).toHaveLength(0);
  });

  it("does not delete an adopted DNS record", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, dnsRecords, deletedDnsRecordCalls } = fakeClient();
    dnsRecords.set(HOSTNAME, { id: "dns-preexisting" });
    const exposure = await seedExposure(db, appId, {
      dnsRecordId: "dns-preexisting",
      dnsRecordCreatedByUs: false,
    });

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
    expect(dnsRecords.get(HOSTNAME)).toEqual({ id: "dns-preexisting" });
    expect(deletedDnsRecordCalls).toHaveLength(0);
  });

  it("does not touch an adopted ingress rule", async () => {
    const preExisting: IngressRule = {
      hostname: HOSTNAME,
      service: "http://someone-elses-service:80",
    };
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, ingress } = fakeClient([preExisting, { service: "http_status:404" }]);
    const exposure = await seedExposure(db, appId, { ingressRuleCreatedByUs: false });

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
    // Left EXACTLY as it was found — deprovision never calls `getTunnelConfig`/
    // `putTunnelConfig` at all for this hostname when the flag is false (see
    // `deprovision.ts`'s own doc comment on why it cannot restore a TRUE original here,
    // only ever refuse to touch what is currently there).
    expect(ingress()).toEqual([preExisting, { service: "http_status:404" }]);
  });
});

describe("deprovision — the exposures row is deleted last", () => {
  it("leaves the row in place, with only the flags for what succeeded flipped, on a partial failure", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, dnsRecords, accessApps, ingress } = fakeClient();
    dnsRecords.set(HOSTNAME, { id: "dns-1" });
    accessApps.set(HOSTNAME, { id: "access-1", aud: "aud-access-1" });
    client.deleteDnsRecord = async () => {
      throw new Error("dns delete boom");
    };
    const exposure = await seedExposure(db, appId);

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failures.map((f) => f.resource)).toEqual(["dns-record"]);
    }

    // The row survives — deleting it first, then hitting this failure, would have
    // stranded the still-live DNS record with no local trace of it.
    const [row] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    expect(row).toBeDefined();
    // What DID succeed is recorded: the probe is gone, the Access app's flag flipped to
    // false, the ingress rule's flag flipped to false (it runs independently of the DNS
    // step and is not blocked by its failure). What FAILED keeps its flag `true`, so a
    // retry knows to try it again rather than silently skip it.
    expect(row).toMatchObject({
      accessAppCreatedByUs: false,
      dnsRecordCreatedByUs: true,
      ingressRuleCreatedByUs: false,
    });
    expect(accessApps.has(HOSTNAME)).toBe(false);
    expect(ingress()).toEqual([{ service: "http_status:404" }]);

    const probeRows = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRows).toHaveLength(0);
  });

  it("a retry against the updated row neither re-deletes what is gone nor skips what is not", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, dnsRecords, accessApps, deletedAccessAppCalls } = fakeClient();
    dnsRecords.set(HOSTNAME, { id: "dns-1" });
    accessApps.set(HOSTNAME, { id: "access-1", aud: "aud-access-1" });
    let dnsShouldFail = true;
    client.deleteDnsRecord = async (zoneId, recordId) => {
      if (dnsShouldFail) throw new Error("dns delete boom");
      dnsRecords.delete(HOSTNAME);
      void zoneId;
      void recordId;
    };
    const exposure = await seedExposure(db, appId);

    const first = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);
    expect(first.ok).toBe(false);

    // The Access app is already gone and its flag already false — a retry must not call
    // `deleteAccessApp` again.
    dnsShouldFail = false;
    const [updated] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    if (!updated) throw new Error("row missing after partial failure");

    const second = await deprovision(baseDeps(db, client, new TunnelConfigLock()), updated);

    expect(second.ok).toBe(true);
    expect(deletedAccessAppCalls).toHaveLength(1);
    expect(dnsRecords.has(HOSTNAME)).toBe(false);
    const [row] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    expect(row).toBeUndefined();
  });
});
