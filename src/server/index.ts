import { buildApp } from "./app.js";
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

const host = new LocalHost("local", config.composeRoot, config.dockerSocket);
await host.init();

const app = await buildApp({
  config,
  db,
  host,
  secrets: new SecretStore(db, config.secretKey),
});

await app.listen({ port: config.port, host: "0.0.0.0" });
