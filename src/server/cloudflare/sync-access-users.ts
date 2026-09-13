import { and, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { enabledUserEmails, HUMAN_POLICY_NAME } from "./access-policies.js";
import type { CloudflareClient } from "./client.js";

export type SyncAccessUsersDeps = {
  db: Db;
  client: CloudflareClient;
  /** `AccessPolicies.humanPolicyId` — the caller's job to resolve (via `AccessPoliciesStore
   * .get()`) and to decide whether it exists at all before calling this. This module has no
   * opinion on "is Access configured" — see `routes/users.ts`'s own `accessSync()` for that
   * check, which is what keeps an installation that never touched Cloudflare from ever
   * reaching this function. */
  policyId: string;
};

/**
 * Rebuilds the human Access policy's email list from the database and PUTs the FULL list —
 * never a delta against what Homestead believes Cloudflare currently holds. Task 3's own
 * brief: "a delta computed against what we believe Cloudflare holds drifts the first time
 * anything else edits the policy" — the same reasoning `CloudflareClient.updateEmailPolicy`
 * itself already documents for why it is a full-replace `PUT`, applied one level up here:
 * the SOURCE of the list this sends is always a fresh read of `users`, never a locally
 * cached "what's already there, plus one change" notion that could have drifted.
 *
 * Reads through `enabledUserEmails` — the exact same query `createAccessPolicies` (Task 2)
 * seeds the policy with at creation time — so there is one definition of "who belongs in
 * this policy" in the whole codebase, not two that could quietly diverge. Case-insensitivity
 * falls out of that reuse for free: `users.email` is Better-Auth's own lowercased column
 * (Phase 2E's lockout fix), so every email this function ever sends to Cloudflare is already
 * normalised — there is no raw, possibly-mixed-case request body anywhere in this path for a
 * comparison to get wrong.
 *
 * Called by `routes/users.ts` after every mutation that can change who is enabled. Whether
 * that call happens BEFORE the local write (blocking it on failure) or AFTER (best-effort)
 * depends on which direction the mutation moves access — see that module's own doc comment
 * for the ruling and why the two differ.
 */
export async function syncAccessUsers(deps: SyncAccessUsersDeps): Promise<void> {
  const emails = await enabledUserEmails(deps.db);
  await deps.client.updateEmailPolicy(deps.policyId, HUMAN_POLICY_NAME, emails);
}

/**
 * The same full rebuild as `syncAccessUsers`, minus one user by id — used ONLY for the
 * pre-flight check `routes/users.ts` runs before a delete or a disable is allowed to commit
 * locally at all.
 *
 * Ruling 2 (Task 3's brief): removing or disabling a user must succeed in Cloudflare, or the
 * operation fails locally — never the reverse, where a row is gone or disabled in Homestead
 * while that same person still reaches every exposed app through Cloudflare Access. The
 * straightforward way to get there would be "disable/delete first, sync after, undo the
 * local write if the sync fails" — but `users` cascades to `sessions`, `accounts` (the
 * Better-Auth password credential) and `userAppScope` on delete (`schema.ts`), and undoing a
 * committed delete cleanly would mean capturing and reinserting all three tables' rows, a
 * materially riskier and more complex operation than simply never committing the delete
 * until Cloudflare has already accepted the post-removal state. Computing the hypothetical
 * "as if this user were already gone" list BEFORE the local write sidesteps that entirely:
 * on failure, nothing local has been touched, so there is nothing to undo.
 *
 * Excludes by id, not by email string, so no case-normalisation question even arises for
 * this comparison — contrast `syncAccessUsers`/`enabledUserEmails`, which read the column
 * Better-Auth already stores lowercase, and `routes/users.ts`'s own `.toLowerCase()` on the
 * create path, which exists for a different comparison (the raw request body against that
 * same stored column).
 */
export async function syncAccessUsersExcluding(
  deps: SyncAccessUsersDeps & { excludeUserId: string },
): Promise<void> {
  const rows = await deps.db
    .select({ email: users.email })
    .from(users)
    .where(and(isNull(users.disabledAt), ne(users.id, deps.excludeUserId)));
  await deps.client.updateEmailPolicy(
    deps.policyId,
    HUMAN_POLICY_NAME,
    rows.map((row) => row.email),
  );
}
