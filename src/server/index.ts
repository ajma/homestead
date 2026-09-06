import { buildApp } from "./app.js";
import { createAuth } from "./auth/index.js";
import { loadConfig } from "./config.js";
import { ensureSecretKey } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";

const config = loadConfig(process.env);
const key = await ensureSecretKey(config.dataDir, config.secretKey);
const db = createDb(`${config.dataDir}/homestacks.db`);
await runMigrations(db);
const auth = createAuth(db, {
  secret: key.toString("hex"),
  baseURL: `http://localhost:${config.port}`,
});
const app = await buildApp({ db, auth });
await app.listen({ port: config.port, host: "0.0.0.0" });
