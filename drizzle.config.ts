import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: `file:${process.env.HOMESTEAD_DB_PATH ?? "./data/homestead.db"}` },
});
