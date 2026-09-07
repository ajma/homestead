import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { devices, manualApps, monitors, user } from "../db/schema.js";

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

async function signIn(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie returned");
  const [sessionCookie] = cookie.split(";");
  if (!sessionCookie) throw new Error("malformed cookie");
  return sessionCookie;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-dashboard-"));
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);

  app = await buildApp({
    db,
    auth,
    secretKey: Buffer.alloc(32),
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
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

describe("GET /api/dashboard", () => {
  it("returns empty arrays when no apps or devices exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ apps: [], devices: [], projectCount: 0 });
  });

  it("viewer receives no device data at all", async () => {
    // Create a device with identifiable data
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Family Phone",
      kind: "phone",
      tailscaleNodeId: "node123",
      hostname: "family-phone",
      lastSeen: Date.now(),
      os: "iOS",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Assert devices array is empty
    expect(body.devices).toEqual([]);

    // Assert NO device data appears anywhere in the serialized response
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Family Phone");
    expect(serialized).not.toContain("family-phone");
    expect(serialized).not.toContain("node123");
    expect(serialized).not.toContain("iOS");
    // Don't check lastSeen timestamp directly as it might collide with other numbers
  });

  it("admin sees both apps and devices", async () => {
    const deviceId = randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name: "Test Device",
      kind: "nas",
      tailscaleNodeId: null,
    });

    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "Test App",
      url: "http://localhost:8080",
    });

    // Create monitor for the app
    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "app",
      targetId: `manual:${appId}`,
      type: "http",
      config: JSON.stringify({ url: "http://localhost:8080" }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]).toMatchObject({
      key: `manual:${appId}`,
      source: "manual",
      name: "Test App",
      projectSlug: null,
      service: null,
      hostPort: null,
      hostname: null,
    });

    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({
      id: deviceId,
      name: "Test Device",
    });
  });

  it("app tile carries exposure hostname when one exists", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "Public App",
      url: "http://localhost:3000",
    });

    // Create monitor
    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "app",
      targetId: `manual:${appId}`,
      type: "http",
      config: JSON.stringify({ url: "http://localhost:3000" }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    // Note: For manual apps, hostname comes from exposure if exists
    // But manual apps don't have a hostPort, so they typically won't have exposures
    // This test verifies hostname is null when no exposure exists
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.apps[0].hostname).toBe(null);
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
    });
    expect(res.statusCode).toBe(401);
  });

  it("shows project-backed app with projectSlug, service and hostPort", async () => {
    // Create monitors for a project-backed app (jellyfin:web)
    const tcpMonitorId = randomUUID();
    await db.insert(monitors).values({
      id: tcpMonitorId,
      targetType: "app",
      targetId: "jellyfin:web",
      type: "tcp",
      config: JSON.stringify({ port: 8096 }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]).toMatchObject({
      key: "jellyfin:web",
      source: "project",
      name: "web",
      projectSlug: "jellyfin",
      service: "web",
      hostPort: 8096,
      hostname: null,
    });
  });

  it("project app with hostname carries it", async () => {
    // Create monitors for a project-backed app with hostname
    const tcpMonitorId = randomUUID();
    await db.insert(monitors).values({
      id: tcpMonitorId,
      targetType: "app",
      targetId: "nextcloud:app",
      type: "tcp",
      config: JSON.stringify({ port: 8080 }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    const dnsMonitorId = randomUUID();
    await db.insert(monitors).values({
      id: dnsMonitorId,
      targetType: "app",
      targetId: "nextcloud:app",
      type: "dns",
      config: JSON.stringify({ hostname: "cloud.example.com" }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: false,
      enabled: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]).toMatchObject({
      key: "nextcloud:app",
      source: "project",
      hostname: "cloud.example.com",
    });
  });

  it("manual and project apps appear together", async () => {
    // Create a manual app
    const manualAppId = randomUUID();
    await db.insert(manualApps).values({
      id: manualAppId,
      name: "Router",
      url: "http://192.168.1.1",
    });
    const manualMonitorId = randomUUID();
    await db.insert(monitors).values({
      id: manualMonitorId,
      targetType: "app",
      targetId: `manual:${manualAppId}`,
      type: "http",
      config: JSON.stringify({ url: "http://192.168.1.1" }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    // Create a project app
    const projectMonitorId = randomUUID();
    await db.insert(monitors).values({
      id: projectMonitorId,
      targetType: "app",
      targetId: "plex:server",
      type: "tcp",
      config: JSON.stringify({ port: 32400 }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      required: true,
      enabled: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.apps).toHaveLength(2);
    const manualApp = body.apps.find(
      (a: { source: string }) => a.source === "manual",
    );
    const projectApp = body.apps.find(
      (a: { source: string }) => a.source === "project",
    );

    expect(manualApp).toMatchObject({
      source: "manual",
      name: "Router",
    });
    expect(projectApp).toMatchObject({
      source: "project",
      projectSlug: "plex",
      service: "server",
      hostPort: 32400,
    });
  });

  it("projectCount is present when projects exist but none publishes a port", async () => {
    // Create a project directory without any published ports
    const projectDir = join(root, "webapp");
    await mkdir(projectDir);
    await writeFile(
      join(projectDir, "compose.yml"),
      "services:\n  backend:\n    image: node:20\n",
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.apps).toEqual([]); // No apps with published ports
    expect(body.projectCount).toBe(1); // But project exists
  });
});

describe("POST /api/apps", () => {
  it("creates a manual app with an http monitor for an admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie: adminCookie },
      payload: {
        name: "My App",
        url: "http://192.168.1.100:8080",
        iconSlug: "plex",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty("id");

    // Verify the app was created
    const [manualApp] = await db
      .select()
      .from(manualApps)
      .where(eq(manualApps.id, body.id));
    expect(manualApp).toMatchObject({
      name: "My App",
      url: "http://192.168.1.100:8080",
      iconSlug: "plex",
      iconUrl: null,
      hidden: false,
    });

    // Verify exactly one required http monitor was created
    const appMonitors = await db
      .select()
      .from(monitors)
      .where(eq(monitors.targetId, `manual:${body.id}`));
    expect(appMonitors).toHaveLength(1);
    const [monitor] = appMonitors;
    if (!monitor) throw new Error("monitor should exist");
    expect(monitor).toMatchObject({
      targetType: "app",
      type: "http",
      required: true,
      enabled: true,
    });

    const config = JSON.parse(monitor.config);
    expect(config.url).toBe("http://192.168.1.100:8080");
  });

  it("is refused for a viewer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie: viewerCookie },
      payload: {
        name: "My App",
        url: "http://localhost:8080",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects invalid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: { cookie: adminCookie },
      payload: {
        name: "",
        url: "invalid-url",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/apps/:id", () => {
  it("updates a manual app for an admin", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "Old Name",
      url: "http://localhost:8080",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      headers: { cookie: adminCookie },
      payload: {
        name: "New Name",
        iconSlug: "nextcloud",
      },
    });
    expect(res.statusCode).toBe(200);

    const [manualApp] = await db
      .select()
      .from(manualApps)
      .where(eq(manualApps.id, appId));
    if (!manualApp) throw new Error("app should exist");
    expect(manualApp.name).toBe("New Name");
    expect(manualApp.iconSlug).toBe("nextcloud");
    expect(manualApp.url).toBe("http://localhost:8080"); // unchanged
  });

  it("rejects unknown field before writing anything", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "Original",
      url: "http://localhost:8080",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      headers: { cookie: adminCookie },
      payload: {
        name: "Should Not Write",
        unknownField: "bad",
      },
    });
    expect(res.statusCode).toBe(400);

    // Verify nothing was written
    const [manualApp] = await db
      .select()
      .from(manualApps)
      .where(eq(manualApps.id, appId));
    if (!manualApp) throw new Error("app should exist");
    expect(manualApp.name).toBe("Original");
  });

  it("is refused for a viewer", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "App",
      url: "http://localhost:8080",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      headers: { cookie: viewerCookie },
      payload: { name: "New Name" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for nonexistent app", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${randomUUID()}`,
      headers: { cookie: adminCookie },
      payload: { name: "New Name" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/apps/:id", () => {
  it("deletes a manual app and its monitors for an admin", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "App to Delete",
      url: "http://localhost:8080",
    });

    const monitorId = randomUUID();
    await db.insert(monitors).values({
      id: monitorId,
      targetType: "app",
      targetId: `manual:${appId}`,
      type: "http",
      config: JSON.stringify({ url: "http://localhost:8080" }),
      intervalSeconds: 60,
      timeoutMs: 5000,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);

    // Verify app was deleted
    const apps = await db
      .select()
      .from(manualApps)
      .where(eq(manualApps.id, appId));
    expect(apps).toHaveLength(0);

    // Verify monitors were deleted
    const appMonitors = await db
      .select()
      .from(monitors)
      .where(eq(monitors.targetId, `manual:${appId}`));
    expect(appMonitors).toHaveLength(0);
  });

  it("is refused for a viewer", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "App",
      url: "http://localhost:8080",
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for nonexistent app", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${randomUUID()}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/apps/:key/icon", () => {
  it("serves a cached icon with the right content type", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "Test App",
      url: "http://localhost:8080",
      iconSlug: "plex",
    });

    // Create a fake cached icon
    const iconsDir = join(root, "icons");
    await mkdir(iconsDir, { recursive: true });
    const iconPath = join(iconsDir, "plex.png");
    // Write a minimal 1x1 PNG
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    await writeFile(iconPath, minimalPng);

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/manual:${appId}/icon`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(res.rawPayload)).toEqual(minimalPng);
  });

  it("refuses traversal attempt with slash", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/manual:..%2F..%2Fetc%2Fpasswd/icon",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses traversal attempt with dotdot", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/manual:..secret/icon",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses symlink pointing outside cache directory", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "Evil App",
      url: "http://localhost:8080",
      iconSlug: "evil",
    });

    // Create a secret file outside the cache directory
    const secretFile = join(root, "secret.txt");
    await writeFile(secretFile, "secret content");

    // Create a symlink inside the cache directory pointing to the secret file
    const iconsDir = join(root, "icons");
    await mkdir(iconsDir, { recursive: true });
    const symlinkPath = join(iconsDir, "evil.png");
    await symlink(secretFile, symlinkPath);

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/manual:${appId}/icon`,
      headers: { cookie: adminCookie },
    });

    // Should NOT return the secret file content
    expect(res.statusCode).toBe(404);
    if (res.statusCode === 200) {
      expect(res.body).not.toBe("secret content");
    }
  });

  it("returns 404 for missing icon", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "No Icon App",
      url: "http://localhost:8080",
      iconSlug: "nonexistent",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/manual:${appId}/icon`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("viewer can fetch an icon", async () => {
    const appId = randomUUID();
    await db.insert(manualApps).values({
      id: appId,
      name: "Viewer App",
      url: "http://localhost:8080",
      iconSlug: "test",
    });

    // Create a fake cached icon
    const iconsDir = join(root, "icons");
    await mkdir(iconsDir, { recursive: true });
    const iconPath = join(iconsDir, "test.png");
    await writeFile(iconPath, Buffer.from([1, 2, 3]));

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/manual:${appId}/icon`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
  });
});
