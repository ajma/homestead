import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

// ── Better-Auth owned tables ────────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  // Homestead additional fields. `role` and `scopeAllApps` are server-owned.
  role: text("role", { enum: ["admin", "viewer"] })
    .notNull()
    .default("viewer"),
  scopeAllApps: integer("scope_all_apps", { mode: "boolean" }).notNull().default(true),
  disabledAt: integer("disabled_at"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: integer("access_token_expires_at"),
  refreshTokenExpiresAt: integer("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

// ── Homestead domain ────────────────────────────────────────────────────────

export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["local"] })
    .notNull()
    .default("local"),
  composeRoot: text("compose_root").notNull(),
  dockerSocket: text("docker_socket").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

export const apps = sqliteTable(
  "apps",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    iconRef: text("icon_ref"),
    category: text("category"),
    sortOrder: integer("sort_order").notNull().default(0),
    showOnLauncher: integer("show_on_launcher", { mode: "boolean" }).notNull().default(true),
    directory: text("directory").notNull(),
    composeFile: text("compose_file").notNull(),
    projectName: text("project_name").notNull(),
    launchInternalUrl: text("launch_internal_url"),
    lastComposeHash: text("last_compose_hash"),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    graceUntil: integer("grace_until"),
    adoptedAt: integer("adopted_at").notNull().default(now),
    archivedAt: integer("archived_at"),
  },
  (t) => [
    unique("apps_host_slug").on(t.hostId, t.slug),
    unique("apps_host_directory").on(t.hostId, t.directory),
    index("apps_launcher_idx").on(t.showOnLauncher, t.category, t.sortOrder),
  ],
);

export const probes = sqliteTable(
  "probes",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["docker", "http_internal", "http_external"] }).notNull(),
    label: text("label"),
    target: text("target"),
    expectedStatusPattern: text("expected_status_pattern").notNull().default("2xx,3xx"),
    timeoutMs: integer("timeout_ms").notNull().default(5000),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    insecureTls: integer("insecure_tls", { mode: "boolean" }).notNull().default(false),
    followRedirects: integer("follow_redirects", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextRunAt: integer("next_run_at").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    // Denormalised current state. Written in the same transaction as check_results.
    lastStatus: text("last_status", { enum: ["up", "degraded", "down", "starting", "unknown"] })
      .notNull()
      .default("unknown"),
    lastLatencyMs: integer("last_latency_ms"),
    lastDetail: text("last_detail", { mode: "json" }).$type<Record<string, unknown> | null>(),
    lastFaultClass: text("last_fault_class", { enum: ["app", "network", "config"] }),
    lastCheckedAt: integer("last_checked_at"),
    statusSince: integer("status_since"),
  },
  (t) => [index("probes_due_idx").on(t.enabled, t.nextRunAt), index("probes_app_idx").on(t.appId)],
);

export const checkResults = sqliteTable(
  "check_results",
  {
    id: text("id").primaryKey(),
    probeId: text("probe_id")
      .notNull()
      .references(() => probes.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["up", "degraded", "down", "starting", "unknown"] }).notNull(),
    faultClass: text("fault_class", { enum: ["app", "network", "config"] }),
    latencyMs: integer("latency_ms"),
    detail: text("detail", { mode: "json" }),
    checkedAt: integer("checked_at").notNull(),
  },
  (t) => [index("check_results_probe_time_idx").on(t.probeId, t.checkedAt)],
);

export const checkRollups = sqliteTable(
  "check_rollups",
  {
    probeId: text("probe_id")
      .notNull()
      .references(() => probes.id, { onDelete: "cascade" }),
    hourStart: integer("hour_start").notNull(),
    upCount: integer("up_count").notNull().default(0),
    degradedCount: integer("degraded_count").notNull().default(0),
    downCount: integer("down_count").notNull().default(0),
    avgLatencyMs: integer("avg_latency_ms"),
    maxLatencyMs: integer("max_latency_ms"),
  },
  (t) => [primaryKey({ columns: [t.probeId, t.hourStart] })],
);

// Unused in Phase 1. Present because the data model cannot be phased.
export const exposures = sqliteTable("exposures", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .unique()
    .references(() => apps.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull().unique(),
  zoneId: text("zone_id"),
  dnsRecordId: text("dns_record_id"),
  tunnelId: text("tunnel_id"),
  ingressService: text("ingress_service").notNull(),
  accessAppId: text("access_app_id"),
  accessAppAud: text("access_app_aud"),
  dnsRecordCreatedByUs: integer("dns_record_created_by_us", { mode: "boolean" })
    .notNull()
    .default(false),
  ingressRuleCreatedByUs: integer("ingress_rule_created_by_us", { mode: "boolean" })
    .notNull()
    .default(false),
  accessAppCreatedByUs: integer("access_app_created_by_us", { mode: "boolean" })
    .notNull()
    .default(false),
  state: text("state", { enum: ["provisioning", "ready", "error", "drifted"] })
    .notNull()
    .default("provisioning"),
  lastError: text("last_error"),
  lastSyncedAt: integer("last_synced_at"),
});

export const userAppScope = sqliteTable(
  "user_app_scope",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.appId] })],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    exitCode: integer("exit_code"),
    output: text("output"),
    userId: text("user_id").references(() => users.id),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("jobs_app_created_idx").on(t.appId, t.createdAt)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id),
    authPath: text("auth_path", { enum: ["password", "access", "system"] }).notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: text("detail", { mode: "json" }),
    ip: text("ip"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

export const secrets = sqliteTable("secrets", {
  key: text("key").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  tag: text("tag").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const imageStatus = sqliteTable(
  "image_status",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    serviceName: text("service_name").notNull(),
    currentDigest: text("current_digest"),
    latestDigest: text("latest_digest"),
    updateAvailable: integer("update_available", { mode: "boolean" }).notNull().default(false),
    checkedAt: integer("checked_at"),
  },
  (t) => [primaryKey({ columns: [t.appId, t.serviceName] })],
);

export const setupState = sqliteTable("setup_state", {
  id: integer("id").primaryKey().default(1),
  completedSteps: text("completed_steps", { mode: "json" }).notNull().default("[]"),
  completedAt: integer("completed_at"),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const schema = {
  users,
  sessions,
  accounts,
  verifications,
  hosts,
  apps,
  probes,
  checkResults,
  checkRollups,
  exposures,
  userAppScope,
  jobs,
  auditLog,
  secrets,
  settings,
  imageStatus,
  setupState,
};
