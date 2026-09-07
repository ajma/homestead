import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import {
  checkRollups,
  checks,
  devices,
  monitors,
  settings,
  user,
} from "../db/schema.js";
import type { TailscaleClient } from "../tailscale/client.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let auth: ReturnType<typeof createAuth>;
let root: string;
let adminCookie: string;
let viewerCookie: string;

/** Server-side sign-in: bypasses the HTTP rate limiter (5/min per file). */
async function signIn(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie returned");
  return cookie.split(";")[0]!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-devices-"));
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);

  // Default mock tailscale client (empty device list)
  const mockTailscale = (): TailscaleClient => ({
    listDevices: async () => [],
  });

  app = await buildApp({
    db,
    auth,
    secretKey: Buffer.alloc(32),
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
    tailscale: mockTailscale,
  });

  const a = await auth.api.signUpEmail({
    body: {
      email: "admin@example.com",
      name: "Admin",
      password: "correct-horse-battery",
    },
  });
  await db.update(user).set({ role: "admin" }).where(eq(user.id, a.user.id));
  await auth.api.signUpEmail({
    body: {
      email: "viewer@example.com",
      name: "Viewer",
      password: "correct-horse-battery",
    },
  });
  adminCookie = await signIn("admin@example.com", "correct-horse-battery");
  viewerCookie = await signIn("viewer@example.com", "correct-horse-battery");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/devices", () => {
  it("lists devices for an admin", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Phone",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({
      id: deviceId,
      name: "Test Phone",
      kind: "phone",
      hidden: false,
      tailscaleNodeId: null,
      connectedToControl: null,
      lastSeen: null,
      os: null,
      status: { state: "unknown", reason: null },
    });
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/devices",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/devices", () => {
  it("creates a manual device for an admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers: { cookie: adminCookie },
      payload: {
        name: "Network Printer",
        kind: "other",
        notes: "HP LaserJet in office",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty("id");
    expect(typeof body.id).toBe("string");

    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, body.id));
    expect(device).toMatchObject({
      name: "Network Printer",
      kind: "other",
      notes: "HP LaserJet in office",
      hidden: false,
      tailscaleNodeId: null,
    });
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers: { cookie: viewerCookie },
      payload: { name: "Test", kind: "other" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects invalid kind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers: { cookie: adminCookie },
      payload: { name: "Test", kind: "invalid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers: { cookie: adminCookie },
      payload: { kind: "phone" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/devices/:id", () => {
  it("returns device detail with monitors, uptime and history", async () => {
    const deviceId = randomUUID();
    const now = Date.now();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Laptop",
      kind: "laptop",
      tailscaleNodeId: "12345",
      connectedToControl: true,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "tailscale",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    await db.insert(checks).values({
      id: randomUUID(),
      monitorId,
      at: now - 60_000,
      up: true,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.device).toMatchObject({
      id: deviceId,
      name: "Test Laptop",
      kind: "laptop",
    });
    expect(body.monitors).toHaveLength(1);
    expect(body.monitors[0]).toMatchObject({
      id: monitorId,
      type: "tailscale",
      required: true,
      enabled: true,
      state: "up",
    });
    expect(body.uptime).toHaveLength(3);
    expect(body.uptime[0].windowMs).toBe(86_400_000); // 24 hours
    expect(body.uptime[1].windowMs).toBe(604_800_000); // 7 days
    expect(body.uptime[2].windowMs).toBe(2_592_000_000); // 30 days
    expect(body.history).toHaveLength(48);
  });

  it("returns 404 for unknown device", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/devices/${randomUUID()}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("is refused for a viewer", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("calculates 30-day uptime from rollups when raw checks are pruned", async () => {
    const deviceId = randomUUID();
    const now = Date.now();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "laptop",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    // Add rollups covering 30 days (raw checks would be pruned)
    const HOUR = 3_600_000;
    const rollups = [];
    for (let i = 0; i < 30 * 24; i++) {
      rollups.push({
        monitorId,
        hourStartedAt: now - 30 * 86_400_000 + i * HOUR,
        upCount: 50,
        downCount: 10,
      });
    }
    await db.insert(checkRollups).values(rollups);

    const res = await app.inject({
      method: "GET",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const monthUptime = body.uptime.find(
      (u: { windowMs: number }) => u.windowMs === 2_592_000_000,
    );
    expect(monthUptime).toBeTruthy();
    expect(monthUptime.ratio).toBeCloseTo(50 / 60, 2);
  });

  it("excludes advisory monitors from uptime calculation", async () => {
    const deviceId = randomUUID();
    const now = Date.now();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "laptop",
      tailscaleNodeId: null,
    });

    // Required monitor - all up
    const requiredId = randomUUID();
    await db.insert(monitors).values({
      id: requiredId,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });
    await db.insert(checks).values({
      id: randomUUID(),
      monitorId: requiredId,
      at: now - 1000,
      up: true,
    });

    // Advisory monitor - all down (should not affect uptime)
    const advisoryId = randomUUID();
    await db.insert(monitors).values({
      id: advisoryId,
      targetType: "device",
      targetId: deviceId,
      type: "http",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: false,
      enabled: true,
    });
    await db.insert(checks).values({
      id: randomUUID(),
      monitorId: advisoryId,
      at: now - 1000,
      up: false,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const dayUptime = body.uptime.find(
      (u: { windowMs: number }) => u.windowMs === 86_400_000,
    );
    expect(dayUptime.ratio).toBe(1.0); // 100% from required monitor only
  });

  it("pools history across multiple monitors", async () => {
    const deviceId = randomUUID();
    const now = Date.now();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "laptop",
      tailscaleNodeId: null,
    });

    // First monitor - all up
    const monitor1Id = randomUUID();
    await db.insert(monitors).values({
      id: monitor1Id,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });
    await db.insert(checks).values([
      {
        id: randomUUID(),
        monitorId: monitor1Id,
        at: now - 3600_000,
        up: true,
      },
      {
        id: randomUUID(),
        monitorId: monitor1Id,
        at: now - 1800_000,
        up: true,
      },
    ]);

    // Second monitor - all down
    const monitor2Id = randomUUID();
    await db.insert(monitors).values({
      id: monitor2Id,
      targetType: "device",
      targetId: deviceId,
      type: "http",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });
    await db.insert(checks).values([
      {
        id: randomUUID(),
        monitorId: monitor2Id,
        at: now - 3600_000,
        up: false,
      },
      {
        id: randomUUID(),
        monitorId: monitor2Id,
        at: now - 1800_000,
        up: false,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.history).toHaveLength(48);
    // History should reflect both monitors (pooled)
    // With 2 up and 2 down checks, some buckets will have mixed ratios
    const nonNullBuckets = body.history.filter(
      (b: { ratio: number | null }) => b.ratio !== null,
    );
    expect(nonNullBuckets.length).toBeGreaterThan(0);
    // At least one bucket should show the pooled ratio (0.5 from 2 up, 2 down)
    const pooledBucket = nonNullBuckets.find(
      (b: { ratio: number }) => b.ratio > 0 && b.ratio < 1,
    );
    expect(pooledBucket).toBeTruthy();
  });
});

describe("PATCH /api/devices/:id", () => {
  it("updates user-owned fields for a manual device", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Old Name",
      kind: "phone",
      notes: "Old notes",
      hidden: false,
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: adminCookie },
      payload: {
        name: "New Name",
        kind: "laptop",
        notes: "New notes",
        hidden: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId));
    expect(device).toMatchObject({
      name: "New Name",
      kind: "laptop",
      notes: "New notes",
      hidden: true,
    });
  });

  it("rejects patching Tailscale-owned fields", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: adminCookie },
      payload: {
        name: "Test",
        connectedToControl: true,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid kind", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: adminCookie },
      payload: { kind: "invalid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for unknown device", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${randomUUID()}`,
      headers: { cookie: adminCookie },
      payload: { name: "Test" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("is refused for a viewer", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: viewerCookie },
      payload: { name: "New Name" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/devices/:id", () => {
  it("deletes a device and its monitors", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId));
    expect(device).toBeUndefined();

    const [monitor] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitorId));
    expect(monitor).toBeUndefined();
  });

  it("returns 404 for unknown device", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/devices/${randomUUID()}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("is refused for a viewer", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/devices/:id/monitors", () => {
  it("creates a monitor for a device", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "nas",
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/devices/${deviceId}/monitors`,
      headers: { cookie: adminCookie },
      payload: {
        type: "tcp",
        config: { host: "192.168.1.10", port: 22 },
        intervalSeconds: 60,
        timeoutMs: 5000,
        required: true,
        enabled: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty("id");

    const [monitor] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, body.id));
    expect(monitor).toMatchObject({
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });
  });

  it("returns 404 for unknown device", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/devices/${randomUUID()}/monitors`,
      headers: { cookie: adminCookie },
      payload: {
        type: "tcp",
        config: {},
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("is refused for a viewer", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/devices/${deviceId}/monitors`,
      headers: { cookie: viewerCookie },
      payload: {
        type: "tcp",
        config: {},
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PATCH /api/monitors/:id", () => {
  it("updates a monitor", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: JSON.stringify({ host: "192.168.1.1", port: 22 }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/monitors/${monitorId}`,
      headers: { cookie: adminCookie },
      payload: {
        config: { host: "192.168.1.2", port: 80 },
        intervalSeconds: 120,
        required: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [monitor] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitorId));
    if (!monitor) throw new Error("monitor was not found after the patch");
    expect(monitor).toMatchObject({
      intervalSeconds: 120,
      required: false,
    });
    expect(JSON.parse(monitor.config)).toEqual({
      host: "192.168.1.2",
      port: 80,
    });
  });

  it("returns 404 for unknown monitor", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/monitors/${randomUUID()}`,
      headers: { cookie: adminCookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it("is refused for a viewer", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/monitors/${monitorId}`,
      headers: { cookie: viewerCookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/monitors/:id", () => {
  it("deletes a monitor and its checks", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

    const checkId = randomUUID();
    await db.insert(checks).values({
      id: checkId,
      monitorId,
      at: Date.now(),
      up: true,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/monitors/${monitorId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [monitor] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitorId));
    expect(monitor).toBeUndefined();

    const [check] = await db
      .select()
      .from(checks)
      .where(eq(checks.id, checkId));
    expect(check).toBeUndefined();
  });

  it("returns 404 for unknown monitor", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/monitors/${randomUUID()}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("is refused for a viewer", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: "{}",
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/monitors/${monitorId}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/monitors/:id/push/:token", () => {
  it("records timestamp for valid token", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Server",
      kind: "nas",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    const token = "secret-push-token-123";
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "push",
      config: JSON.stringify({ token, graceSeconds: 300 }),
      intervalSeconds: 3600,
      timeoutMs: 0,
    });

    const beforePush = Date.now();
    const res = await app.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/push/${token}`,
    });
    const afterPush = Date.now();

    expect(res.statusCode).toBe(200);

    const [monitor] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitorId));
    expect(monitor?.lastPushAt).toBeGreaterThanOrEqual(beforePush);
    expect(monitor?.lastPushAt).toBeLessThanOrEqual(afterPush);
  });

  it("updates timestamp on second push", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Server",
      kind: "nas",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    const token = "secret-push-token-456";
    const firstPushTime = Date.now() - 1000;
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "push",
      config: JSON.stringify({ token, graceSeconds: 300 }),
      intervalSeconds: 3600,
      timeoutMs: 0,
      lastPushAt: firstPushTime,
    });

    const beforePush = Date.now();
    const res = await app.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/push/${token}`,
    });
    const afterPush = Date.now();

    expect(res.statusCode).toBe(200);

    const [monitor] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitorId));
    expect(monitor?.lastPushAt).toBeGreaterThan(firstPushTime);
    expect(monitor?.lastPushAt).toBeGreaterThanOrEqual(beforePush);
    expect(monitor?.lastPushAt).toBeLessThanOrEqual(afterPush);
  });

  it("returns 404 for unknown monitor id", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/monitors/${randomUUID()}/push/any-token`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for non-push monitor type", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test",
      kind: "phone",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "tcp",
      config: JSON.stringify({ host: "192.168.1.1", port: 22 }),
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/push/any-token`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for wrong token", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Server",
      kind: "nas",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "push",
      config: JSON.stringify({ token: "correct-token", graceSeconds: 300 }),
      intervalSeconds: 3600,
      timeoutMs: 0,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/push/wrong-token`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for wrong-length token (not 500)", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Server",
      kind: "nas",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "push",
      config: JSON.stringify({
        token: "correct-32-character-token-here!",
        graceSeconds: 300,
      }),
      intervalSeconds: 3600,
      timeoutMs: 0,
    });

    // Token of different length
    const res = await app.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/push/short`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404, not 500, when the stored token is not a string", async () => {
    // A monitor's config is validated as `z.record(z.string(), z.unknown())`,
    // so an admin can store `{ token: 123 }`. Hashing a number throws, and a
    // 500 here would tell an unauthenticated caller that this id exists and is
    // a push monitor — the one thing every failure path is shaped to conceal.
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Server",
      kind: "nas",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "push",
      config: JSON.stringify({ token: 123, graceSeconds: 300 }),
      intervalSeconds: 3600,
      timeoutMs: 0,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/push/123`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("succeeds without authentication for valid token", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Server",
      kind: "nas",
      tailscaleNodeId: null,
    });

    const monitorId = randomUUID();
    const token = "unauthenticated-push-token";
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "device",
      targetId: deviceId,
      type: "push",
      config: JSON.stringify({ token, graceSeconds: 300 }),
      intervalSeconds: 3600,
      timeoutMs: 0,
    });

    // No cookie header - completely unauthenticated
    const res = await app.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/push/${token}`,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/settings/tailscale", () => {
  it("stores encrypted token and returns device count", async () => {
    const mockClient: TailscaleClient = {
      listDevices: async () => [
        {
          nodeId: "node123",
          name: "Test Device",
          hostname: "test-host",
          os: "linux",
          addresses: ["100.64.0.1"],
          user: "user@example.com",
          clientVersion: "1.0.0",
          updateAvailable: false,
          tags: [],
          isEphemeral: false,
          isExternal: false,
          blocksIncomingConnections: false,
          connectedToControl: true,
          lastSeen: undefined,
        },
      ],
    };

    // Replace the app with one that has mock tailscale client
    await app.close();
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      tailscale: () => mockClient,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/settings/tailscale",
      headers: { cookie: adminCookie },
      payload: {
        tailnet: "example.com",
        token: "tskey-api-secret-token-12345",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceCount).toBe(1);

    // Verify token is stored encrypted
    const [tokenSetting] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "tailscale.token"));
    expect(tokenSetting).toBeTruthy();
    if (!tokenSetting) throw new Error("tokenSetting is undefined");
    expect(tokenSetting.value).not.toContain("tskey-api-secret-token-12345");

    // Verify tailnet is stored in plaintext
    const [tailnetSetting] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "tailscale.tailnet"));
    expect(tailnetSetting?.value).toBe("example.com");
  });

  it("does not store token if sync fails", async () => {
    const mockClient: TailscaleClient = {
      listDevices: async () => {
        throw new Error("Invalid token");
      },
    };

    await app.close();
    app = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: root,
      projectsHostDir: root,
      dataDir: root,
      tailscale: () => mockClient,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/settings/tailscale",
      headers: { cookie: adminCookie },
      payload: {
        tailnet: "example.com",
        token: "tskey-invalid-token",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBeTruthy();
    // Verify error message doesn't contain the token
    expect(JSON.stringify(body)).not.toContain("tskey-invalid-token");

    // Verify nothing was stored
    const [tokenSetting] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "tailscale.token"));
    expect(tokenSetting).toBeUndefined();
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/tailscale",
      headers: { cookie: viewerCookie },
      payload: {
        tailnet: "example.com",
        token: "tskey-api-token",
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
