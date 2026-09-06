import { buildApp } from "./app.js";
import { createAuth } from "./auth/index.js";
import { ConfigError, loadConfig } from "./config.js";
import { ensureSecretKey } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import { dockerChecks } from "./docker/preflight.js";
import { dataDirChecks, runChecks } from "./preflight.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // The data directory is created by the data_dir_writable preflight check, not
  // here: an unwritable parent must surface as a clean FAIL line rather than a
  // raw EACCES stack from a mkdir that runs before the checks.
  const results = await runChecks([
    ...dataDirChecks(config),
    ...dockerChecks(),
  ]);
  for (const r of results) {
    console.log(
      `${r.ok ? "ok  " : "FAIL"}  ${r.label}${r.detail ? ` — ${r.detail}` : ""}`,
    );
  }
  const blocked = results.filter((r) => !r.ok && r.blocking);
  if (blocked.length > 0) {
    console.error(`\nStartup blocked by ${blocked.length} failed check(s).`);
    process.exit(1);
  }

  const key = await ensureSecretKey(config.dataDir, config.secretKey);
  const db = createDb(`${config.dataDir}/homestead.db`);
  await runMigrations(db);
  const auth = createAuth(db, {
    secret: key.toString("hex"),
    baseURL: config.baseUrl,
    trustedOrigins: config.trustedOrigins,
  });
  const app = await buildApp({
    db,
    auth,
    logger: true,
    projectsDir: config.projectsDir,
    projectsHostDir: config.projectsHostDir,
    dataDir: config.dataDir,
  });
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

try {
  await main();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
