import { runSteps } from "@server/apps/step-sequence";
import { LOCAL_HOST_ID } from "@server/bootstrap";
import type { CloudflareClient } from "@server/cloudflare/client";
import {
  type DeprovisionDeps,
  deprovision,
  type ExposureRow,
} from "@server/cloudflare/deprovision";
import {
  type ExposeCtx,
  type ExposeDeps,
  exposeSteps,
  TunnelConfigLock,
} from "@server/cloudflare/expose";
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
  opts: { delayMs?: number } = {},
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
  const delayMs = opts.delayMs ?? 0;
  const delay = () =>
    delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();

  const client: CloudflareClient = {
    listZones: unusedMethod("listZones"),
    createTunnel: unusedMethod("createTunnel"),
    listTunnels: unusedMethod("listTunnels"),
    tunnelToken: unusedMethod("tunnelToken"),
    deleteTunnel: unusedMethod("deleteTunnel"),
    async getTunnelConfig() {
      // A real window between read and write, when `delayMs` is set — see
      // `expose.test.ts`'s `fakeClient` for why a delay on both calls (not just this one)
      // is what actually creates a race a caller's own mutex has to close, rather than
      // one that happens to pass by accident. Zero by default so every OTHER test in this
      // file (none of them exercise concurrency) is unaffected.
      await delay();
      return { ingress: ingress.map((r) => ({ ...r })) };
    },
    async putTunnelConfig(_tunnelId, config) {
      await delay();
      putTunnelConfigCalls++;
      ingress = config.ingress.map((r) => ({ ...r }));
    },
    // `createDnsRecord`/`findDnsRecord`/`createAccessApp`/`findAccessApp` are real, not
    // `unusedMethod` stubs: the mutex-coverage test below drives an actual concurrent
    // `exposeSteps` sequence against this same fake client, and those are the methods a
    // fresh expose calls that deprovision itself never does. No test that only calls
    // `deprovision` exercises them either way.
    async createDnsRecord(_zoneId, r) {
      const id = `dns-${dnsRecords.size + 1}`;
      dnsRecords.set(r.name, { id });
      return { id };
    },
    async deleteDnsRecord(_zoneId, recordId) {
      deletedDnsRecordCalls.push(recordId);
      for (const [name, record] of dnsRecords) {
        if (record.id === recordId) dnsRecords.delete(name);
      }
    },
    async findDnsRecord(_zoneId, name) {
      return dnsRecords.get(name) ?? null;
    },
    async createAccessApp(a) {
      const id = `access-${accessApps.size + 1}`;
      const aud = `aud-${id}`;
      accessApps.set(a.domain, { id, aud });
      return { id, aud };
    },
    async deleteAccessApp(appId) {
      deletedAccessAppCalls.push(appId);
      for (const [domain, a] of accessApps) {
        if (a.id === appId) accessApps.delete(domain);
      }
    },
    async findAccessApp(domain) {
      return accessApps.get(domain) ?? null;
    },
    createServiceToken: unusedMethod("createServiceToken"),
    rotateServiceToken: unusedMethod("rotateServiceToken"),
    listServiceTokens: unusedMethod("listServiceTokens"),
    deleteServiceToken: unusedMethod("deleteServiceToken"),
    createMonitorPolicy: unusedMethod("createMonitorPolicy"),
    createEmailPolicy: unusedMethod("createEmailPolicy"),
    updateEmailPolicy: unusedMethod("updateEmailPolicy"),
    getPolicy: unusedMethod("getPolicy"),
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

/** Inserts a fully "ready" exposure row plus the probe `create-probe` would have made,
 * with the exposure's `probeId` recorded exactly the way `create-probe` records it —
 * every flag defaults to `true` (everything created by Homestead), overridable per
 * test. */
async function seedExposure(
  db: Db,
  appId: string,
  overrides: Partial<ExposureRow> = {},
): Promise<ExposureRow> {
  const id = ulid();
  const probeId = ulid();
  await db.insert(probes).values({
    id: probeId,
    appId,
    kind: "http_external",
    target: `https://${HOSTNAME}`,
  });
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
    probeId,
    probeCreatedByUs: true,
    state: "ready",
    ...overrides,
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

  it("does not delete a user's own http_external probe (F1)", async () => {
    // The measured defect: the old code deleted every `http_external` probe on the app
    // by `(appId, kind)`, not by the id `create-probe` recorded. An admin's own probe —
    // created any time through `routes/probes.ts`, entirely independent of exposure —
    // matches that same pair and used to be destroyed along with it, taking its whole
    // check history along.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client } = fakeClient();
    const exposure = await seedExposure(db, appId);
    const usersOwnProbeId = ulid();
    await db.insert(probes).values({
      id: usersOwnProbeId,
      appId,
      kind: "http_external",
      target: "https://my-own-monitoring-target.example.com",
      label: "my own check",
    });

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
    // Homestead's own probe (`exposure.probeId`) is gone; the user's is not.
    const remaining = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(remaining.map((p) => p.id)).toEqual([usersOwnProbeId]);
  });

  it("leaves any probe alone when the exposure predates the probeId column", async () => {
    // A row created before this migration has `probeId: null` — nothing here is safe to
    // delete by kind (that's exactly the F1 defect), so a pre-migration exposure simply
    // leaves whatever probe rows exist on the app untouched rather than guessing.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client } = fakeClient();
    const exposure = await seedExposure(db, appId, { probeId: null, probeCreatedByUs: false });

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
    const remaining = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(remaining).toHaveLength(1);
  });
});

describe("deprovision — the Access application is gated on the route it protects (F3)", () => {
  it("refuses to remove a created Access application when both DNS and ingress are adopted", async () => {
    // The exact scenario the whole-branch review measured: an entirely ordinary
    // adoption case — DNS and ingress both predate this exposure and are never removed
    // here — paired with an Access application Homestead itself created. The old code
    // deleted the Access application anyway and then deleted the `exposures` row,
    // leaving the app fully routed, fully resolving, and completely unauthenticated with
    // no local record it had ever happened. `ok: true` must never describe that state.
    const preExisting: IngressRule = { hostname: HOSTNAME, service: "http://someone-elses:80" };
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, ingress, dnsRecords, accessApps, deletedAccessAppCalls } = fakeClient([
      preExisting,
      { service: "http_status:404" },
    ]);
    dnsRecords.set(HOSTNAME, { id: "dns-preexisting" });
    accessApps.set(HOSTNAME, { id: "access-1", aud: "aud-access-1" });
    const exposure = await seedExposure(db, appId, {
      dnsRecordId: "dns-preexisting",
      dnsRecordCreatedByUs: false,
      ingressRuleCreatedByUs: false,
    });

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failures.map((f) => f.resource)).toEqual(["access-app"]);
    }
    // Nothing that was still live got touched.
    expect(deletedAccessAppCalls).toHaveLength(0);
    expect(accessApps.get(HOSTNAME)).toEqual({ id: "access-1", aud: "aud-access-1" });
    expect(dnsRecords.get(HOSTNAME)).toEqual({ id: "dns-preexisting" });
    expect(ingress()).toEqual([preExisting, { service: "http_status:404" }]);
    // The row survives — this app is still exposed, and Homestead must not forget it.
    const [row] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    expect(row).toBeDefined();
  });

  it("removes a created Access application once BOTH legs of the route are actually coming down", async () => {
    // Contrast case: DNS is ours (removed successfully) but ingress was adopted and
    // stays. The tunnel no longer routes this hostname to the app once ingress is
    // removed and DNS no longer resolves to the tunnel — the route is down regardless of
    // ingress staying — so the Access application is safe to remove.
    const preExisting: IngressRule = { hostname: HOSTNAME, service: "http://someone-elses:80" };
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, dnsRecords, accessApps, deletedAccessAppCalls } = fakeClient([
      preExisting,
      { service: "http_status:404" },
    ]);
    dnsRecords.set(HOSTNAME, { id: "dns-1" });
    accessApps.set(HOSTNAME, { id: "access-1", aud: "aud-access-1" });
    const exposure = await seedExposure(db, appId, { ingressRuleCreatedByUs: false });

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(true);
    expect(deletedAccessAppCalls).toHaveLength(1);
    expect(accessApps.has(HOSTNAME)).toBe(false);
    expect(dnsRecords.has(HOSTNAME)).toBe(false);
    const [row] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    expect(row).toBeUndefined();
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

describe("deprovision — the ingress-rule step shares the tunnel's mutex with a concurrent expose", () => {
  it("does not clobber a concurrent expose's hostname (or vice versa)", async () => {
    // 2D's whole-branch review, F6: `deprovision.ts`'s ingress-rule step is the one
    // mutex call site with zero coverage — every OTHER test in this file constructs its
    // own private `TunnelConfigLock` per call, so nothing here has ever proven that
    // deprovision and expose, sharing the SAME instance the way `cloudflare-expose.ts`
    // wires them in production, actually serialise against each other. This drives a
    // real deprovision and a real expose concurrently against one shared lock and one
    // shared (delayed) fake tunnel, the same technique `expose.ts`'s own concurrency
    // test uses.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const otherAppId = await seedApp(db, "other-app");
    const { client, ingress } = fakeClient(
      [{ hostname: HOSTNAME, service: "http://localhost:8096" }, { service: "http_status:404" }],
      { delayMs: 15 },
    );
    const exposure = await seedExposure(db, appId);
    const lock = new TunnelConfigLock();

    const exposeDeps: ExposeDeps = {
      db,
      client,
      tunnelConfigLock: lock,
      appId: otherAppId,
      hostname: "other-app.example.com",
      zoneId: ZONE_ID,
      tunnelId: TUNNEL_ID,
      ingressService: "http://localhost:9000",
      humanPolicyId: "human-policy-1",
      monitorPolicyId: "monitor-policy-1",
    };

    const [deprovisionOutcome, exposeOutcome] = await Promise.all([
      deprovision(baseDeps(db, client, lock), exposure),
      runSteps(exposeSteps(exposeDeps), {} as ExposeCtx),
    ]);

    expect(deprovisionOutcome.ok).toBe(true);
    expect(exposeOutcome.ok).toBe(true);

    const hostnames = ingress().map((r) => r.hostname);
    // The assertion a mutex-free (or lock-after-read) `deprovision.ts` ingress step
    // fails: jellyfin's hostname must be gone, AND the concurrent expose's hostname must
    // have survived, in the SAME final array.
    expect(hostnames).not.toContain(HOSTNAME);
    expect(hostnames).toContain("other-app.example.com");
  });
});

describe("deprovision — a refusal is not a permanent dead end (defect 1)", () => {
  it("refuses once, then fully succeeds once the admin removes both legs in Cloudflare by hand and clears the row", async () => {
    // The measured defect: the previous fix set `dnsStillLive`/`ingressStillLive` to
    // `true` for any leg this call did not itself delete and never looked at Cloudflare
    // again. An admin who did exactly what the refusal told them — delete the DNS record
    // and the ingress rule in Cloudflare by hand — retried and got the IDENTICAL
    // refusal forever, because nothing here ever re-read live state for an adopted leg.
    // The fix re-reads it, so hand cleanup now actually unblocks the retry.
    const preExisting: IngressRule = { hostname: HOSTNAME, service: "http://someone-elses:80" };
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, dnsRecords, accessApps, deletedAccessAppCalls } = fakeClient([
      preExisting,
      { service: "http_status:404" },
    ]);
    dnsRecords.set(HOSTNAME, { id: "dns-preexisting" });
    accessApps.set(HOSTNAME, { id: "access-1", aud: "aud-access-1" });
    const exposure = await seedExposure(db, appId, {
      dnsRecordId: "dns-preexisting",
      dnsRecordCreatedByUs: false,
      ingressRuleCreatedByUs: false,
    });

    const first = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.failures.map((f) => f.resource)).toEqual(["access-app"]);
      // Both legs genuinely predate this exposure and are genuinely still present — the
      // message says so, not "could not be removed" (that sentence is reserved for a
      // delete THIS call attempted and failed, which never happened here).
      const message = String((first.failures[0] as { error: unknown }).error);
      expect(message).toContain("predates this exposure");
      expect(message).not.toContain("could not be removed");
    }

    // The admin does exactly what the refusal told them to, in Cloudflare, by hand.
    // Neither `*CreatedByUs` flag on the row changes — they were never Homestead's to
    // flip — so the only way a retry can notice is by re-reading Cloudflare, which is
    // exactly the fix.
    dnsRecords.delete(HOSTNAME);
    await client.putTunnelConfig(TUNNEL_ID, { ingress: [{ service: "http_status:404" }] });

    const [updated] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    if (!updated) throw new Error("row missing after the first, refused call");

    const second = await deprovision(baseDeps(db, client, new TunnelConfigLock()), updated);

    expect(second.ok).toBe(true);
    expect(deletedAccessAppCalls).toHaveLength(1);
    expect(accessApps.has(HOSTNAME)).toBe(false);
    const [row] = await db.select().from(exposures).where(eq(exposures.id, exposure.id));
    expect(row).toBeUndefined();
  });

  it("blames Cloudflare's unreachability, not 'predates this exposure', when THIS call's own delete attempts fail", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, accessApps } = fakeClient();
    accessApps.set(HOSTNAME, { id: "access-1", aud: "aud-access-1" });
    client.deleteDnsRecord = async () => {
      throw new Error("network down");
    };
    client.putTunnelConfig = async () => {
      throw new Error("network down");
    };
    // Both legs are Homestead's own (default `seedExposure` flags) — this run tries to
    // remove both and fails both, which is a different situation from either leg having
    // predated the exposure, and the refusal message must say so.
    const exposure = await seedExposure(db, appId);

    const outcome = await deprovision(baseDeps(db, client, new TunnelConfigLock()), exposure);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failures.map((f) => f.resource).sort()).toEqual([
        "access-app",
        "dns-record",
        "ingress-rule",
      ]);
      const accessFailure = outcome.failures.find((f) => f.resource === "access-app");
      const message = String(accessFailure?.error);
      expect(message).toContain("could not be removed by this call");
      expect(message).not.toContain("predates this exposure");
    }
  });
});
