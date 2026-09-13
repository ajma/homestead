import { runSteps } from "@server/apps/step-sequence";
import { LOCAL_HOST_ID } from "@server/bootstrap";
import type { CloudflareClient } from "@server/cloudflare/client";
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
function fakeClient(): {
  client: CloudflareClient;
  ingress: () => IngressRule[];
  dnsRecords: Map<string, { id: string }>;
  deletedDnsRecords: string[];
  accessApps: Map<string, { id: string; aud: string }>;
  deletedAccessApps: string[];
} {
  let ingress: IngressRule[] = [{ service: "http_status:404" }];
  const dnsRecords = new Map<string, { id: string }>();
  const deletedDnsRecords: string[] = [];
  const accessApps = new Map<string, { id: string; aud: string }>();
  const deletedAccessApps: string[] = [];
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
  };

  return {
    client,
    ingress: () => ingress,
    dnsRecords,
    deletedDnsRecords,
    accessApps,
    deletedAccessApps,
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
    ingressService: "http://localhost:8096",
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

describe("exposeSteps — happy path", () => {
  it("splices ingress, creates DNS and Access app, and creates the probe", async () => {
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
      state: "ready",
    });
    expect(row?.dnsRecordId).toBeDefined();
    expect(row?.accessAppId).toBeDefined();
    expect(row?.accessAppAud).toBeDefined();

    const [probe] = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(probe).toMatchObject({ kind: "http_external", target: "https://jellyfin.example.com" });
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
  it("splice-ingress removes the exposures row it just inserted if the Cloudflare write fails", async () => {
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
  it("creates the probe, and its own undo removes it", async () => {
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
    const [before] = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(before).toBeDefined();

    await steps[3]?.undo?.(ctx);

    const [after] = await db.select().from(probes).where(eq(probes.appId, appId));
    expect(after).toBeUndefined();
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
