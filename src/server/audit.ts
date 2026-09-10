import { ulid } from "ulid";
import type { Db } from "./db/client.js";
import { auditLog } from "./db/schema.js";

export type AuditContext =
  | { userId: string; authPath: "password" | "access" }
  | { userId: null; authPath: "system" };

export async function audit(
  db: Db,
  ctx: AuditContext,
  entry: {
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: unknown;
    ip?: string;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    id: ulid(),
    userId: ctx.userId,
    authPath: ctx.authPath,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    detail: (entry.detail ?? null) as never,
    ip: entry.ip ?? null,
  });
}
