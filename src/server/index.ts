import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { dataDirChecks, portCheck, runChecks } from "./preflight.js";
import { scanProjects } from "./projects/store.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // The data directory is created by the data_dir_writable preflight check, not
  // here: an unwritable parent must surface as a clean FAIL line rather than a
  // raw EACCES stack from a mkdir that runs before the checks.
  const results = await runChecks([
    ...dataDirChecks(config),
    ...dockerChecks(),
    portCheck(config.port),
  ]);
  for (const r of results) {
    const msg = `${r.ok ? "ok  " : "FAIL"}  ${r.label}${r.detail ? ` — ${r.detail}` : ""}`;
    if (!r.ok && r.severity === "danger") {
      console.error(msg);
    } else {
      console.log(msg);
    }
  }

  const key = await ensureSecretKey(config.dataDir, config.secretKey);
  const db = createDb(`${config.dataDir}/homestead.db`);
  await runMigrations(db);
  const auth = createAuth(db, {
    secret: key.toString("hex"),
    baseURL: config.baseUrl,
    trustedOrigins: config.trustedOrigins,
  });

  // Compute webDir: use the env var if set, otherwise look for dist/web relative
  // to this file. In production (container or `pnpm start`), the server bundle is
  // at dist/server/index.js, so ../web resolves to dist/web. In dev mode, that
  // directory doesn't exist, which is correct — Vite serves the SPA separately.
  let webDir = config.webDir;
  if (!webDir) {
    const serverDir = dirname(fileURLToPath(import.meta.url));
    const candidateWebDir = join(serverDir, "../web");
    if (existsSync(candidateWebDir)) {
      webDir = candidateWebDir;
    }
  }

  const app = await buildApp({
    db,
    auth,
    secretKey: key,
    logger: true,
    projectsDir: config.projectsDir,
    projectsHostDir: config.projectsHostDir,
    dataDir: config.dataDir,
    webDir,
    preflight: results,
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
