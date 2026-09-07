import { and, eq } from "drizzle-orm";
import { buildApp } from "./app.js";
import { syncAppMonitors } from "./apps/sync.js";
import { createAuth } from "./auth/index.js";
import { createCloudflareClient } from "./cloudflare/client.js";
import { syncAllowPolicy } from "./cloudflare/sync-users.js";
import { ConfigError, loadConfig } from "./config.js";
import { decrypt, ensureSecretKey } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import { exposures, settings } from "./db/schema.js";
import { composeConfig } from "./docker/compose.js";
import { dockerChecks } from "./docker/preflight.js";
import { createRunner } from "./monitoring/runner.js";
import { dataDirChecks, runChecks } from "./preflight.js";
import { scanProjects } from "./projects/store.js";

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
    secretKey: key,
    logger: true,
    projectsDir: config.projectsDir,
    projectsHostDir: config.projectsHostDir,
    dataDir: config.dataDir,
  });

  // Build the user sync function for the runner
  const syncUsersToCloudflare = async (_now: number): Promise<void> => {
    const settingsRows = await db.select().from(settings);
    const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]));

    const accountId = settingsMap.get("cloudflare.accountId");
    const policyAllowId = settingsMap.get("cloudflare.policyAllowId");
    const idpId = settingsMap.get("cloudflare.idpId");
    const encryptedToken = settingsMap.get("cloudflare.apiToken");

    if (!accountId || !policyAllowId || !idpId || !encryptedToken) {
      return; // Not configured yet
    }

    const token = decrypt(encryptedToken, key);
    const client = createCloudflareClient({ token });
    const result = await syncAllowPolicy(
      db,
      client,
      accountId,
      policyAllowId,
      idpId,
    );

    if (!result.synced) {
      console.warn(`Cloudflare user sync conflict: ${result.conflict}`);
    }
  };

  // Build the app sync function for the runner
  const syncAppsToDb = async (_now: number): Promise<void> => {
    await syncAppMonitors(db, {
      listProjects: async () => {
        const entries = await scanProjects(config.projectsDir);
        return entries.map((e) => e.slug);
      },
      composeConfig: async (slug: string) =>
        composeConfig(
          {
            projectsDir: config.projectsDir,
            projectsHostDir: config.projectsHostDir,
            dataDir: config.dataDir,
            slug,
          },
          undefined,
        ),
      hostnameFor: async (slug: string, hostPort: number) => {
        const [exposure] = await db
          .select({ hostname: exposures.hostname })
          .from(exposures)
          .where(
            and(
              eq(exposures.projectSlug, slug),
              eq(exposures.hostPort, hostPort),
            ),
          );
        return exposure?.hostname ?? null;
      },
    });
  };

  // Start the monitor runner AFTER buildApp, so route tests never start it
  const runner = createRunner({
    db,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const id = setInterval(fn, ms);
      return { cancel: () => clearInterval(id) };
    },
    syncUsers: syncUsersToCloudflare,
    syncApps: syncAppsToDb,
    projectsDir: config.projectsDir,
    projectsHostDir: config.projectsHostDir,
    dataDir: config.dataDir,
  });
  runner.start();

  // Run initial sync at startup
  try {
    await syncUsersToCloudflare(Date.now());
    console.log("Cloudflare allow policy synced");
  } catch (err) {
    console.error("Failed to sync Cloudflare allow policy at startup:", err);
  }

  // Register shutdown handlers
  const shutdown = async () => {
    console.log("Shutting down...");
    runner.stop();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
