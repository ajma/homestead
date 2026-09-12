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
import { PreflightError, runMountPreflight } from "./host/preflight.js";
import { IconMetadata } from "./icons/metadata.js";
import { IconStore } from "./icons/store.js";
import { dockerRunner } from "./monitoring/docker-runner.js";
import { createHttpRunners } from "./monitoring/http-runner.js";
import { RetentionTimer } from "./monitoring/retention.js";
import { Scheduler } from "./monitoring/scheduler.js";
import { EventBus } from "./routes/events.js";
import { createShutdown } from "./shutdown.js";

const config = loadConfig(process.env);

if (!config.skipMountPreflight) {
  const result = await runMountPreflight({
    composeRoot: config.composeRoot,
    dockerSocket: config.dockerSocket,
  });
  if (!result.ok) throw new PreflightError(result.reason);
}

const { client: dbClient, db } = await createDb(config.dbPath);
await runMigrations(db);

// Before anything can start a new job. A `running` row at this point is from a previous
// life of this process — see `sweepStrandedJobs`.
const swept = await sweepStrandedJobs(db, Math.floor(Date.now() / 1000));
if (swept > 0) console.warn(`[startup] Marked ${swept} interrupted job(s) as failed.`);

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
    // Not fatal: today's failed prune is tomorrow's disk-space problem, not a reason to
    // take the timer down — same reasoning as the scheduler's onProbeError above.
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

scheduler.start();
retention.start();

const shutdown = createShutdown({
  scheduler,
  retention,
  jobs,
  events,
  server: { close: () => app.close() },
  db: { close: () => dbClient.close() },
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal} received.`);
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

// A single-process appliance on a NAS should log and keep serving rather than vanish.
// The JobRunner.finish catch is the real fix for item 1; these are defence in depth so
// that the next unhandled rejection someone introduces produces a log line rather than
// a mystery restart.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[process] Unhandled rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception:", error);
});

await app.listen({ port: config.port, host: "0.0.0.0" });
