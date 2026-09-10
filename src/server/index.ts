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
const registry = createRegistryClient({ fetch });
const images = new ImageUpdateChecker({ db, host, composeConfig, registry });

const app = await buildApp({
  config,
  db,
  host,
  secrets: new SecretStore(db, config.secretKey),
  auth,
  composeConfig,
  jobs,
  images,
});

await app.listen({ port: config.port, host: "0.0.0.0" });
