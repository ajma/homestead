import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { devices } from "../db/schema.js";
import { syncDevices, type TailscaleDevice } from "./sync.js";

const node = (over: Partial<TailscaleDevice> = {}): TailscaleDevice => ({
  nodeId: "n1",
  name: "nas.tail.ts.net",
  hostname: "nas",
  os: "linux",
  addresses: ["100.1.1.1"],
  user: "a@b.co",
  clientVersion: "1.0",
  updateAvailable: false,
  tags: [],
  isEphemeral: false,
  isExternal: false,
  blocksIncomingConnections: false,
  connectedToControl: true,
  lastSeen: undefined,
  ...over,
});

const fake = (list: TailscaleDevice[]) => ({ listDevices: async () => list });

async function db(): Promise<Db> {
  const d = createDb(":memory:");
  await runMigrations(d);
  return d;
}

describe("syncDevices", () => {
  it("inserts a node it has not seen", async () => {
    const d = await db();
    const r = await syncDevices(d, fake([node()]), 1000);
    expect(r.added).toBe(1);
    const [row] = await d.select().from(devices);
    expect(row).toMatchObject({
      tailscaleNodeId: "n1",
      hostname: "nas",
      connectedToControl: true,
    });
  });

  it("stores lastSeen as null for an online device, because Tailscale omits it", async () => {
    const d = await db();
    await syncDevices(
      d,
      fake([node({ connectedToControl: true, lastSeen: undefined })]),
      1000,
    );
    const [row] = await d.select().from(devices);
    expect(row?.lastSeen).toBeNull();
    expect(row?.connectedToControl).toBe(true);
  });

  it("keeps the user's own fields when refreshing a known node", async () => {
    // Renaming a device in Homestead must survive every sync, or the feature is
    // pointless — the whole reason for owned records is calling it "Andrew's
    // phone" instead of "iphone-12".
    const d = await db();
    await syncDevices(d, fake([node()]), 1000);
    await d
      .update(devices)
      .set({ name: "Andrew's NAS", kind: "nas", notes: "loud", hidden: true })
      .where(eq(devices.tailscaleNodeId, "n1"));
    await syncDevices(d, fake([node({ hostname: "nas2" })]), 2000);
    const [row] = await d.select().from(devices);
    expect(row).toMatchObject({
      name: "Andrew's NAS",
      kind: "nas",
      notes: "loud",
      hidden: true,
      hostname: "nas2",
    });
  });

  it("retains a device that has left the tailnet", async () => {
    // Its history is the point: a device that vanished is exactly when you want
    // to see when it was last connected.
    const d = await db();
    await syncDevices(d, fake([node()]), 1000);
    await syncDevices(d, fake([]), 2000);
    expect(await d.select().from(devices)).toHaveLength(1);
  });

  it("never touches a manual device", async () => {
    const d = await db();
    await d
      .insert(devices)
      .values({ id: "manual", name: "printer", kind: "other" });
    await syncDevices(d, fake([node()]), 1000);
    const [row] = await d
      .select()
      .from(devices)
      .where(eq(devices.id, "manual"));
    expect(row).toMatchObject({ name: "printer", tailscaleNodeId: null });
  });

  it("defaults a new device's kind to 'other'", async () => {
    const d = await db();
    await syncDevices(d, fake([node()]), 1000);
    const [row] = await d.select().from(devices);
    expect(row?.kind).toBe("other");
  });

  it("stores null for an unparseable lastSeen instead of aborting", async () => {
    const d = await db();
    const r = await syncDevices(
      d,
      fake([node({ lastSeen: "not-a-date" })]),
      1000,
    );
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(0);
    const [row] = await d.select().from(devices);
    expect(row?.lastSeen).toBeNull();
  });

  it("skips a device with a null nodeId and continues", async () => {
    const d = await db();
    const r = await syncDevices(
      d,
      fake([
        node({ nodeId: null as unknown as string }),
        node({ nodeId: "n2", name: "valid" }),
      ]),
      1000,
    );
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
    expect(await d.select().from(devices)).toHaveLength(1);
    const [row] = await d.select().from(devices);
    expect(row?.tailscaleNodeId).toBe("n2");
  });

  it("skips a device with an empty nodeId and continues", async () => {
    const d = await db();
    const r = await syncDevices(
      d,
      fake([node({ nodeId: "  " }), node({ nodeId: "n2", name: "valid" })]),
      1000,
    );
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
    expect(await d.select().from(devices)).toHaveLength(1);
  });
});
