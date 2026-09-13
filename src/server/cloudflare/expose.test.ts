import type { Step } from "@server/apps/step-sequence";
import { runSteps } from "@server/apps/step-sequence";
import { ACCESS_TEAM_DOMAIN_SETTING_KEY } from "@server/auth/access-settings";
import { LOCAL_HOST_ID } from "@server/bootstrap";
import type { CloudflareClient } from "@server/cloudflare/client";
import {
  type ExposeCtx,
  type ExposeDeps,
  exposeSteps,
  ProbeTargetConflictError,
  TunnelConfigLock,
} from "@server/cloudflare/expose";
import type { Db } from "@server/db/client";
import { createDb, runMigrations } from "@server/db/client";
import { apps, exposures, hosts, probes, settings } from "@server/db/schema";
import type { IngressRule } from "@shared/cloudflare.js";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

/** Not used by any test in this file, but required by the `CloudflareClient` type —
 * every method throws so a test that accidentally exercises one fails loudly rather than
 * silently returning `undefined`. Same idiom `monitor-access.test.ts` uses. */
function unusedMethod(name: string) {
  return async () => {
    throw new Error(`${name} is not used by expose tests`);
  };
}

/**
 * A hand-written `CloudflareClient` double, not a mocked `fetch` — same reasoning
 * `provision-tunnel.test.ts` gives: this file tests `exposeSteps`' composition against the
 * client's INTERFACE, not the wire format (`client.test.ts` already covers that
 * exhaustively). No test here makes a network call.
 *
 * `getTunnelConfig` yields to the event loop (`setImmediate`) before answering — real
 * latency a real HTTP round trip would have anyway. Without it, two concurrent callers'
 * reads could coincidentally never overlap on a fast in-process fake, making the
 * concurrency test pass by accident regardless of whether the caller's mutex is correct.
 * With it, and WITHOUT a caller-side mutex, two overlapping calls are near-certain to both
 * observe the same stale snapshot before either writes back — which is precisely the
 * read-modify-write race §6 names as a correctness bug. A caller that correctly locks
 * around both the read and the write is unaffected either way: the second caller's whole
 * locked section, read included, does not even START until the first's has finished.
 */
function fakeClient(initialIngress: IngressRule[] = [{ service: "http_status:404" }]): {
  client: CloudflareClient;
  ingress: () => IngressRule[];
  dnsRecords: Map<string, { id: string }>;
  deletedDnsRecords: string[];
  accessApps: Map<string, { id: string; aud: string }>;
  deletedAccessApps: string[];
  createAccessAppCalls: Array<{ domain: string; name: string; policyIds: string[] }>;
} {
  let ingress: IngressRule[] = initialIngress;
  const dnsRecords = new Map<string, { id: string }>();
  const deletedDnsRecords: string[] = [];
  const accessApps = new Map<string, { id: string; aud: string }>();
  const deletedAccessApps: string[] = [];
  const createAccessAppCalls: Array<{ domain: string; name: string; policyIds: string[] }> = [];
  let nextId = 1;

  const client: CloudflareClient = {
    listZones: unusedMethod("listZones"),
    createTunnel: unusedMethod("createTunnel"),
    listTunnels: unusedMethod("listTunnels"),
    tunnelToken: unusedMethod("tunnelToken"),
    deleteTunnel: unusedMethod("deleteTunnel"),
    async getTunnelConfig() {
      // A real timer on BOTH `getTunnelConfig` and `putTunnelConfig` below — not so the
      // two calls merely take some time, but so there is a real window BETWEEN one
      // caller's read and that SAME caller's write, wide enough for another caller's read
      // to land inside it regardless of which of the two started first. A delay on
      // `getTunnelConfig` alone does not do this: without a matching delay before the
      // write actually commits, one caller's read-compute-write happens as one
      // uninterrupted synchronous burst the instant its own timer fires, so a caller that
      // starts even slightly later than the other only ever observes the FIRST caller's
      // already-completed write and never overlaps it — a mutex-free implementation would
      // pass this test by accident. A caller that correctly locks around both calls is
      // unaffected either way: its whole locked section, read AND write, still runs to
      // completion before any other caller's locked section can start.
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { ingress: ingress.map((r) => ({ ...r })) };
    },
    async putTunnelConfig(_tunnelId, config) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      ingress = config.ingress.map((r) => ({ ...r }));
    },
    async createDnsRecord(_zoneId, r) {
      const id = `dns-${nextId++}`;
      dnsRecords.set(r.name, { id });
      return { id };
    },
    async deleteDnsRecord(_zoneId, recordId) {
      deletedDnsRecords.push(recordId);
      for (const [name, record] of dnsRecords) {
        if (record.id === recordId) dnsRecords.delete(name);
      }
    },
    async findDnsRecord(_zoneId, name) {
      return dnsRecords.get(name) ?? null;
    },
    async createAccessApp(a) {
      const id = `access-${nextId++}`;
      const aud = `aud-${id}`;
      accessApps.set(a.domain, { id, aud });
      createAccessAppCalls.push(a);
      return { id, aud };
    },
    async deleteAccessApp(appId) {
      deletedAccessApps.push(appId);
      for (const [domain, app] of accessApps) {
        if (app.id === appId) accessApps.delete(domain);
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
    deletedDnsRecords,
    accessApps,
    deletedAccessApps,
    createAccessAppCalls,
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

async function exposureFor(db: Db, appId: string) {
  const [row] = await db.select().from(exposures).where(eq(exposures.appId, appId));
  return row;
}

function baseDeps(
  db: Db,
  client: CloudflareClient,
  tunnelConfigLock: TunnelConfigLock,
  appId: string,
  hostname: string,
): ExposeDeps {
  return {
    db,
    client,
    tunnelConfigLock,
    appId,
    hostname,
    zoneId: "zone-1",
    tunnelId: "tunnel-1",
    internalUrl: "http://localhost:8096",
    humanPolicyId: "human-policy-1",
    monitorPolicyId: "monitor-policy-1",
  };
}

/**
 * A `Db` whose N-th `.update(...)` call throws instead of executing — every other method
 * (including every OTHER call to `.update`) passes straight through. Used to force the
 * exact "local write fails after an external Cloudflare write already landed" window that
 * `create-dns-record` and `create-access-app` each compensate for inline (see their doc
 * comments in `expose.ts`) — a window `runSteps` itself cannot recover from, since a
 * step reporting FAILED never has its own `undo` called (step-sequence.ts, rule 1).
 */
function dbFailingNthUpdate(db: Db, n: number): Db {
  let count = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "update") {
        count++;
        if (count === n) {
          return () => {
            throw new Error(`forced update #${n} failure`);
          };
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

/**
 * Same idea as `dbFailingNthUpdate`, but for `.insert(...)` — `splice-ingress` now
 * writes to Cloudflare BEFORE it writes locally (see `expose.ts`'s doc comment on why),
 * so its own inline compensation window is a failing INSERT, not a failing UPDATE like
 * `create-dns-record`/`create-access-app`.
 */
function dbFailingNthInsert(db: Db, n: number): Db {
  let count = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        count++;
        if (count === n) {
          return () => {
            throw new Error(`forced insert #${n} failure`);
          };
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

describe("exposeSteps — happy path", () => {
  it("splices ingress, creates DNS and Access app, and creates both probes", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, ingress } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(true);
    expect(ingress()).toEqual([
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      { service: "http_status:404" },
    ]);

    const row = await exposureFor(db, appId);
    expect(row).toMatchObject({
      hostname: "jellyfin.example.com",
      zoneId: "zone-1",
      tunnelId: "tunnel-1",
      ingressService: "http://localhost:8096",
      ingressRuleCreatedByUs: true,
      dnsRecordCreatedByUs: true,
      accessAppCreatedByUs: true,
      probeCreatedByUs: true,
      probeInternalCreatedByUs: true,
      state: "ready",
    });
    expect(row?.dnsRecordId).toBeDefined();
    expect(row?.accessAppId).toBeDefined();
    expect(row?.accessAppAud).toBeDefined();
    expect(row?.probeId).toBeDefined();
    expect(row?.probeInternalId).toBeDefined();

    const probeRows = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRows).toHaveLength(2);
    expect(probeRows).toContainEqual(
      expect.objectContaining({ kind: "http_external", target: "https://jellyfin.example.com" }),
    );
    expect(probeRows).toContainEqual(
      expect.objectContaining({ kind: "http_internal", target: "http://localhost:8096" }),
    );
  });

  it("passes the human policy AND the shared monitor policy to createAccessApp (F5)", async () => {
    // Measured surviving mutation: dropping `monitorPolicyId` from the policy list, or
    // passing `[]` entirely, left the full suite green — nothing anywhere asserted what
    // `createAccessApp` actually received. Without the monitor policy attached, the
    // external probe (2D Task 2's whole reason for existing) cannot authenticate and
    // every exposed app's health check redirects to a login page instead.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, createAccessAppCalls } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(true);
    expect(createAccessAppCalls).toHaveLength(1);
    expect(createAccessAppCalls[0]?.policyIds).toEqual(["human-policy-1", "monitor-policy-1"]);
  });

  it("adopts an app's own pre-existing http_external probe instead of duplicating it (F1)", async () => {
    // Measured defect, the other half of F1: `create-probe` used to insert unconditionally,
    // so an app that already carried its own external check (created through
    // `routes/probes.ts`, independent of exposure) ended up with TWO `http_external`
    // probes after a successful expose. Its target already matches what this exposure
    // would use — the case that is safe to adopt outright — so it is a genuine no-op
    // adoption, not the Defect 2 conflict covered below.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const usersOwnProbeId = ulid();
    await db.insert(probes).values({
      id: usersOwnProbeId,
      appId,
      kind: "http_external",
      target: "https://jellyfin.example.com",
    });
    const { client } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(true);
    // The pre-existing http_external probe is adopted, not duplicated — but a fresh
    // http_internal probe is still created, since none existed for this app at all.
    const probeRows = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRows).toHaveLength(2);
    const external = probeRows.find((p) => p.kind === "http_external");
    const internal = probeRows.find((p) => p.kind === "http_internal");
    expect(external?.id).toBe(usersOwnProbeId);
    expect(internal?.target).toBe("http://localhost:8096");
    const row = await exposureFor(db, appId);
    expect(row).toMatchObject({
      probeId: usersOwnProbeId,
      probeCreatedByUs: false,
      probeInternalId: internal?.id,
      probeInternalCreatedByUs: true,
    });
  });

  it("adopts an app's own pre-existing http_internal probe instead of duplicating it", async () => {
    // The internal-probe mirror of the http_external adoption test above — Task 4 gives
    // the internal probe the identical adoption treatment.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const usersOwnProbeId = ulid();
    await db.insert(probes).values({
      id: usersOwnProbeId,
      appId,
      kind: "http_internal",
      target: "http://localhost:8096",
    });
    const { client } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(true);
    const probeRows = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRows).toHaveLength(2);
    const internal = probeRows.find((p) => p.kind === "http_internal");
    expect(internal?.id).toBe(usersOwnProbeId);
    const row = await exposureFor(db, appId);
    expect(row).toMatchObject({
      probeInternalId: usersOwnProbeId,
      probeInternalCreatedByUs: false,
    });
  });

  it("refuses to adopt an existing http_internal probe that targets a different URL — 2F's ruling, followed for consistency", async () => {
    // The internal-probe mirror of Defect 2 below: an app that already has its own
    // http_internal check pointed elsewhere must not be adopted silently, and the whole
    // run must unwind (2C's rollback discipline) rather than leave a partially-created
    // exposure with only the external probe watching it.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const usersOwnProbeId = ulid();
    await db.insert(probes).values({
      id: usersOwnProbeId,
      appId,
      kind: "http_internal",
      target: "http://localhost:9999",
      label: "my own internal check",
    });
    const { client, ingress, dnsRecords, accessApps } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(ProbeTargetConflictError);
      expect(String(outcome.error)).toContain("http://localhost:9999");
    }
    // Nothing this run created survives, including the http_external probe it would
    // otherwise have created in the SAME transaction as the internal conflict.
    expect(ingress()).toEqual([{ service: "http_status:404" }]);
    expect(dnsRecords.has("jellyfin.example.com")).toBe(false);
    expect(accessApps.has("jellyfin.example.com")).toBe(false);
    expect(await exposureFor(db, appId)).toBeUndefined();
    const probeRows = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRows).toHaveLength(1);
    expect(probeRows[0]).toMatchObject({ id: usersOwnProbeId, target: "http://localhost:9999" });
  });

  it("refuses to adopt an existing http_external probe that targets a different URL (Defect 2)", async () => {
    // Measured by the re-review: the wave-1 fix adopted by `(appId, "http_external")`
    // alone, with no check on WHAT the existing probe targets. An app that already had
    // its own external check pointed elsewhere ended up with no probe watching the
    // newly exposed hostname at all — silent, and worse than no probe, since the UI kept
    // showing a green external check the whole time (it was still correctly checking its
    // own, unrelated target). This proves the chosen fix: refuse outright, and unwind
    // everything else this run already did (2C's rollback discipline, one more time).
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const usersOwnProbeId = ulid();
    await db.insert(probes).values({
      id: usersOwnProbeId,
      appId,
      kind: "http_external",
      target: "https://my-own-monitoring-target.example.com",
      label: "my own check",
    });
    const { client, ingress, dnsRecords, accessApps } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(ProbeTargetConflictError);
      expect(String(outcome.error)).toContain("my-own-monitoring-target.example.com");
    }
    // Nothing this run created survives, and the user's own probe is untouched.
    expect(ingress()).toEqual([{ service: "http_status:404" }]);
    expect(dnsRecords.has("jellyfin.example.com")).toBe(false);
    expect(accessApps.has("jellyfin.example.com")).toBe(false);
    expect(await exposureFor(db, appId)).toBeUndefined();
    const probeRows = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(probeRows).toHaveLength(1);
    expect(probeRows[0]).toMatchObject({
      id: usersOwnProbeId,
      target: "https://my-own-monitoring-target.example.com",
    });
  });

  it("records ingressRuleCreatedByUs: false when a rule for the hostname already existed", async () => {
    // The carried fix: before this, `ingressRuleCreatedByUs` was unconditionally `true`
    // on a successful splice (see the git history for `expose.ts`'s old comment) — sound
    // only if the ingress array could never contain anything Homestead did not itself
    // put there. 2C's tunnel adoption broke that assumption: an ADOPTED tunnel can carry
    // a rule a human wrote by hand. This proves the flag now reflects what was actually
    // there immediately before the splice, not merely "success".
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client } = fakeClient([
      { hostname: "jellyfin.example.com", service: "http://someone-elses-service:80" },
      { service: "http_status:404" },
    ]);
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(true);
    const row = await exposureFor(db, appId);
    expect(row).toMatchObject({ ingressRuleCreatedByUs: false });
  });
});

describe("exposeSteps — rollback removes what THIS run created", () => {
  it("removes the ingress rule and the exposures row when a later step fails", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, ingress } = fakeClient();
    client.createDnsRecord = async () => {
      throw new Error("dns boom");
    };
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    expect(ingress()).toEqual([{ service: "http_status:404" }]);
    expect(await exposureFor(db, appId)).toBeUndefined();
  });

  it("deletes a DNS record it created when a later step fails", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, dnsRecords, deletedDnsRecords } = fakeClient();
    client.createAccessApp = async () => {
      throw new Error("access boom");
    };
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    expect(dnsRecords.has("jellyfin.example.com")).toBe(false);
    expect(deletedDnsRecords).toHaveLength(1);
  });

  it("does NOT delete an adopted DNS record when a later step fails", async () => {
    // The most important test in this file, alongside the Access-app equivalent below:
    // 2C's rollback deleted a Cloudflare tunnel it had only adopted, because adoption and
    // deletion shared one match. This seeds a record Homestead never created and proves
    // the same defect does not exist here.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, dnsRecords, deletedDnsRecords } = fakeClient();
    dnsRecords.set("jellyfin.example.com", { id: "dns-preexisting" });
    client.createAccessApp = async () => {
      throw new Error("access boom");
    };
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    expect(dnsRecords.get("jellyfin.example.com")).toEqual({ id: "dns-preexisting" });
    expect(deletedDnsRecords).toHaveLength(0);
  });

  it("deletes an Access application it created when a later step fails", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, accessApps, deletedAccessApps } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");
    const steps = [
      ...exposeSteps(deps),
      {
        name: "force-fail",
        async run() {
          throw new Error("boom after everything else");
        },
      },
    ];

    const outcome = await runSteps(steps, {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    expect(accessApps.has("jellyfin.example.com")).toBe(false);
    expect(deletedAccessApps).toHaveLength(1);
  });

  it("restores a pre-existing ingress rule VERBATIM when a later step fails, instead of deleting it", async () => {
    // The carried fix's own binding test: seed a tunnel config that already contains a
    // rule for the hostname (as an ADOPTED tunnel might, per the carry-forward), fail a
    // later step, and assert the ORIGINAL rule — same hostname, same (different!)
    // service — survives byte-for-byte, rather than being deleted (the old,
    // unconditional-`true` behaviour) or left as Homestead's own overwritten version.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const preExisting: IngressRule = {
      hostname: "jellyfin.example.com",
      service: "http://someone-elses-service:80",
    };
    const { client, ingress } = fakeClient([preExisting, { service: "http_status:404" }]);
    client.createDnsRecord = async () => {
      throw new Error("dns boom");
    };
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    expect(ingress()).toEqual([preExisting, { service: "http_status:404" }]);
    expect(await exposureFor(db, appId)).toBeUndefined();
  });

  it("does NOT delete an adopted Access application when a later step fails", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, accessApps, deletedAccessApps } = fakeClient();
    accessApps.set("jellyfin.example.com", { id: "access-preexisting", aud: "aud-preexisting" });
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");
    // `create-probe` (the real last step) never fails on its own in this fake, so a
    // synthetic step after the full sequence stands in for "some later step fails" —
    // the same technique `provision-tunnel.test.ts` uses for `compose-up`'s otherwise
    // structurally-unreachable-through-runSteps undo.
    const steps = [
      ...exposeSteps(deps),
      {
        name: "force-fail",
        async run() {
          throw new Error("boom after everything else");
        },
      },
    ];

    const outcome = await runSteps(steps, {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    expect(accessApps.get("jellyfin.example.com")).toEqual({
      id: "access-preexisting",
      aud: "aud-preexisting",
    });
    expect(deletedAccessApps).toHaveLength(0);
  });
});

describe("exposeSteps — a step's own inline compensation", () => {
  it("splice-ingress never creates the exposures row if the Cloudflare write fails", async () => {
    // Cloudflare write happens first now (see `expose.ts`'s doc comment on
    // `splice-ingress`), so a failure here never reaches the local insert at all — there
    // is nothing to compensate, unlike the insert-fails case below.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, ingress } = fakeClient();
    client.putTunnelConfig = async () => {
      throw new Error("cloudflare boom");
    };
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const outcome = await runSteps(exposeSteps(deps), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failed).toBe("splice-ingress");
    expect(await exposureFor(db, appId)).toBeUndefined();
    expect(ingress()).toEqual([{ service: "http_status:404" }]);
  });

  it("splice-ingress removes the ingress rule it just wrote to Cloudflare if the local insert fails", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, ingress } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");
    const failingDb = dbFailingNthInsert(db, 1);

    const outcome = await runSteps(exposeSteps({ ...deps, db: failingDb }), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failed).toBe("splice-ingress");
    expect(ingress()).toEqual([{ service: "http_status:404" }]);
    expect(await exposureFor(db, appId)).toBeUndefined();
  });

  it("splice-ingress restores a pre-existing rule verbatim if the local insert fails", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const preExisting: IngressRule = {
      hostname: "jellyfin.example.com",
      service: "http://someone-elses-service:80",
    };
    const { client, ingress } = fakeClient([preExisting, { service: "http_status:404" }]);
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");
    const failingDb = dbFailingNthInsert(db, 1);

    const outcome = await runSteps(exposeSteps({ ...deps, db: failingDb }), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failed).toBe("splice-ingress");
    expect(ingress()).toEqual([preExisting, { service: "http_status:404" }]);
  });

  it("create-dns-record deletes the record it just created if recording it locally fails", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, dnsRecords, deletedDnsRecords } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");
    const failingDb = dbFailingNthUpdate(db, 1);

    const outcome = await runSteps(exposeSteps({ ...deps, db: failingDb }), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failed).toBe("create-dns-record");
    expect(dnsRecords.has("jellyfin.example.com")).toBe(false);
    expect(deletedDnsRecords).toHaveLength(1);
  });

  it("create-access-app deletes the app it just created if recording it locally fails", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client, accessApps, deletedAccessApps } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");
    // The 1st `.update()` is `create-dns-record`'s own, which must succeed so the failure
    // under test is unambiguously `create-access-app`'s.
    const failingDb = dbFailingNthUpdate(db, 2);

    const outcome = await runSteps(exposeSteps({ ...deps, db: failingDb }), {} as ExposeCtx);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failed).toBe("create-access-app");
    expect(accessApps.has("jellyfin.example.com")).toBe(false);
    expect(deletedAccessApps).toHaveLength(1);
  });
});

describe("exposeSteps — create-probe (structurally unreachable through a full rollback)", () => {
  // `create-probe` is the last step: a successful `run` means the whole sequence
  // succeeded (no rollback), and a failing `run` means `undo` is skipped for the failing
  // step itself (step-sequence.ts, rule 1). Same situation `provision-tunnel.ts`'s
  // `compose-up` is in, tested the same way: directly, against the step object.
  it("creates both probes, and its own undo removes both", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");
    const steps = exposeSteps(deps);
    const ctx: ExposeCtx = {};

    await steps[0]?.run(ctx);
    await steps[1]?.run(ctx);
    await steps[2]?.run(ctx);
    await steps[3]?.run(ctx);

    expect(ctx.probeId).toBeDefined();
    expect(ctx.probeInternalId).toBeDefined();
    const before = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(before).toHaveLength(2);

    await steps[3]?.undo?.(ctx);

    const after = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(after).toHaveLength(0);
  });

  it("undo removes only the probe THIS run created when the other was adopted", async () => {
    // The two probes are independent, gated separately — the internal-probe mirror of
    // every other "adoption survives a rollback" test in this file. Pre-seeds the
    // app's OWN http_internal probe (adopted, `probeInternalCreatedByUs: false`), so
    // `undo` must remove only the http_external probe this run created and leave the
    // adopted internal one untouched.
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const usersOwnProbeId = ulid();
    await db.insert(probes).values({
      id: usersOwnProbeId,
      appId,
      kind: "http_internal",
      target: "http://localhost:8096",
    });
    const { client } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");
    const steps = exposeSteps(deps);
    const ctx: ExposeCtx = {};

    await steps[0]?.run(ctx);
    await steps[1]?.run(ctx);
    await steps[2]?.run(ctx);
    await steps[3]?.run(ctx);

    expect(ctx.probeInternalCreatedByUs).toBe(false);
    expect(ctx.probeCreatedByUs).toBe(true);

    await steps[3]?.undo?.(ctx);

    const remaining = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(remaining.map((p) => p.id)).toEqual([usersOwnProbeId]);
  });
});

describe("exposeSteps — record-self-access-settings (2F Task 2)", () => {
  it("is absent entirely when selfAccessTeamDomain is not set — an ordinary app's steps cannot touch this setting", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "jellyfin");
    const { client } = fakeClient();
    const deps = baseDeps(db, client, new TunnelConfigLock(), appId, "jellyfin.example.com");

    const steps = exposeSteps(deps);
    expect(steps.map((s) => s.name)).not.toContain("record-self-access-settings");
  });

  it("is present, last, and records the team domain when selfAccessTeamDomain is set", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "homestead");
    const { client } = fakeClient();
    const deps: ExposeDeps = {
      ...baseDeps(db, client, new TunnelConfigLock(), appId, "homestead.example.com"),
      selfAccessTeamDomain: "my-team",
    };

    const steps = exposeSteps(deps);
    expect(steps.at(-1)?.name).toBe("record-self-access-settings");

    const ctx: ExposeCtx = {};
    for (const step of steps) await step.run(ctx);

    expect(ctx.teamDomainRecorded).toBe(true);
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, ACCESS_TEAM_DOMAIN_SETTING_KEY));
    expect(row?.value).toBe("my-team");
  });

  it("is idempotent: leaves an already-recorded team domain untouched rather than overwriting it", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "homestead");
    await db
      .insert(settings)
      .values({ key: ACCESS_TEAM_DOMAIN_SETTING_KEY, value: "existing-team" });
    const { client } = fakeClient();
    const deps: ExposeDeps = {
      ...baseDeps(db, client, new TunnelConfigLock(), appId, "homestead.example.com"),
      selfAccessTeamDomain: "attempted-new-team",
    };

    const steps = exposeSteps(deps);
    const ctx: ExposeCtx = {};
    for (const step of steps) await step.run(ctx);

    expect(ctx.teamDomainRecorded).toBe(false);
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, ACCESS_TEAM_DOMAIN_SETTING_KEY));
    expect(row?.value).toBe("existing-team");
  });

  it("its own undo removes only a value THIS run wrote, never one it merely found", async () => {
    const db = await seedDb();
    const appId = await seedApp(db, "homestead");
    const { client } = fakeClient();
    const deps: ExposeDeps = {
      ...baseDeps(db, client, new TunnelConfigLock(), appId, "homestead.example.com"),
      selfAccessTeamDomain: "my-team",
    };
    const steps = exposeSteps(deps);
    const last = steps.at(-1);
    if (!last?.undo) throw new Error("record-self-access-settings has no undo");

    const ctx: ExposeCtx = { teamDomainRecorded: true };
    await last.run(ctx);
    await last.undo(ctx);

    const [afterOwnWrite] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, ACCESS_TEAM_DOMAIN_SETTING_KEY));
    expect(afterOwnWrite).toBeUndefined();

    // Now prove the adopted case is left alone: a value pre-existed, so `run` never wrote
    // it (`teamDomainRecorded: false`), and `undo` must not delete it either.
    await db.insert(settings).values({ key: ACCESS_TEAM_DOMAIN_SETTING_KEY, value: "adopted" });
    const adoptedCtx: ExposeCtx = {};
    await last.run(adoptedCtx);
    expect(adoptedCtx.teamDomainRecorded).toBe(false);
    await last.undo(adoptedCtx);

    const [afterAdoptedUndo] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, ACCESS_TEAM_DOMAIN_SETTING_KEY));
    expect(afterAdoptedUndo?.value).toBe("adopted");
  });

  it("rolls back the whole sequence, including the team-domain write, when a later concern fails — proven via runSteps", async () => {
    // `record-self-access-settings` is the LAST step today, so nothing currently fails
    // after it — but proving `runSteps` unwinds it correctly (not just this file's own
    // step object) matters because a future step appended after it must not be able to
    // leave this setting behind. Simulated here by making the step's OWN run throw after
    // its write has already landed, which is exactly the shape a later real failure would
    // have from `runSteps`'s point of view.
    const db = await seedDb();
    const appId = await seedApp(db, "homestead");
    const { client } = fakeClient();
    const deps: ExposeDeps = {
      ...baseDeps(db, client, new TunnelConfigLock(), appId, "homestead.example.com"),
      selfAccessTeamDomain: "my-team",
    };
    const steps = exposeSteps(deps);
    const failingLastStep: Step<ExposeCtx> = {
      name: "force-failure-after-self-settings",
      async run() {
        throw new Error("simulated failure of a later step");
      },
    };

    const outcome = await runSteps([...steps, failingLastStep], {});
    expect(outcome.ok).toBe(false);

    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, ACCESS_TEAM_DOMAIN_SETTING_KEY));
    expect(row).toBeUndefined();
  });
});

describe("TunnelConfigLock — the read-modify-write race the spec names as a correctness bug", () => {
  it("both hostnames survive two genuinely concurrent exposes against one tunnel", async () => {
    const db = await seedDb();
    const appIdA = await seedApp(db, "app-a");
    const appIdB = await seedApp(db, "app-b");
    const { client, ingress } = fakeClient();
    // ONE shared lock, exactly as production shares one `TunnelConfigLock` instance
    // across every concurrent expose — a lock built fresh per call would serialise
    // nothing. See `expose.ts`'s doc comment on why this is not `AppLock`.
    const lock = new TunnelConfigLock();

    const depsA = baseDeps(db, client, lock, appIdA, "a.example.com");
    const depsB = baseDeps(db, client, lock, appIdB, "b.example.com");

    const [outcomeA, outcomeB] = await Promise.all([
      runSteps(exposeSteps(depsA), {} as ExposeCtx),
      runSteps(exposeSteps(depsB), {} as ExposeCtx),
    ]);

    expect(outcomeA.ok).toBe(true);
    expect(outcomeB.ok).toBe(true);

    const hostnames = ingress().map((r) => r.hostname);
    // This is the ONE assertion the spec's named correctness bug fails: a mutex-free
    // (or lock-after-read) implementation drops whichever hostname loses the race, and a
    // test that ran these two sequentially — instead of concurrently — would pass either
    // way and prove nothing. See the task report for the measured failure without the
    // lock in place.
    expect(hostnames).toContain("a.example.com");
    expect(hostnames).toContain("b.example.com");
  });
});

describe("TunnelConfigLock — the two other write sites this same file's own review flagged uncovered (F6)", () => {
  // 2D's whole-branch review: `expose.ts`'s own concurrency test above proves the mutex
  // exists at `splice-ingress`'s `run` — but `splice-ingress`'s inline compensation and
  // its `undo` each do their OWN independent read-modify-write of the same ingress array,
  // wrapped in the SAME lock, and neither one was ever driven concurrently against a
  // second caller. Both survived their lock being removed with the full suite green.
  // These two tests close that gap, using the identical delayed-fake technique.

  it("splice-ingress's inline compensation does not clobber a concurrent expose's hostname", async () => {
    const db = await seedDb();
    const appIdA = await seedApp(db, "app-a");
    const appIdB = await seedApp(db, "app-b");
    const { client, ingress } = fakeClient();
    const lock = new TunnelConfigLock();
    const depsA = baseDeps(db, client, lock, appIdA, "a.example.com");
    const depsB = baseDeps(db, client, lock, appIdB, "b.example.com");
    // Forces A's `splice-ingress` local insert to fail AFTER its Cloudflare write already
    // landed — exactly the window that runs the inline compensation at expose.ts:176-192.
    const failingDbA = dbFailingNthInsert(db, 1);

    const [resultA, outcomeB] = await Promise.all([
      exposeSteps({ ...depsA, db: failingDbA })[0]
        ?.run({} as ExposeCtx)
        .catch((e: unknown) => e),
      runSteps(exposeSteps(depsB), {} as ExposeCtx),
    ]);

    expect(resultA).toBeInstanceOf(Error);
    expect(outcomeB.ok).toBe(true);

    const hostnames = ingress().map((r) => r.hostname);
    // A's compensation must have removed ITS OWN hostname, and must not have clobbered
    // B's concurrent write in the process — the assertion a lock-free (or lock-after-read)
    // compensation fails.
    expect(hostnames).not.toContain("a.example.com");
    expect(hostnames).toContain("b.example.com");
  });

  it("splice-ingress's undo does not clobber a concurrent expose's hostname", async () => {
    const db = await seedDb();
    const appIdA = await seedApp(db, "app-a");
    const appIdB = await seedApp(db, "app-b");
    const { client, ingress } = fakeClient();
    const lock = new TunnelConfigLock();
    const depsA = baseDeps(db, client, lock, appIdA, "a.example.com");
    const depsB = baseDeps(db, client, lock, appIdB, "b.example.com");
    // A's full sequence succeeds, then a synthetic later step fails, forcing a full
    // rollback — including `splice-ingress`'s own `undo` (expose.ts:205-224) — the same
    // technique the single-caller version of this test uses, just now run concurrently
    // against B's own live expose sharing the same lock and tunnel.
    const stepsA = [
      ...exposeSteps(depsA),
      {
        name: "force-fail",
        async run() {
          throw new Error("boom after everything else");
        },
      },
    ];

    const [outcomeA, outcomeB] = await Promise.all([
      runSteps(stepsA, {} as ExposeCtx),
      runSteps(exposeSteps(depsB), {} as ExposeCtx),
    ]);

    expect(outcomeA.ok).toBe(false);
    expect(outcomeB.ok).toBe(true);

    const hostnames = ingress().map((r) => r.hostname);
    expect(hostnames).not.toContain("a.example.com");
    expect(hostnames).toContain("b.example.com");
  });
});
