import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey(),
    projectSlug: text("project_slug").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    exitCode: integer("exit_code"),
    actorUserId: text("actor_user_id"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    output: text("output").notNull().default(""),
  },
  // The history query is `WHERE project_slug = ? ORDER BY started_at DESC`
  // against a table that grows forever and carries full command output.
  (t) => [
    index("operations_project_slug_started_at_idx").on(
      t.projectSlug,
      t.startedAt,
    ),
  ],
);

export * from "./auth-schema.js";
