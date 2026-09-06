import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  projectSlug: text("project_slug").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  exitCode: integer("exit_code"),
  actorUserId: text("actor_user_id"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  output: text("output").notNull().default(""),
});

export * from "./auth-schema.js";
