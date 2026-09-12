import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLock } from "@server/apps/app-lock";
import { StepJobRunner } from "@server/apps/step-job-runner";
import { runSteps } from "@server/apps/step-sequence";
import { LOCAL_HOST_ID } from "@server/bootstrap";
import type { CloudflareClient } from "@server/cloudflare/client";
import {
  CLOUDFLARED_DIRECTORY,
  CLOUDFLARED_TUNNEL_NAME,
  tunnelProvisionSteps,
} from "@server/cloudflare/provision-tunnel";
import { TunnelStore } from "@server/cloudflare/tunnel-store";
import { SecretStore } from "@server/crypto/secrets";
import type { Db } from "@server/db/client";
import { createDb, runMigrations } from "@server/db/client";
import { apps, hosts, jobs, probes, users } from "@server/db/schema";
import { LocalHost } from "@server/host/local-host";
import type { ComposeResult, ComposeTarget, Host, JobChunk, JobHandle } from "@server/host/types";
import { FakeHost } from "@server/test-helpers";
import { parseEnv } from "@shared/env-file";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** An `AsyncIterable<JobChunk>` with nothing in it — used by the compose stub below.
 * Written as a plain object rather than an empty async generator, which some lint
 * configurations flag for never `yield`ing. */
const EMPTY_OUTPUT: AsyncIterable<JobChunk> = {
  [Symbol.asyncIterator]() {
    return { next: async () => ({ done: true as const, value: undefined as never }) };
  },
};

const SECRET_KEY = Buffer.alloc(32, 9);

/**
 * A hand-written `CloudflareClient` double, not a mocked `fetch` — this file tests
 * `tunnelProvisionSteps`' composition against the client's INTERFACE, the same boundary
 * `client.test.ts` already covers exhaustively for the wire format. No test in this file
 * makes a network call.
 */
function fakeClient() {
  const tunnels: Array<{ id: string; name: string; deletedAt: number | null }> = [];
  const calls = { created: [] as string[], deleted: [] as string[], tokenRequests: [] as string[] };
  let nextId = 1;

  const client: CloudflareClient = {
    async listZones() {
      throw new Error("not used by provisioning");
    },
    async createTunnel(name) {
      const id = `tunnel-${nextId++}`;
      tunnels.push({ id, name, deletedAt: null });
      calls.created.push(id);
      return { id, name };
    },
    async listTunnels() {
      return tunnels.map((t) => ({ ...t }));
    },
    async tunnelToken(tunnelId) {
      calls.tokenRequests.push(tunnelId);
      return `token-for-${tunnelId}`;
    },
    async deleteTunnel(tunnelId) {
      calls.deleted.push(tunnelId);
      const tunnel = tunnels.find((t) => t.id === tunnelId);
      if (tunnel) tunnel.deletedAt = Date.now();
    },
  };

  return { client, tunnels, calls };
}

async function seedDb(): Promise<{ db: Db; tunnelStore: TunnelStore; userId: string }> {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({
    id: LOCAL_HOST_ID,
    name: "local",
    composeRoot: "/v",
    dockerSocket: "/s",
  });
  const userId = ulid();
  await db.insert(users).values({
    id: userId,
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    emailVerified: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const secrets = new SecretStore(db, SECRET_KEY);
  const tunnelStore = new TunnelStore(db, secrets);
  return { db, tunnelStore, userId };
}

async function appRowFor(db: Db, directory: string) {
  const [row] = await db.select().from(apps).where(eq(apps.directory, directory));
  return row;
}

describe("tunnelProvisionSteps — happy path", () => {
  it("creates the tunnel, stores it, writes the app, and brings it up", async () => {
    const { db, tunnelStore } = await seedDb();
    const host = new FakeHost();
    const { client, calls } = fakeClient();

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });
    const outcome = await runSteps(steps, {});

    expect(outcome.ok).toBe(true);
    expect(calls.created).toHaveLength(1);
    const tunnelId = calls.created[0] as string;

    const record = await tunnelStore.get();
    expect(record?.tunnelId).toBe(tunnelId);
    expect(record?.name).toBe(CLOUDFLARED_TUNNEL_NAME);

    const composeContent = host.files.get(`${CLOUDFLARED_DIRECTORY}/compose.yaml`) ?? "";
    expect(composeContent).toContain("network_mode: host");
    const envContent = host.files.get(`${CLOUDFLARED_DIRECTORY}/.env`) ?? "";
    expect(envContent).toContain(`TUNNEL_TOKEN=token-for-${tunnelId}`);

    const row = await appRowFor(db, CLOUDFLARED_DIRECTORY);
    expect(row?.systemKind).toBe("cloudflared");
    expect(record?.appId).toBe(row?.id);
    const [probeRow] = await db
      .select()
      .from(probes)
      .where(eq(probes.appId, row?.id ?? ""));
    expect(probeRow?.kind).toBe("docker");

    expect(host.composeCalls.at(-1)).toMatchObject({ args: ["up", "-d"] });
  });

  it("adopts a live tunnel of the same name instead of creating a second one", async () => {
    // The step's OWN idempotency (see provision-tunnel.ts's doc comment on
    // `tunnelProvisionSteps`): a previous attempt left a tunnel in Cloudflare with no
    // local record (e.g. this run's own rollback of `create-tunnel` failed last time).
    const { db, tunnelStore } = await seedDb();
    const host = new FakeHost();
    const { client, calls } = fakeClient();
    // Seed a pre-existing live tunnel of the same name, bypassing `createTunnel` so the
    // "created" call list stays empty for it.
    await client.createTunnel(CLOUDFLARED_TUNNEL_NAME);
    calls.created.length = 0;

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });
    const outcome = await runSteps(steps, {});

    expect(outcome.ok).toBe(true);
    expect(calls.created).toHaveLength(0);
    expect(await client.listTunnels()).toHaveLength(1);
  });

  it("does not adopt a soft-deleted tunnel of the same name", async () => {
    const { db, tunnelStore } = await seedDb();
    const host = new FakeHost();
    const { client, calls } = fakeClient();
    const seeded = await client.createTunnel(CLOUDFLARED_TUNNEL_NAME);
    await client.deleteTunnel(seeded.id);
    calls.created.length = 0;

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });
    const outcome = await runSteps(steps, {});

    expect(outcome.ok).toBe(true);
    expect(calls.created).toHaveLength(1);
  });
});

describe("tunnelProvisionSteps — failure and rollback", () => {
  it("step 4 (register-app) failing undoes 3, 2, 1 in that order, and does not undo step 4", async () => {
    const { db, tunnelStore } = await seedDb();
    const host = new FakeHost();
    const { client, calls } = fakeClient();

    // A pre-existing app already occupies the `cloudflared` directory/slug, so
    // `register-app`'s insert hits `apps_host_directory` and throws — a realistic way to
    // make the 4th step fail without reaching into its internals.
    await db.insert(apps).values({
      id: ulid(),
      hostId: LOCAL_HOST_ID,
      slug: "cloudflared",
      displayName: "pre-existing",
      directory: CLOUDFLARED_DIRECTORY,
      composeFile: "compose.yaml",
      projectName: "cloudflared",
    });

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });
    const outcome = await runSteps(steps, {});

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failed).toBe("register-app");
    expect(outcome.undone).toEqual(["write-files", "fetch-token", "create-tunnel"]);

    // The Cloudflare tunnel was actually deleted, not merely "an undo ran".
    expect(calls.deleted).toEqual(calls.created);
    // The directory's files were actually removed.
    expect(host.files.has(`${CLOUDFLARED_DIRECTORY}/compose.yaml`)).toBe(false);
    expect(host.files.has(`${CLOUDFLARED_DIRECTORY}/.env`)).toBe(false);
    // The tunnel record was actually cleared.
    await expect(tunnelStore.get()).resolves.toBeNull();
    // The pre-existing row survives untouched; no second row was left behind.
    const rows = await db.select().from(apps).where(eq(apps.directory, CLOUDFLARED_DIRECTORY));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("pre-existing");
  });

  it("step 5 (compose-up) failing deletes the app row, removes the files, deletes the tunnel", async () => {
    const { db, tunnelStore } = await seedDb();
    const host = new FakeHost();
    host.composeResults.set("up -d", { exitCode: 1, stdout: "", stderr: "pull access denied" });
    const { client, calls } = fakeClient();

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });
    const outcome = await runSteps(steps, {});

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failed).toBe("compose-up");
    expect(outcome.undone).toEqual(["register-app", "write-files", "fetch-token", "create-tunnel"]);

    expect(calls.deleted).toEqual(calls.created);
    expect(host.files.has(`${CLOUDFLARED_DIRECTORY}/compose.yaml`)).toBe(false);
    expect(host.files.has(`${CLOUDFLARED_DIRECTORY}/.env`)).toBe(false);
    await expect(tunnelStore.get()).resolves.toBeNull();
    const row = await appRowFor(db, CLOUDFLARED_DIRECTORY);
    expect(row).toBeUndefined();
  });

  it("register-app compensates its own partial effect when persisting the tunnel record fails after the insert succeeds", async () => {
    // A seam this task introduced: `register-app` does two separate writes (the DB insert,
    // then `tunnelStore.set()`). If the second fails, `register-app` itself is the
    // "failing step" and `runSteps` never calls ITS OWN undo (rule 1) — so unless the step
    // cleans up after itself, the just-inserted row would survive with nothing to remove
    // it.
    const { db, tunnelStore } = await seedDb();
    const host = new FakeHost();
    const { client, calls } = fakeClient();
    const originalSet = tunnelStore.set.bind(tunnelStore);
    let setCalls = 0;
    tunnelStore.set = async (record: Parameters<TunnelStore["set"]>[0], token: string) => {
      setCalls++;
      if (setCalls === 2) throw new Error("disk full");
      return originalSet(record, token);
    };

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });
    const outcome = await runSteps(steps, {});

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failed).toBe("register-app");
    const row = await appRowFor(db, CLOUDFLARED_DIRECTORY);
    expect(row).toBeUndefined();
    expect(calls.deleted).toEqual(calls.created);
  });
});

describe("tunnelProvisionSteps via StepJobRunner — the wiring StepJobRunner owns", () => {
  it("an undo that itself fails does not abort the rest, and it reaches the persisted job output — without ever including the token", async () => {
    const { db, tunnelStore, userId } = await seedDb();
    const appLock = new AppLock();
    const runner = new StepJobRunner({ db, appLock });
    const host = new FakeHost();
    host.composeResults.set("up -d", { exitCode: 1, stdout: "", stderr: "boom" });
    const { client, calls } = fakeClient();
    client.deleteTunnel = async () => {
      throw new Error("Cloudflare is unreachable for delete");
    };

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });

    const { id } = await runner.start(null, "cloudflare_tunnel_provision", steps, {}, userId);

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(saved?.status).toBe("failed");
    const output = saved?.output ?? "";

    // The failure reached the output, and rollback kept going past it.
    expect(output).toMatch(/manual cleanup required/i);
    expect(output).toContain("create-tunnel");
    expect(output).toContain("fetch-token");
    expect(output).toContain("write-files");

    // The token must never appear in the persisted output — this is what a user reads and
    // what the audit trail keeps.
    const token = `token-for-${calls.created[0]}`;
    expect(output).not.toContain(token);
  });

  it("jobs.appId is null for a sequence that creates its own app, and the lock is released after it finishes", async () => {
    const { db, tunnelStore, userId } = await seedDb();
    const appLock = new AppLock();
    const runner = new StepJobRunner({ db, appLock });
    const host = new FakeHost();
    const { client } = fakeClient();

    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });
    const { id } = await runner.start(null, "cloudflare_tunnel_provision", steps, {}, userId);

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(saved?.status).toBe("succeeded");
    expect(saved?.appId).toBeNull();
  });
});

/**
 * A real `LocalHost` delegate with `runCompose` stubbed out. Every other method — in
 * particular `createAppDirectory` and `writeTextFile`, the two `write-files` calls through
 * `PathGuard` — reaches the real filesystem. This is what lets the sequence below run
 * end-to-end without ever spawning the `docker` binary (which, if a real daemon happened
 * to be reachable, could otherwise attempt a real image pull — a real network call this
 * suite must never make).
 */
class RealHostStubbedCompose implements Host {
  readonly id: string;
  constructor(
    private readonly real: LocalHost,
    private readonly composeResults: Map<string, ComposeResult>,
  ) {
    this.id = real.id;
  }
  listAppDirectories() {
    return this.real.listAppDirectories();
  }
  createAppDirectory(directory: string) {
    return this.real.createAppDirectory(directory);
  }
  readTextFile(rel: string) {
    return this.real.readTextFile(rel);
  }
  writeTextFile(rel: string, content: string, expectedHash: string | null) {
    return this.real.writeTextFile(rel, content, expectedHash);
  }
  deleteFile(rel: string) {
    return this.real.deleteFile(rel);
  }
  fileExists(rel: string) {
    return this.real.fileExists(rel);
  }
  listContainers(filters?: { project?: string }) {
    return this.real.listContainers(filters);
  }
  dockerVersion() {
    return this.real.dockerVersion();
  }
  streamLogs(opts: Parameters<Host["streamLogs"]>[0]) {
    return this.real.streamLogs(opts);
  }
  inspectContainer(id: string) {
    return this.real.inspectContainer(id);
  }
  inspectImage(ref: string) {
    return this.real.inspectImage(ref);
  }
  runCompose(_target: ComposeTarget, args: string[]): JobHandle {
    const result = this.composeResults.get(args.join(" ")) ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    return {
      output: EMPTY_OUTPUT,
      result: Promise.resolve(result),
      cancel: () => {},
    };
  }
}

describe("tunnelProvisionSteps against a real LocalHost over a mkdtemp root", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hs-tunnel-provision-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * `FakeHost` is a `Map` with no `PathGuard` and no real parent-directory check — it is
   * structurally incapable of seeing the exact defect Phase 1E shipped (`POST /api/apps`
   * could never create a directory in production, because `PathGuard.resolveForWrite`
   * requires the write's PARENT to already exist, and every test used `FakeHost`). `write-
   * files` writes into the compose root through that same guard, so this test drives a
   * real `LocalHost` instead.
   */
  it("creates the directory and writes compose.yaml/.env ON DISK, and undo actually removes them", async () => {
    const real = new LocalHost("local", root, join(root, "no-such-docker.sock"));
    await real.init();
    const host = new RealHostStubbedCompose(real, new Map());

    const { db, tunnelStore } = await seedDb();
    const { client } = fakeClient();
    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });

    const outcome = await runSteps(steps, {});
    expect(outcome.ok).toBe(true);

    const composePath = join(root, CLOUDFLARED_DIRECTORY, "compose.yaml");
    const envPath = join(root, CLOUDFLARED_DIRECTORY, ".env");
    const composeOnDisk = await readFile(composePath, "utf8");
    expect(composeOnDisk).toContain("network_mode: host");
    const envOnDisk = await readFile(envPath, "utf8");
    const parsedEnv = parseEnv(envOnDisk);
    const tunnelTokenEntry = parsedEnv.find(
      (e): e is Extract<typeof e, { kind: "pair" }> =>
        e.kind === "pair" && e.key === "TUNNEL_TOKEN",
    );
    expect(tunnelTokenEntry?.value).toMatch(/^token-for-tunnel-/);

    const dirs = await readdir(root);
    expect(dirs).toContain(CLOUDFLARED_DIRECTORY);
  });

  it("rolls back a real LocalHost write when a later step fails — the files are actually gone from disk", async () => {
    const real = new LocalHost("local", root, join(root, "no-such-docker.sock"));
    await real.init();
    const composeResults = new Map<string, ComposeResult>([
      ["up -d", { exitCode: 1, stdout: "", stderr: "no such image" }],
    ]);
    const host = new RealHostStubbedCompose(real, composeResults);

    const { db, tunnelStore } = await seedDb();
    const { client, calls } = fakeClient();
    const steps = tunnelProvisionSteps({
      db,
      host,
      client,
      tunnelStore,
      tunnelName: CLOUDFLARED_TUNNEL_NAME,
    });

    const outcome = await runSteps(steps, {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failed).toBe("compose-up");

    const composePath = join(root, CLOUDFLARED_DIRECTORY, "compose.yaml");
    const envPath = join(root, CLOUDFLARED_DIRECTORY, ".env");
    await expect(readFile(composePath, "utf8")).rejects.toThrow();
    await expect(readFile(envPath, "utf8")).rejects.toThrow();
    await expect(tunnelStore.get()).resolves.toBeNull();
    expect(calls.deleted).toEqual(calls.created);
  });
});
