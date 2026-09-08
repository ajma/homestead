// Syncs the Cloudflare Access allow policy to match Homestead's user list.
// (sync.ts reconciles ingress and exposures; this one syncs the allow policy.)

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings, user } from "../db/schema.js";
import { getPolicy, updateAllowPolicy } from "./access.js";
import type { CloudflareClient } from "./client.js";
import { checkForClobber, fingerprint } from "./reconcile.js";

export type SyncResult = { synced: boolean; conflict?: string };

export async function syncAllowPolicy(
  db: Db,
  client: CloudflareClient,
  accountId: string,
  policyId: string,
  idpId: string,
): Promise<SyncResult> {
  // Every Homestead user, admins and viewers alike — the same selection
  // setup's createAllowPolicy makes.
  //
  // This filtered on emailVerified, a flag nothing in this codebase ever sets:
  // sign-up is blocked and accounts are admin-created, so it is false for
  // everyone. Creation did not filter, so the policy was right when written
  // and then threw "must name at least one user" on every tick afterwards.
  // The visible cost was not a locked-out user but a frozen policy: adding
  // someone granted nothing, and removing someone revoked nothing, which is
  // the whole reason this policy is reusable.
  const users = await db.select().from(user);

  const emails = users.map((u) => u.email);

  // Read remote policy
  const remote = await getPolicy(client, accountId, policyId);

  // Check for clobber
  const [lastPushedRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "cloudflare.lastPushedPolicy"));
  const lastPushed = lastPushedRow?.value ?? null;

  const check = checkForClobber(remote, lastPushed);
  if (!check.ok) {
    return {
      synced: false,
      conflict: "Policy has been changed outside of Homestead",
    };
  }

  // Push the updated policy
  await updateAllowPolicy(client, accountId, policyId, idpId, emails);

  // Read back what was actually stored and fingerprint that
  const actualStored = await getPolicy(client, accountId, policyId);
  const newFingerprint = fingerprint(actualStored);
  await db
    .insert(settings)
    .values({
      key: "cloudflare.lastPushedPolicy",
      value: newFingerprint,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: newFingerprint },
    });

  return { synced: true };
}
