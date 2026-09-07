import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "./client.js";
import { checks, devices, exposures, monitors } from "./schema.js";

async function db() {
  const d = createDb(":memory:");
  await runMigrations(d);
  return d;
}

describe("monitoring schema", () => {
  it("stores a monitor against a device target", async () => {
    const d = await db();
    await d.insert(devices).values({ id: "dev1", name: "nas", kind: "nas" });
    await d.insert(monitors).values({
      id: "m1",
      targetType: "device",
      targetId: "dev1",
      type: "tcp",
      config: JSON.stringify({ host: "10.0.0.2", port: 22 }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      retries: 2,
      required: true,
      enabled: true,
      nextDueAt: 0,
    });
    const rows = await d.select().from(monitors).where(eq(monitors.id, "m1"));
    expect(rows[0]?.targetId).toBe("dev1");
  });

  it("keeps a device whose tailscaleNodeId is null — manual devices have none", async () => {
    const d = await db();
    await d
      .insert(devices)
      .values({ id: "dev2", name: "printer", kind: "other" });
    const rows = await d.select().from(devices).where(eq(devices.id, "dev2"));
    expect(rows[0]?.tailscaleNodeId).toBeNull();
  });

  it("records a check with a duration even though nothing reads it yet", async () => {
    const d = await db();
    await d.insert(devices).values({ id: "dev3", name: "vm", kind: "vm" });
    await d.insert(monitors).values({
      id: "m3",
      targetType: "device",
      targetId: "dev3",
      type: "dns",
      config: JSON.stringify({ hostname: "example.test" }),
      intervalSeconds: 60,
      timeoutMs: 5000,
      retries: 0,
      required: true,
      enabled: true,
      nextDueAt: 0,
    });
    await d.insert(checks).values({
      id: "c1",
      monitorId: "m3",
      at: 1000,
      up: false,
      durationMs: 42,
      error: "ENOTFOUND",
    });
    const rows = await d
      .select()
      .from(checks)
      .where(eq(checks.monitorId, "m3"));
    expect(rows[0]).toMatchObject({
      up: false,
      durationMs: 42,
      error: "ENOTFOUND",
    });
  });
});

describe("cloudflare schema", () => {
  it("stores an exposure with a nullable project and Access on by default", async () => {
    const d = await db();
    await d.insert(exposures).values({
      id: "e1",
      projectSlug: null,
      hostPort: 8080,
      zoneId: "z1",
      hostname: "app.example.com",
      scheme: "http",
    });
    const [row] = await d.select().from(exposures);
    expect(row).toMatchObject({
      projectSlug: null,
      hostPort: 8080,
      accessEnabled: true,
      enabled: true,
      noTlsVerify: false,
      accessAppId: null,
    });
  });
});
