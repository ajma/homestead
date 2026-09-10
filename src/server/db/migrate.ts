import { loadConfig } from "../config.js";
import { createDb, runMigrations } from "./client.js";

const config = loadConfig(process.env);
const { db } = await createDb(config.dbPath);
await runMigrations(db);
console.log(`Migrations applied to ${config.dbPath}`);
