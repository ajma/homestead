import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  DeviceKind,
  DeviceSummary,
  HistoryBucket,
  MonitorState,
  MonitorSummary,
  MonitorType,
  UptimeWindow,
} from "@shared/monitoring.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/guard.js";
import { encrypt } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import {
  checkRollups,
  checks,
  devices,
  monitors,
  settings,
} from "../db/schema.js";
import type { MonitorLatest } from "../monitoring/status.js";
import { resolveStatus } from "../monitoring/status.js";
import { historyBuckets, uptimeRatio } from "../monitoring/uptime.js";
import {
  createTailscaleClient,
  type TailscaleClient,
} from "../tailscale/client.js";
import { syncDevices } from "../tailscale/sync.js";

type Opts = {
  db: Db;
  secretKey: Buffer;
  tailscale?: (opts: { tailnet: string; token: string }) => TailscaleClient;
};

const deviceKindEnum = z.enum(["phone", "laptop", "nas", "vm", "other"]);

const createDeviceBody = z.object({
  name: z.string().min(1),
  kind: deviceKindEnum,
  notes: z.string().optional(),
  hidden: z.boolean().optional(),
});

const updateDeviceBody = z
  .object({
    name: z.string().min(1).optional(),
    kind: deviceKindEnum.optional(),
    notes: z.string().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

/**
 * `intervalSeconds` and `timeoutMs` default rather than being required.
 *
 * They were required, and the Add Monitor dialog does not ask for them — it
 * collects a type and the config that type needs — so every monitor created
 * through the UI was rejected with a 400. The defaults match the ones app
 * monitors are provisioned with, and the editor can change them afterwards.
 */
const createMonitorBody = z.object({
  type: z.enum(["tailscale", "tcp", "http", "dns", "push"]),
  config: z.record(z.string(), z.unknown()),
  intervalSeconds: z.number().int().positive().default(60),
  timeoutMs: z.number().int().positive().default(5000),
  retries: z.number().int().min(0).optional(),
  required: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const updateMonitorBody = z
  .object({
    config: z.record(z.string(), z.unknown()).optional(),
    intervalSeconds: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    retries: z.number().int().min(0).optional(),
    required: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const deviceRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db } = opts;

  app.get(
    "/api/devices",
    { preHandler: requirePermission({ device: ["read"] }) },
    async () => {
      // Fetch all devices
      const allDevices = await db.select().from(devices);

      // Fetch all monitors for these devices
      const allMonitors = await db
        .select()
        .from(monitors)
        .where(eq(monitors.targetType, "device"));

      // Fetch latest check for each monitor - avoid N+1 by fetching all at once
      const monitorIds = allMonitors.map((m) => m.id);
      const latestChecks: Record<
        string,
        { up: boolean; at: number; error: string | null }
      > = {};

      if (monitorIds.length > 0) {
        const allChecks = await db
          .select()
          .from(checks)
          .where(inArray(checks.monitorId, monitorIds))
          .orderBy(desc(checks.at));

        // Group by monitor ID and keep only the latest
        for (const check of allChecks) {
          if (!latestChecks[check.monitorId]) {
            latestChecks[check.monitorId] = {
              up: check.up,
              at: check.at,
              error: check.error ?? null,
            };
          }
        }
      }

      // Group monitors by device and build DeviceSummary
      const deviceSummaries: DeviceSummary[] = allDevices.map((device) => {
        const deviceMonitors = allMonitors.filter(
          (m) => m.targetId === device.id,
        );

        const monitorLatest: MonitorLatest[] = deviceMonitors.map((m) => {
          const check = latestChecks[m.id];
          return {
            id: m.id,
            type: m.type as MonitorType,
            required: m.required,
            enabled: m.enabled,
            up: check?.up ?? null,
            error: check?.error ?? null,
            at: check?.at ?? null,
          };
        });

        const status = resolveStatus(monitorLatest);

        return {
          id: device.id,
          name: device.name,
          kind: device.kind as DeviceKind,
          hidden: device.hidden,
          tailscaleNodeId: device.tailscaleNodeId,
          connectedToControl: device.connectedToControl,
          lastSeen: device.lastSeen,
          os: device.os,
          status,
        };
      });

      return { devices: deviceSummaries };
    },
  );

  app.post(
    "/api/devices",
    { preHandler: requirePermission({ device: ["create"] }) },
    async (request, reply) => {
      const body = createDeviceBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: "invalid_body" });

      const id = randomUUID();
      await db.insert(devices).values({
        id,
        name: body.data.name,
        kind: body.data.kind,
        notes: body.data.notes ?? null,
        hidden: body.data.hidden ?? false,
        tailscaleNodeId: null,
      });

      return reply.status(201).send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/devices/:id",
    { preHandler: requirePermission({ device: ["read"] }) },
    async (request, reply) => {
      const { id } = request.params;

      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, id));
      if (!device) return reply.status(404).send({ error: "not_found" });

      // Fetch monitors for this device
      const deviceMonitors = await db
        .select()
        .from(monitors)
        .where(
          and(eq(monitors.targetType, "device"), eq(monitors.targetId, id)),
        );

      if (deviceMonitors.length === 0) {
        return {
          device: {
            id: device.id,
            name: device.name,
            kind: device.kind as DeviceKind,
            hidden: device.hidden,
            tailscaleNodeId: device.tailscaleNodeId,
            connectedToControl: device.connectedToControl,
            lastSeen: device.lastSeen,
            os: device.os,
            notes: device.notes,
          },
          monitors: [],
          uptime: [
            { windowMs: 86_400_000, ratio: null },
            { windowMs: 604_800_000, ratio: null },
            { windowMs: 2_592_000_000, ratio: null },
          ],
          history: historyBuckets([], Date.now() - 86_400_000, Date.now(), 48),
        };
      }

      const monitorIds = deviceMonitors.map((m) => m.id);

      // Batch fetch latest checks for all monitors (avoid N+1)
      const allLatestChecks = await db
        .select()
        .from(checks)
        .where(inArray(checks.monitorId, monitorIds))
        .orderBy(desc(checks.at));

      // Group by monitor ID and keep only the latest
      const latestByMonitor: Record<
        string,
        { up: boolean; at: number; error: string | null }
      > = {};
      for (const check of allLatestChecks) {
        if (!latestByMonitor[check.monitorId]) {
          latestByMonitor[check.monitorId] = {
            up: check.up,
            at: check.at,
            error: check.error ?? null,
          };
        }
      }

      // Build monitor summaries
      const monitorSummaries: MonitorSummary[] = deviceMonitors.map(
        (monitor) => {
          const latest = latestByMonitor[monitor.id];
          let state: MonitorState = "unknown";
          if (latest) {
            state = latest.up ? "up" : "down";
          }

          return {
            id: monitor.id,
            type: monitor.type as MonitorType,
            required: monitor.required,
            enabled: monitor.enabled,
            state,
            lastCheckedAt: latest?.at ?? null,
            error: latest?.error ?? null,
          };
        },
      );

      // Filter to enabled, required monitors for uptime/history calculations
      const relevantMonitors = deviceMonitors.filter(
        (m) => m.enabled && m.required,
      );

      const now = Date.now();
      const DAY = 86_400_000;
      const WEEK = 7 * DAY;
      const MONTH = 30 * DAY;

      let uptime: UptimeWindow[];
      let history: HistoryBucket[];

      if (relevantMonitors.length === 0) {
        // No enabled+required monitors: uptime and history are null/empty
        uptime = [
          { windowMs: DAY, ratio: null },
          { windowMs: WEEK, ratio: null },
          { windowMs: MONTH, ratio: null },
        ];
        history = historyBuckets([], now - DAY, now, 48);
      } else {
        const relevantMonitorIds = relevantMonitors.map((m) => m.id);

        // Batch fetch all checks and rollups for the widest window (30 days)
        const allChecks = await db
          .select()
          .from(checks)
          .where(
            and(
              inArray(checks.monitorId, relevantMonitorIds),
              gte(checks.at, now - MONTH),
            ),
          );

        // Fetch rollups with window filter
        const HOUR = 3_600_000;
        const allRollups = await db
          .select()
          .from(checkRollups)
          .where(
            and(
              inArray(checkRollups.monitorId, relevantMonitorIds),
              gte(checkRollups.hourStartedAt, now - MONTH - HOUR),
            ),
          );

        // Pool checks and rollups across all relevant monitors
        const pooledChecks = allChecks.map((c) => ({ at: c.at, up: c.up }));
        const pooledRollups = allRollups.map((r) => ({
          hourStartedAt: r.hourStartedAt,
          upCount: r.upCount,
          downCount: r.downCount,
        }));

        // Calculate uptime windows by slicing the pooled data
        uptime = [
          {
            windowMs: DAY,
            ratio: uptimeRatio(pooledChecks, pooledRollups, now - DAY, now),
          },
          {
            windowMs: WEEK,
            ratio: uptimeRatio(pooledChecks, pooledRollups, now - WEEK, now),
          },
          {
            windowMs: MONTH,
            ratio: uptimeRatio(pooledChecks, pooledRollups, now - MONTH, now),
          },
        ];

        // Calculate history buckets (48 buckets over 24 hours), pooled across monitors
        history = historyBuckets(pooledChecks, now - DAY, now, 48);
      }

      return {
        device: {
          id: device.id,
          name: device.name,
          kind: device.kind as DeviceKind,
          hidden: device.hidden,
          tailscaleNodeId: device.tailscaleNodeId,
          connectedToControl: device.connectedToControl,
          lastSeen: device.lastSeen,
          os: device.os,
          notes: device.notes,
        },
        monitors: monitorSummaries,
        uptime,
        history,
      };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/devices/:id",
    { preHandler: requirePermission({ device: ["update"] }) },
    async (request, reply) => {
      const { id } = request.params;

      const body = updateDeviceBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: "invalid_body" });

      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, id));
      if (!device) return reply.status(404).send({ error: "not_found" });

      const updates: Record<string, string | boolean | null> = {};
      if (body.data.name !== undefined) updates.name = body.data.name;
      if (body.data.kind !== undefined) updates.kind = body.data.kind;
      if (body.data.notes !== undefined) updates.notes = body.data.notes;
      if (body.data.hidden !== undefined) updates.hidden = body.data.hidden;

      if (Object.keys(updates).length > 0) {
        await db.update(devices).set(updates).where(eq(devices.id, id));
      }

      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/devices/:id",
    { preHandler: requirePermission({ device: ["delete"] }) },
    async (request, reply) => {
      const { id } = request.params;

      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, id));
      if (!device) return reply.status(404).send({ error: "not_found" });

      // Delete monitors for this device (and their checks via cascade)
      const deviceMonitors = await db
        .select()
        .from(monitors)
        .where(
          and(eq(monitors.targetType, "device"), eq(monitors.targetId, id)),
        );

      for (const monitor of deviceMonitors) {
        await db.delete(checks).where(eq(checks.monitorId, monitor.id));
        await db
          .delete(checkRollups)
          .where(eq(checkRollups.monitorId, monitor.id));
        await db.delete(monitors).where(eq(monitors.id, monitor.id));
      }

      await db.delete(devices).where(eq(devices.id, id));

      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/devices/:id/monitors",
    { preHandler: requirePermission({ monitor: ["create"] }) },
    async (request, reply) => {
      const { id } = request.params;

      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, id));
      if (!device) return reply.status(404).send({ error: "not_found" });

      const body = createMonitorBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: "invalid_body" });

      const monitorId = randomUUID();
      await db.insert(monitors).values({
        id: monitorId,
        targetType: "device",
        targetId: id,
        type: body.data.type,
        config: JSON.stringify(body.data.config),
        intervalSeconds: body.data.intervalSeconds,
        timeoutMs: body.data.timeoutMs,
        retries: body.data.retries ?? 0,
        required: body.data.required ?? true,
        enabled: body.data.enabled ?? true,
      });

      return reply.status(201).send({ id: monitorId });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/monitors/:id",
    { preHandler: requirePermission({ monitor: ["update"] }) },
    async (request, reply) => {
      const { id } = request.params;

      const body = updateMonitorBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: "invalid_body" });

      const [monitor] = await db
        .select()
        .from(monitors)
        .where(eq(monitors.id, id));
      if (!monitor) return reply.status(404).send({ error: "not_found" });

      const updates: Record<string, string | number | boolean> = {};
      if (body.data.config !== undefined)
        updates.config = JSON.stringify(body.data.config);
      if (body.data.intervalSeconds !== undefined)
        updates.intervalSeconds = body.data.intervalSeconds;
      if (body.data.timeoutMs !== undefined)
        updates.timeoutMs = body.data.timeoutMs;
      if (body.data.retries !== undefined) updates.retries = body.data.retries;
      if (body.data.required !== undefined)
        updates.required = body.data.required;
      if (body.data.enabled !== undefined) updates.enabled = body.data.enabled;

      if (Object.keys(updates).length > 0) {
        await db.update(monitors).set(updates).where(eq(monitors.id, id));
      }

      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/monitors/:id",
    { preHandler: requirePermission({ monitor: ["delete"] }) },
    async (request, reply) => {
      const { id } = request.params;

      const [monitor] = await db
        .select()
        .from(monitors)
        .where(eq(monitors.id, id));
      if (!monitor) return reply.status(404).send({ error: "not_found" });

      await db.delete(checks).where(eq(checks.monitorId, id));
      await db.delete(checkRollups).where(eq(checkRollups.monitorId, id));
      await db.delete(monitors).where(eq(monitors.id, id));

      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; token: string } }>(
    "/api/monitors/:id/push/:token",
    async (request, reply) => {
      const { id, token } = request.params;

      const [monitor] = await db
        .select()
        .from(monitors)
        .where(eq(monitors.id, id));

      // Return 404 for all failure cases (unknown id, wrong type, wrong token)
      // to avoid confirming which monitors or tokens exist
      if (monitor?.type !== "push") {
        return reply.status(404).send({ error: "not_found" });
      }

      // Parse the config to get the stored token
      let config: { token?: string; graceSeconds?: number };
      try {
        config = JSON.parse(monitor.config);
      } catch {
        return reply.status(404).send({ error: "not_found" });
      }

      // A monitor's config is stored as free-form JSON, so `token` is whatever
      // was written — a number, an array, null. Hashing a non-string throws,
      // and a 500 would tell an unauthenticated caller that this id exists and
      // is a push monitor, which every failure path here is shaped to conceal.
      if (typeof config.token !== "string" || config.token.length === 0) {
        return reply.status(404).send({ error: "not_found" });
      }

      // Compare tokens as SHA-256 digests to avoid length oracle
      // (timingSafeEqual throws if buffer lengths differ)
      const providedHash = createHash("sha256").update(token).digest();
      const storedHash = createHash("sha256").update(config.token).digest();

      if (!timingSafeEqual(providedHash, storedHash)) {
        return reply.status(404).send({ error: "not_found" });
      }

      // Valid token: update lastPushAt
      await db
        .update(monitors)
        .set({ lastPushAt: Date.now() })
        .where(eq(monitors.id, id));

      return reply.status(200).send({ ok: true });
    },
  );

  app.post(
    "/api/settings/tailscale",
    { preHandler: requirePermission({ settings: ["write"] }) },
    async (request, reply) => {
      const body = z
        .object({
          tailnet: z.string().min(1),
          token: z.string().min(1),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({ error: "invalid_body" });
      }

      const { tailnet, token } = body.data;

      // Create client and verify credentials by running a sync
      const clientFactory = opts.tailscale ?? createTailscaleClient;
      const client = clientFactory({ tailnet, token });

      let syncResult: { added: number; updated: number; skipped: number };
      try {
        syncResult = await syncDevices(db, client, Date.now());
      } catch (err) {
        // Don't include the token in the error message
        const message = err instanceof Error ? err.message : "sync failed";
        return reply.status(400).send({
          error: "sync_failed",
          detail: message.replace(token, "[REDACTED]"),
        });
      }

      // Only store if sync succeeded
      const encryptedToken = encrypt(token, opts.secretKey);

      // Upsert both settings
      await db
        .insert(settings)
        .values({ key: "tailscale.token", value: encryptedToken })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: encryptedToken },
        });

      await db
        .insert(settings)
        .values({ key: "tailscale.tailnet", value: tailnet })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: tailnet },
        });

      const deviceCount = syncResult.added + syncResult.updated;
      return { deviceCount };
    },
  );
};
