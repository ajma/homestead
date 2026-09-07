import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

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

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  /** Null for a manually added device — a printer, a switch, an old NAS. */
  tailscaleNodeId: text("tailscale_node_id"),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  notes: text("notes"),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  lastSyncedAt: integer("last_synced_at"),
  // Synced Tailscale fields. `lastSeen` is null while the device is online —
  // Tailscale omits it when `connectedToControl` is true — so online-ness is
  // read from `connectedToControl`, never from the age of `lastSeen`.
  hostname: text("hostname"),
  os: text("os"),
  addresses: text("addresses"),
  user: text("user"),
  clientVersion: text("client_version"),
  updateAvailable: integer("update_available", { mode: "boolean" }),
  tags: text("tags"),
  isEphemeral: integer("is_ephemeral", { mode: "boolean" }),
  isExternal: integer("is_external", { mode: "boolean" }),
  blocksIncomingConnections: integer("blocks_incoming_connections", {
    mode: "boolean",
  }),
  connectedToControl: integer("connected_to_control", { mode: "boolean" }),
  lastSeen: integer("last_seen"),
});

export const monitors = sqliteTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type").notNull(),
    /**
     * Text, not a foreign key. A device is a uuid; an app is `project_slug:service`
     * or `manual:<id>`. Identity is deliberately NOT the published port — moving a
     * service to another port would otherwise discard its whole uptime history.
     * The port is the join key to exposures, which is a different job.
     */
    targetId: text("target_id").notNull(),
    type: text("type").notNull(),
    config: text("config").notNull(),
    intervalSeconds: integer("interval_seconds").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    retries: integer("retries").notNull().default(0),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextDueAt: integer("next_due_at").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastPushAt: integer("last_push_at"),
  },
  // The runner's hot query is `WHERE enabled = 1 AND next_due_at <= ?`, and the
  // status rollup is `WHERE target_type = ? AND target_id = ?`.
  (t) => [
    index("monitors_due_idx").on(t.enabled, t.nextDueAt),
    index("monitors_target_idx").on(t.targetType, t.targetId),
  ],
);

export const checks = sqliteTable(
  "checks",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id").notNull(),
    at: integer("at").notNull(),
    up: integer("up", { mode: "boolean" }).notNull(),
    /** Measured to enforce the timeout; stored because discarding it would be
     *  a choice, not a saving. Nothing reads it yet (spec §1). */
    durationMs: integer("duration_ms"),
    error: text("error"),
  },
  // Every read is `WHERE monitor_id = ? AND at >= ? ORDER BY at`, and the prune
  // is `WHERE at < ?`.
  (t) => [index("checks_monitor_at_idx").on(t.monitorId, t.at)],
);

export const checkRollups = sqliteTable(
  "check_rollups",
  {
    monitorId: text("monitor_id").notNull(),
    hourStartedAt: integer("hour_started_at").notNull(),
    upCount: integer("up_count").notNull(),
    downCount: integer("down_count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.hourStartedAt] })],
);

export const exposures = sqliteTable(
  "exposures",
  {
    id: text("id").primaryKey(),
    /**
     * Nullable: an exposure is fundamentally "host port -> hostname", so a bare
     * host service or an unmanaged stack can be tunnelled.
     */
    projectSlug: text("project_slug"),
    /**
     * The join key across exposures, tiles and probes. No service name is
     * stored: it is derived from `docker compose config` at read time, because
     * storing a derivation beside its source lets the two drift.
     */
    hostPort: integer("host_port").notNull(),
    zoneId: text("zone_id").notNull(),
    hostname: text("hostname").notNull().unique(),
    scheme: text("scheme").notNull().default("http"),
    /** Unifi and Proxmox serve HTTPS with a self-signed cert; cloudflared refuses those by default. */
    noTlsVerify: integer("no_tls_verify", { mode: "boolean" })
      .notNull()
      .default(false),
    label: text("label"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    accessEnabled: integer("access_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    accessAppId: text("access_app_id"),
  },
  (t) => [index("exposures_port_idx").on(t.hostPort)],
);

export const manualApps = sqliteTable("manual_apps", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The only thing we know about a manual app, so it is also what we monitor. */
  url: text("url").notNull(),
  iconSlug: text("icon_slug"),
  iconUrl: text("icon_url"),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
});

export * from "./auth-schema.js";
