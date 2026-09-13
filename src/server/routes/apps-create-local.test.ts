import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppDeps, buildApp } from "@server/app";
import { AppLock } from "@server/apps/app-lock";
import { ComposeConfigCache } from "@server/apps/compose-config";
import { ImageUpdateChecker } from "@server/apps/image-updates";
import { JobRunner } from "@server/apps/job-runner";
import { StepJobRunner } from "@server/apps/step-job-runner";
import { createAuth } from "@server/auth/auth";
import { ensureLocalHost, LOCAL_HOST_ID } from "@server/bootstrap";
import { TunnelConfigLock } from "@server/cloudflare/expose";
import { loadConfig } from "@server/config";
import { SecretStore } from "@server/crypto/secrets";
import { createDb, runMigrations } from "@server/db/client";
import { LocalHost } from "@server/host/local-host";
import { IconMetadata } from "@server/icons/metadata";
import { IconStore } from "@server/icons/store";
import { dockerRunner } from "@server/monitoring/docker-runner";
import { createHttpRunners } from "@server/monitoring/http-runner";
import { Scheduler } from "@server/monitoring/scheduler";
import { EventBus } from "@server/routes/events";
import { signUpAdmin } from "@server/test-helpers";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `POST /api/apps` against a REAL `LocalHost` on a `mkdtemp` root, not the `FakeHost`
 * every other route test uses.
 *
 * This is the point of the file, not an incidental choice. `FakeHost` is an in-memory
 * `Map` with no filesystem and no `PathGuard`, so it is structurally incapable of seeing
 * the bug this route shipped with: `PathGuard.resolveForWrite` requires a write's PARENT
 * directory to already exist, and nothing created it, so creating a brand-new app threw
 * `PathEscapeError` on every call outside a test. 682 tests were green while the feature
 * did not work at all. The binding check recorded in the task report measures that
 * contrast directly: removing the route's call to `createAppDirectory` fails the tests
 * below while every `FakeHost`-backed test in `apps-create.test.ts` stays green.
 *
 * The full route is wired up here — not just `createAppDirectory` + `writeTextFile`
 * called directly — because the binding check needs to observe the ROUTE regressing when
 * its call to `createAppDirectory` is removed, not just the `Host` method working in
 * isolation. That means duplicating a chunk of `test-helpers.ts`'s `buildTestApp` with a
 * real `LocalHost` swapped in, rather than reusing it (`buildTestApp` hardcodes
 * `FakeHost`).
 *
 * This must not reach Docker. `LocalHost.runCompose` spawns the `docker` binary directly
 * and `LocalHost.listContainers` dials `dockerSocket` — neither is assumed present here.
 * `runCompose`'s own `child.on("error", ...)` handler already turns a missing binary into
 * a resolved (not thrown) failure result, and `statusFor`/`ComposeConfigCache.resolve`
 * both treat that as "invalid config" rather than propagating — so `POST /api/apps`,
 * which computes the created app's status for its response body, degrades to
 * `status: "unknown"` instead of failing. `dockerSocket` is pointed at a path that does
 * not exist so a stray real socket on the machine running the tests is never dialed by
 * accident; nothing on the create path calls `listContainers` regardless.
 */
type RealHostTestApp = FastifyInstance & { deps: AppDeps & { host: LocalHost } };

async function buildRealHostTestApp(composeRoot: string): Promise<RealHostTestApp> {
  const config = loadConfig({
    HOMESTEAD_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
    HOMESTEAD_BASE_URL: "http://localhost:3000",
    NODE_ENV: "test",
    HOMESTEAD_COMPOSE_ROOT: composeRoot,
    HOMESTEAD_DOCKER_SOCKET: join(composeRoot, "no-such-docker.sock"),
  });
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await ensureLocalHost(db, config);
  const secrets = new SecretStore(db, config.secretKey);

  const host = new LocalHost(LOCAL_HOST_ID, config.composeRoot, config.dockerSocket);
  await host.init();

  const auth = createAuth(config, db);
  const composeConfig = new ComposeConfigCache(host);
  const appLock = new AppLock();
  const jobs = new JobRunner({ db, host, composeConfig, appLock });
  const stepJobs = new StepJobRunner({ db, appLock });
  const images = new ImageUpdateChecker({
    db,
    host,
    composeConfig,
    registry: { latestDigest: async () => null },
  });
  const httpRunners = createHttpRunners({
    fetch: async () => {
      throw new Error("scheduler fetch should not be called in tests");
    },
  });
  const events = new EventBus();
  const scheduler = new Scheduler({
    db,
    host,
    composeConfig,
    runners: {
      docker: dockerRunner,
      http_internal: httpRunners.internal,
      http_external: httpRunners.external,
    },
    onProbeError: () => {
      // Never started in this test; nothing should call this.
    },
  });
  scheduler.onTransition((transition) => events.publish(transition));

  const iconMetadata = new IconMetadata({
    cacheDir: join(tmpdir(), `homestead-test-icons-${randomUUID()}`),
    fetchImpl: (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
  await iconMetadata.load();
  const iconStore = new IconStore({
    cacheDir: join(tmpdir(), `homestead-test-icon-store-${randomUUID()}`),
    metadata: iconMetadata,
    fetchImpl: (async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      })) as unknown as typeof fetch,
  });

  const app = await buildApp({
    config,
    db,
    host,
    secrets,
    auth,
    composeConfig,
    jobs,
    stepJobs,
    appLock,
    images,
    scheduler,
    events,
    icons: { metadata: iconMetadata, store: iconStore },
    tunnelConfigLock: new TunnelConfigLock(),
    preflight: async () => ({ ok: true }),
    fetch: (async () => {
      throw new Error("cloudflare fetch should not be called in tests without an override");
    }) as unknown as typeof fetch,
  });

  return app as RealHostTestApp;
}

let root: string;
let app: RealHostTestApp;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-apps-create-"));
  app = await buildRealHostTestApp(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("POST /api/apps against a real LocalHost", () => {
  it("creates the directory and compose.yaml ON DISK, not just in the response", async () => {
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });

    expect(res.statusCode).toBe(201);
    const composePath = join(root, "jellyfin", "compose.yaml");
    const content = await readFile(composePath, "utf8");
    expect(content).toContain("services:");
    const dirs = await readdir(root);
    expect(dirs).toContain("jellyfin");
  });

  it("refuses a second create of the same directory with 409, and does not touch the file", async () => {
    const { cookie } = await signUpAdmin(app);
    const first = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin", directory: "jellyfin" },
    });
    expect(first.statusCode).toBe(201);
    const composePath = join(root, "jellyfin", "compose.yaml");
    const before = await readFile(composePath, "utf8");

    const second = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Jellyfin Two", directory: "jellyfin" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("directory_exists");
    const after = await readFile(composePath, "utf8");
    expect(after).toBe(before);
  });

  it("rejects a directory name with a separator before anything is created", async () => {
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie },
      payload: { displayName: "Escape", directory: "a/b" },
    });
    // Caught by the zod shape check before the handler body runs at all.
    expect(res.statusCode).toBe(400);
    const dirs = await readdir(root);
    expect(dirs).not.toContain("a");
  });

  it("createAppDirectory is idempotent, so a retry after a later failure does not die on EEXIST", async () => {
    // A create can fail AFTER the directory exists — the compose write, the DB
    // transaction — and a retry with the same directory name must succeed rather than
    // throwing on a directory that is already there. This is exactly what
    // `mkdir(..., { recursive: true })` buys, and exactly what the binding check for
    // this test breaks by flipping it to `false`.
    const { host } = app.deps;
    await host.createAppDirectory("jellyfin");
    await expect(host.createAppDirectory("jellyfin")).resolves.toBeUndefined();
  });
});
