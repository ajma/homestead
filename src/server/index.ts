import { mkdir } from "node:fs/promises";
import { buildApp } from "./app.js";
import { createAuth } from "./auth/index.js";
import { loadConfig } from "./config.js";
import { ensureSecretKey } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import { dataDirChecks, runChecks } from "./preflight.js";

const config = loadConfig(process.env);
await mkdir(config.dataDir, { recursive: true });
const results = await runChecks(dataDirChecks(config));
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
const db = createDb(`${config.dataDir}/homestacks.db`);
await runMigrations(db);
const auth = createAuth(db, {
  secret: key.toString("hex"),
  baseURL: `http://localhost:${config.port}`,
});
const app = await buildApp({ db, auth });
await app.listen({ port: config.port, host: "0.0.0.0" });
