import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { devices } from "../db/schema.js";
import type { TailscaleClient, TailscaleDevice } from "./client.js";

export type { TailscaleDevice };

/**
 * Parse lastSeen defensively: return epoch milliseconds for a valid ISO string,
 * null otherwise. An unparseable timestamp is treated as unknown, not as a
 * reason to abort the sync.
 */
function parseLastSeen(lastSeen: string | undefined): number | null {
  if (!lastSeen) return null;
  const ms = new Date(lastSeen).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export async function syncDevices(
  db: Db,
  client: TailscaleClient,
  now: number,
): Promise<{ added: number; updated: number; skipped: number }> {
  const tailscaleDevices = await client.listDevices();

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const device of tailscaleDevices) {
    try {
      // C2: Validate nodeId before processing. A null or empty nodeId would match
      // nothing under SQL NULL semantics, causing re-insertion on every sync.
      // Validation lives here rather than in client.ts because the business rule
      // (we need a valid nodeId to upsert) belongs to the sync logic, not the
      // thin API wrapper.
      const nodeId = device.nodeId?.trim();
      if (!nodeId) {
        skipped++;
        continue;
      }

      // Check if we've seen this node before
      const [existing] = await db
        .select()
        .from(devices)
        .where(eq(devices.tailscaleNodeId, nodeId));

      const syncedData = {
        hostname: device.hostname,
        os: device.os,
        addresses: JSON.stringify(device.addresses),
        user: device.user,
        clientVersion: device.clientVersion,
        updateAvailable: device.updateAvailable,
        tags: JSON.stringify(device.tags),
        isEphemeral: device.isEphemeral,
        isExternal: device.isExternal,
        blocksIncomingConnections: device.blocksIncomingConnections,
        connectedToControl: device.connectedToControl,
        lastSeen: parseLastSeen(device.lastSeen),
        lastSyncedAt: now,
      };

      if (!existing) {
        // New device: insert with all fields including owned ones
        await db.insert(devices).values({
          id: randomUUID(),
          tailscaleNodeId: nodeId,
          name: device.name,
          kind: "other",
          ...syncedData,
        });
        added++;
      } else {
        // Known device: update ONLY the Tailscale-owned columns
        // Never touch: id, tailscaleNodeId, name, kind, notes, hidden
        await db
          .update(devices)
          .set(syncedData)
          .where(eq(devices.tailscaleNodeId, nodeId));
        updated++;
      }
    } catch (_error) {
      // C1: One bad device must not abort the entire sync. Skip it and continue.
      skipped++;
    }
  }

  return { added, updated, skipped };
}
