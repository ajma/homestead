import { buildApp } from "./app.js";
import { ComposeConfigCache } from "./apps/compose-config.js";
import { ImageUpdateChecker } from "./apps/image-updates.js";
import { JobRunner } from "./apps/job-runner.js";
import { createRegistryClient } from "./apps/registry.js";
import { sweepStrandedJobs } from "./apps/sweep.js";
import { createAuth } from "./auth/auth.js";
import { ensureLocalHost, LOCAL_HOST_ID } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { SecretStore } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import { LocalHost } from "./host/local-host.js";
import { runMountPreflight } from "./host/preflight.js";
import { IconMetadata } from "./icons/metadata.js";
import { IconStore } from "./icons/store.js";
import { dockerRunner } from "./monitoring/docker-runner.js";
import { createHttpRunners } from "./monitoring/http-runner.js";
import { RetentionTimer } from "./monitoring/retention.js";
import { Scheduler } from "./monitoring/scheduler.js";
import { EventBus } from "./routes/events.js";
import { startServer } from "./startup.js";

const config = loadConfig(process.env);

// Everything here is composition: real Node/Docker/Fastify dependencies wired into
// `startServer`, which owns the ordering. See `startup.ts` for why that split exists and
// what each ordering choice protects.
await startServer({
  skipPreflight: config.skipMountPreflight,
  runPreflight: () =>
    runMountPreflight({ composeRoot: config.composeRoot, dockerSocket: config.dockerSocket }),

  createDb: async () => {
    const { client, db } = await createDb(config.dbPath);
    return { db, closeDb: () => client.close() };
  },
  runMigrations,
  sweepStrandedJobs,
  now: () => Math.floor(Date.now() / 1000),

  buildRuntime: async (db) => {
    await ensureLocalHost(db, config);

    const host = new LocalHost(LOCAL_HOST_ID, config.composeRoot, config.dockerSocket);
    await host.init();

    const auth = createAuth(config, db);
    const composeConfig = new ComposeConfigCache(host);
    const jobs = new JobRunner({ db, host, composeConfig });
    const registry = createRegistryClient({
      fetch,
      onError: (image, reason) => {
        // Not fatal: `latestDigest` returns null and the sweep continues. But a registry
        // failing every day for a month should leave a trail.
        console.warn(`[image-check] ${image}: ${reason}`);
      },
    });
    const images = new ImageUpdateChecker({ db, host, composeConfig, registry });
    const httpRunners = createHttpRunners({ fetch });
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
      onProbeError: (probeId, error) => {
        // Not fatal: the scheduler moves on to the next probe. But a wedged database or a
        // bad migration dropping results silently is exactly what this earns its keep by
        // not doing — same reasoning as the registry client's `onError` above.
        console.error(`[monitoring] probe ${probeId}:`, error);
      },
    });
    scheduler.onTransition((transition) => events.publish(transition));
    const retention = new RetentionTimer({
      db,
      onError: (error) => {
        // Not fatal: today's failed prune is tomorrow's disk-space problem, not a reason
        // to take the timer down — same reasoning as the scheduler's onProbeError above.
        console.error("[retention] failed:", error);
      },
    });

    const iconMetadata = new IconMetadata({ cacheDir: config.iconCacheDir });
    const iconStore = new IconStore({ cacheDir: config.iconCacheDir, metadata: iconMetadata });
    // Started, not awaited. The launcher needs the catalogue only for search and for
    // resolving a slug — never to render a tile — so there is nothing to gain from holding
    // `listen` behind it. Measured against a black-holed network: awaiting this here left
    // the port closed for the full ten-second fetch timeout on every boot. `load()` already
    // degrades to an empty index rather than rejecting; the `catch` is a second line of
    // defence, not the reason this is safe to leave unawaited.
    void iconMetadata.load().catch(() => {});

    const app = await buildApp({
      config,
      db,
      host,
      secrets: new SecretStore(db, config.secretKey),
      auth,
      composeConfig,
      jobs,
      images,
      scheduler,
      events,
      icons: { metadata: iconMetadata, store: iconStore },
      preflight: () =>
        runMountPreflight({ composeRoot: config.composeRoot, dockerSocket: config.dockerSocket }),
    });

    return {
      closeable: {
        scheduler,
        retention,
        jobs,
        events,
        server: { close: () => app.close() },
      },
      startTimers: () => {
        scheduler.start();
        retention.start();
      },
      listen: async (opts) => {
        await app.listen({ port: opts.port, host: opts.host });
      },
    };
  },

  listenOptions: { port: config.port, host: "0.0.0.0" },
  signals: ["SIGTERM", "SIGINT"],
  onSignal: (signal, handler) => process.on(signal, handler),
  onUncaughtException: (handler) => process.on("uncaughtException", handler),
  onUnhandledRejection: (handler) => process.on("unhandledRejection", handler),
  exit: (code) => process.exit(code),
  log: { info: console.log, warn: console.warn, error: console.error },
}).catch((error) => {
  // A boot failure — a refused preflight, a failed migration, a port already in use — is
  // fatal by design (Important 3 in 1H's whole-branch review): the alternative is a
  // container `docker inspect` calls `running` forever with nothing listening, which
  // `restart: unless-stopped` never notices. Exiting explicitly here, rather than relying
  // on an unhandled top-level-await rejection to do it, means the non-zero exit code does
  // not depend on Node's unhandled-rejection mode being left at its default.
  console.error("[startup] fatal:", error);
  process.exit(1);
});
