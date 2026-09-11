import { buildApp } from "./app.js";
import { ComposeConfigCache } from "./apps/compose-config.js";
import { ImageUpdateChecker } from "./apps/image-updates.js";
import { JobRunner } from "./apps/job-runner.js";
import { createRegistryClient } from "./apps/registry.js";
import { createAuth } from "./auth/auth.js";
import { ensureLocalHost, LOCAL_HOST_ID } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { SecretStore } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import { LocalHost } from "./host/local-host.js";
import { PreflightError, runMountPreflight } from "./host/preflight.js";
import { dockerRunner } from "./monitoring/docker-runner.js";
import { createHttpRunners } from "./monitoring/http-runner.js";
import { RetentionTimer } from "./monitoring/retention.js";
import { Scheduler } from "./monitoring/scheduler.js";
import { EventBus } from "./routes/events.js";

const config = loadConfig(process.env);

if (!config.skipMountPreflight) {
  const result = await runMountPreflight({
    composeRoot: config.composeRoot,
    dockerSocket: config.dockerSocket,
  });
  if (!result.ok) throw new PreflightError(result.reason);
}

const { db } = await createDb(config.dbPath);
await runMigrations(db);

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
});

scheduler.start();
retention.start();

// Required shutdown order for the SIGTERM handler the Dockerfile task will add (out of
// scope here — see the phase carry-forward): stop `scheduler` and `retention` first so
// no new work starts, then `events.closeAll()` so every open `/api/events` stream ends —
// `app.close()` measurably does not resolve while one is still open — and only then
// `app.close()` itself. 1C's launcher streams are permanent for as long as a tab is
// open, unlike 1B's job streams which ended with their job, so this ordering matters more
// than it did when the handler was first deferred.

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
