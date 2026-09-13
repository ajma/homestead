import { eq, isNull } from "drizzle-orm";
import type { SecretStore } from "../crypto/secrets.js";
import type { Db, Tx } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { settings, users } from "../db/schema.js";
import type { CloudflareClient } from "./client.js";

/**
 * §6: "Homestead creates a single `Homestead Monitor` service token and a single
 * **reusable** `non_identity` policy including it... One token and one policy for N
 * apps, so rotation is a single operation." Fixed names, not user-chosen — there is
 * exactly one of each, the same reasoning `CLOUDFLARED_TUNNEL_NAME` in
 * `provision-tunnel.ts` is fixed rather than derived from anything a caller passes in.
 */
export const MONITOR_TOKEN_NAME = "Homestead Monitor";
export const MONITOR_POLICY_NAME = "Homestead Monitor";

/**
 * Phase 3A's sibling to `MONITOR_POLICY_NAME` — the reusable, `allow`-decision policy every
 * enabled Homestead user's email is included in. One name, one policy, the same "fixed, not
 * user-chosen" reasoning as the monitor policy above.
 */
export const HUMAN_POLICY_NAME = "Homestead Access";

/**
 * What Homestead records locally about the shared Access setup: the one monitor service
 * token, the `non_identity` policy that includes it, and the `allow` policy every enabled
 * user's email is included in. Named `AccessPolicies`, not `MonitorAccess` — Phase 3A
 * supersedes 2D's `MonitorAccess` by renaming it, not by adding a second, parallel type
 * for the human policy. Two stores for one concept ("the Access setup this Cloudflare
 * account has") is exactly the defect this project keeps finding and re-fixing; there is
 * one record here, one store below, one `ensure*` function, covering both policies.
 *
 * `clientId` is not secret (it identifies the token, the way a username does — Cloudflare
 * sends it back on every rotation and it is safe to log). `clientSecret` never appears
 * on this type; see `AccessPoliciesStore` for where it actually lives.
 */
export type AccessPolicies = {
  tokenId: string;
  clientId: string;
  /** The `non_identity` policy including the monitor service token — `MonitorAccess`'s
   * old `policyId`, renamed to sit next to `humanPolicyId` without either name reading as
   * "the" policy. */
  monitorPolicyId: string;
  /** Epoch ms, or `null` if Cloudflare returned no expiry. §6: tokens come back with
   * `duration: "8760h"` and a concrete `expires_at` — persisted here so a later phase
   * (2F) has something to warn from before every external probe starts failing at once. */
  expiresAt: number | null;
  /** The `allow` policy including every enabled user's email — see `enabledUserEmails`
   * and `buildHumanPolicy` below for what "every enabled user" means and does not mean. */
  humanPolicyId: string;
};

const TOKEN_ID_KEY = "cloudflare.monitor.token_id";
const CLIENT_ID_KEY = "cloudflare.monitor.client_id";
const MONITOR_POLICY_ID_KEY = "cloudflare.monitor.policy_id";
const EXPIRES_AT_KEY = "cloudflare.monitor.expires_at";
/** New in Phase 3A — the one setting this rename actually adds a column of. Namespaced
 * `cloudflare.access.*` rather than `cloudflare.monitor.*` like its four siblings above:
 * unlike those four, this key is not about the monitor token at all, and the four keep
 * their original strings unchanged so an install upgrading onto this branch does not lose
 * whatever it already has recorded under them. */
const HUMAN_POLICY_ID_KEY = "cloudflare.access.human_policy_id";

/** Exported for `access-policies.test.ts` alone, the same reason `TunnelStore` exports
 * `TUNNEL_TOKEN_KEY` — so a test proving `set()`/`clear()` touch the raw `secrets` row,
 * and that the secret is never surfaced through `get()`, can check it directly. */
export const MONITOR_CLIENT_SECRET_KEY = "cloudflare.monitor_client_secret";

/**
 * Reads and writes the Access setup every exposed app shares: the one service token, the
 * one reusable monitor policy, and (Phase 3A) the one reusable human policy.
 *
 * Same split as `TunnelStore`/`CloudflareCredentialStore`: the non-secret fields live in
 * `settings`, the secret lives encrypted in `secrets`, both flat key-value tables that
 * already exist — no migration for this phase (see `HUMAN_POLICY_ID_KEY`'s own doc
 * comment). `get()` never returns the secret — see `AccessPolicies`'s doc comment — so a
 * caller cannot accidentally leak it into a log line or a response body just by
 * round-tripping a status through this store.
 */
export class AccessPoliciesStore {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
  ) {}

  /**
   * `null` if any of the five pieces is missing — extended from 2D's "no half-formed
   * record" treatment to now include `humanPolicyId`: a caller of `ensureAccessPolicies`
   * treats "fully set up" as both policies existing together, not the monitor half alone.
   * The secret is deliberately not part of this check, for the same reason it never was:
   * whether the secret itself is present is `set()`'s problem, and `get()`'s contract is
   * that it never reads the secret at all.
   */
  async get(): Promise<AccessPolicies | null> {
    const [tokenId, clientId, monitorPolicyId, humanPolicyId, expiresAtRaw] = await Promise.all([
      this.readSetting(TOKEN_ID_KEY),
      this.readSetting(CLIENT_ID_KEY),
      this.readSetting(MONITOR_POLICY_ID_KEY),
      this.readSetting(HUMAN_POLICY_ID_KEY),
      this.readSetting(EXPIRES_AT_KEY),
    ]);
    if (
      tokenId === null ||
      clientId === null ||
      monitorPolicyId === null ||
      humanPolicyId === null
    ) {
      return null;
    }
    return {
      tokenId,
      clientId,
      monitorPolicyId,
      humanPolicyId,
      expiresAt: expiresAtRaw === null ? null : Number(expiresAtRaw),
    };
  }

  /**
   * All five settings plus the encrypted secret share one transaction, for the same
   * "no half-written state" reason `TunnelStore.set()` and `CloudflareCredentialStore.save()`
   * do. `clientSecret` is a separate parameter rather than a field on `AccessPolicies` —
   * this is the ONE place in this module that ever sees the plaintext secret in memory,
   * and it goes straight into the transaction, never onto anything this method returns.
   */
  async set(value: AccessPolicies, clientSecret: string): Promise<void> {
    await retryOnBusy(() =>
      this.db.transaction(async (tx) => {
        await this.secrets.withDb(tx).set(MONITOR_CLIENT_SECRET_KEY, clientSecret);
        await this.writeSetting(TOKEN_ID_KEY, value.tokenId, tx);
        await this.writeSetting(CLIENT_ID_KEY, value.clientId, tx);
        await this.writeSetting(MONITOR_POLICY_ID_KEY, value.monitorPolicyId, tx);
        await this.writeSetting(HUMAN_POLICY_ID_KEY, value.humanPolicyId, tx);
        if (value.expiresAt === null) {
          await tx.delete(settings).where(eq(settings.key, EXPIRES_AT_KEY));
        } else {
          await this.writeSetting(EXPIRES_AT_KEY, String(value.expiresAt), tx);
        }
      }),
    );
  }

  /**
   * The secret, alongside the client id — unlike `get()`, which exists for status
   * display and deliberately never reads it (see that method's doc comment). This is
   * for the one caller that actually has to authenticate as the monitor: the
   * `http_external` probe runner (2E), which needs a fresh read on every run so a
   * rotation (`rotateMonitorSecret`) takes effect on the very next probe rather than
   * whenever the process that captured a stale value happens to restart.
   *
   * Deliberately reads `CLIENT_ID_KEY` directly rather than going through `get()`: probe
   * authentication depends only on a client id and its secret, nothing about the human
   * policy's existence, and `get()`'s completeness check now requires `humanPolicyId` too
   * (Phase 3A). Coupling this method to that would mean an account that already has a
   * working monitor token — one set up before this phase, or one whose human-policy
   * creation is still pending — stops authenticating probes the moment this rename
   * lands, for a reason that has nothing to do with probing. `null` if either half is
   * missing — a client id with no secret, or a secret with no record, is not usable
   * credentials either way.
   */
  async getCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
    const clientId = await this.readSetting(CLIENT_ID_KEY);
    if (clientId === null) return null;
    const clientSecret = await this.secrets.get(MONITOR_CLIENT_SECRET_KEY);
    if (clientSecret === null) return null;
    return { clientId, clientSecret };
  }

  /**
   * Just the monitor half — `tokenId`/`clientId`/`monitorPolicyId`/`expiresAt` — present or
   * not, independent of whether the human policy exists. `get()` cannot answer this: Phase
   * 3A widened it to require `humanPolicyId` too (see that method's own doc comment), so it
   * returns `null` for exactly the state this method exists to detect. Added for the
   * Phase-2-to-3A upgrade path — see `createAccessPolicies`'s own doc comment on why
   * treating that state as "nothing exists yet" is the wrong call. `null` unless all three
   * IDs are present; a genuinely fresh install (nothing recorded) and a corrupted
   * one-or-two-of-three-recorded state are both treated the same way by the caller — fall
   * through to full creation — because only "all three present" is a state this method can
   * complete safely without guessing at a missing id.
   */
  async getMonitorOnly(): Promise<{
    tokenId: string;
    clientId: string;
    monitorPolicyId: string;
    expiresAt: number | null;
  } | null> {
    const [tokenId, clientId, monitorPolicyId, expiresAtRaw] = await Promise.all([
      this.readSetting(TOKEN_ID_KEY),
      this.readSetting(CLIENT_ID_KEY),
      this.readSetting(MONITOR_POLICY_ID_KEY),
      this.readSetting(EXPIRES_AT_KEY),
    ]);
    if (tokenId === null || clientId === null || monitorPolicyId === null) return null;
    return {
      tokenId,
      clientId,
      monitorPolicyId,
      expiresAt: expiresAtRaw === null ? null : Number(expiresAtRaw),
    };
  }

  /** Not transactional, the same reasoning as `TunnelStore.clear()`: a partial clear
   * still gets `get()` to `null` (any one of the required settings missing is already
   * "absent"), which is the outcome this method promises.
   *
   * Called when credentials themselves are removed (`DELETE /api/cloudflare/credentials`)
   * — a new account's policies are a different account's policies, so a token id, both
   * policy ids and the monitor secret all become meaningless the moment the credentials
   * that could manage them are gone. Whole-branch review, Critical: before this call
   * existed here, `AccessPoliciesStore.clear()` had no production caller at all, so a
   * credentials swap left a stale `humanPolicyId` recorded under a new account —
   * `accessSync()` (`routes/users.ts`) treated that as "configured", and every delete or
   * disable failed against a policy id the new account's token could never reach. */
  async clear(): Promise<void> {
    await this.secrets.delete(MONITOR_CLIENT_SECRET_KEY);
    await this.deleteSetting(TOKEN_ID_KEY);
    await this.deleteSetting(CLIENT_ID_KEY);
    await this.deleteSetting(MONITOR_POLICY_ID_KEY);
    await this.deleteSetting(HUMAN_POLICY_ID_KEY);
    await this.deleteSetting(EXPIRES_AT_KEY);
  }

  /**
   * Clears ONLY the human policy id — the token, monitor policy id, secret and expiry are
   * untouched. For the other half of the Critical fix: Cloudflare reporting the recorded
   * human policy itself gone (a 404 the caller confirmed with `CloudflareClient.getPolicy`)
   * while the monitor half is still perfectly good — the account was never touched, only
   * the one policy was deleted or the credentials were swapped without also clearing this
   * store (see `clear()`'s own doc comment for that half).
   *
   * `get()` requires `humanPolicyId` (Phase 3A), so this alone makes it report "not fully
   * configured" again — which is what lets `ensureAccessPolicies` treat the installation as
   * eligible for repair rather than as already complete. `getMonitorOnly()` stays satisfied
   * by the token/monitor-policy/expiry trio this leaves in place, so the very next
   * `ensureAccessPolicies` call (an admin clicking "Retry setup", or a future credentials
   * save) takes the exact `completeHumanPolicy` upgrade path Phase 2 installs already use —
   * recreating only the missing human policy, never rotating the token every external
   * probe currently authenticates with. Before this method existed, a caller's only way to
   * make `get()` report "incomplete" again was the full `clear()` above, which would have
   * thrown away that still-good monitor token and policy for a failure that has nothing to
   * do with them.
   */
  async clearHumanPolicy(): Promise<void> {
    await this.deleteSetting(HUMAN_POLICY_ID_KEY);
  }

  private async readSetting(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key));
    return row?.value ?? null;
  }

  private async writeSetting(key: string, value: string, db: Db | Tx = this.db): Promise<void> {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: Math.floor(Date.now() / 1000) },
      });
  }

  private async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}

/**
 * Every enabled Homestead user's email — `disabledAt IS NULL`, the same predicate
 * `routes/users.ts`'s `lastActiveAdminIsSafe` already uses for "still able to log in".
 * Disabled users are excluded on purpose: a disabled user who keeps internet access to
 * every exposed app through this policy defeats the entire point of disabling them.
 *
 * **Known property, not an oversight**: this is ONE shared policy covering every enabled
 * user, regardless of `scopeAllApps`/`userAppScope` — Homestead's own per-app viewer
 * scope. A viewer whose Homestead permissions are scoped to a single app is, by this
 * policy, let through Cloudflare Access to every app this instance exposes; Cloudflare
 * Access has no notion of "which Homestead app" a request is for beyond the hostname, and
 * this phase's ruling was to accept that gap rather than build per-app Access policies to
 * close it. That decision was made deliberately, with the cost stated plainly, not
 * discovered later as a surprise — the upgrade path, when someone decides the gap is worth
 * closing, is per-app Access policies (one reusable `allow` policy per exposed app, scoped
 * to that app's own viewers) in place of this single shared one.
 *
 * Exported (Task 3) for `sync-access-users.ts`, the ONLY other caller — the point of
 * `createAccessPolicies` seeding the policy once at creation time and `syncAccessUsers`
 * keeping it current afterward is that they read the identical set, computed the identical
 * way, so a user added the instant after `ensureAccessPolicies` finishes is neither missing
 * from the first read nor handled by some almost-but-not-quite-identical second query.
 */
export async function enabledUserEmails(db: Db): Promise<string[]> {
  const rows = await db.select({ email: users.email }).from(users).where(isNull(users.disabledAt));
  return rows.map((row) => row.email);
}

/**
 * Keyed by store identity, not by anything about a single call — this is the same
 * in-flight-promise-cache shape `runPreflightOnce` uses in `routes/setup.ts` to collapse
 * concurrent host-check clicks onto one running container, applied here for the same
 * reason: `await deps.store.get()` below is a real gap between "check" and "create", and
 * two `ensureAccessPolicies` calls that land in that gap both see `null` and would
 * otherwise both create real, billed Cloudflare resources (the second overwriting the
 * first in the store, orphaning it in the account with no local record it exists). This is
 * 2F's own defect, measured as two live service tokens from one double-click — the WeakMap
 * here is unchanged by the rename, and wraps the WHOLE creation attempt (token, monitor
 * policy, AND human policy) as one cached promise, which is what makes the same protection
 * cover the human policy too without a second, parallel mutex: a second caller arriving
 * mid-attempt shares the one in-flight result rather than starting its own.
 *
 * A `WeakMap` keyed on the store instance rather than a single module-level promise: two
 * calls sharing the same `AccessPoliciesStore` (the only case that can actually collide,
 * since `cloudflareRoutes` constructs exactly one per process) share one attempt, while
 * two independent stores — as in separate test cases, each against its own fresh
 * `:memory:` db — never see each other's in-flight promise. The entry is removed once the
 * attempt settles, success or failure, so a later, genuinely new call is never wedged on
 * one that already finished (or failed) — the same cleanup `runPreflightOnce` does in its
 * own `.finally`.
 */
const inFlight = new WeakMap<AccessPoliciesStore, Promise<AccessPolicies>>();

/**
 * Creates the one shared service token, the one reusable `non_identity` monitor policy,
 * and the one reusable `allow` human policy on first call; every call after that is a
 * no-op that returns the already-recorded `AccessPolicies` — §6 requires exactly one
 * token and one monitor policy for every app, and Phase 3A extends that to the human
 * policy: a second creation is not "safe to repeat", it is a bug that leaves two policies
 * live where every exposed app's Access application still points at only one.
 *
 * The human policy is seeded with every enabled user's email AT CREATION TIME
 * (`enabledUserEmails`) — this function does not itself keep that list current as users
 * are added, disabled, or removed later; that is a separate, later concern (user sync),
 * not this call's job.
 *
 * If monitor-policy creation fails after the token was created, or if human-policy
 * creation fails after the monitor policy also succeeded, the token is deleted rather
 * than kept and recorded — `deleteServiceToken` exists on the client for exactly this
 * (see its own doc comment in `client.ts`), and the same "compensate inline, don't leave
 * an orphan for nobody to clean up" idiom `provision-tunnel.ts`'s steps already use
 * elsewhere in this codebase. This is unchanged from 2D's `ensureMonitorAccess` other than
 * covering one more failure point: there is still no `deleteAccessPolicy` on the client
 * (the plan never asked for one), so a monitor policy that outlives its own token in this
 * failure path is left as inert Cloudflare-account clutter — a `non_identity` policy
 * pointing at a token that no longer exists admits nothing, so this is not a security
 * concern, only a tidiness one, and the alternative (a new client method and a second
 * compensation path for a policy object) was not worth adding for that. The
 * token-deletion call itself is best-effort: if IT also fails, the original error is what
 * the caller needs to see, not a secondary cleanup failure masking it.
 */
export async function ensureAccessPolicies(deps: {
  store: AccessPoliciesStore;
  client: CloudflareClient;
  db: Db;
}): Promise<AccessPolicies> {
  const existing = await deps.store.get();
  if (existing) return existing;

  // Everything from here to `inFlight.set` is synchronous — no `await` in between — so
  // two calls that both observed `existing === null` above cannot both observe an empty
  // map here. See the doc comment on `inFlight` above for why this is keyed on the store
  // rather than global.
  const pending = inFlight.get(deps.store);
  if (pending) return pending;

  const attempt = createAccessPolicies(deps).finally(() => {
    inFlight.delete(deps.store);
  });
  inFlight.set(deps.store, attempt);
  return attempt;
}

async function createAccessPolicies(deps: {
  store: AccessPoliciesStore;
  client: CloudflareClient;
  db: Db;
}): Promise<AccessPolicies> {
  // The carried fix from Task 2's report: an install that already ran Phase 2's
  // `ensureMonitorAccess` has the monitor token and monitor policy recorded, but no
  // `humanPolicyId` — `AccessPoliciesStore.get()` above returned `null` for that state
  // (Phase 3A widened it to require the human policy too), and treating "not fully
  // configured" as "nothing exists yet" would create a BRAND NEW service token here,
  // orphaning the old one in the user's Cloudflare account with no local record it ever
  // existed. Every external probe (2E) authenticates with the old token's secret until
  // whatever picks up the new one runs, so the orphaned window is not cosmetic — probes
  // fail for real. `getMonitorOnly` exists on the store specifically to detect this case
  // without `get()`'s stricter, Phase-3A-only completeness check getting in the way.
  const monitorOnly = await deps.store.getMonitorOnly();
  if (monitorOnly) return completeHumanPolicy(deps, monitorOnly);

  const token = await deps.client.createServiceToken(MONITOR_TOKEN_NAME);

  let monitorPolicy: { id: string };
  try {
    monitorPolicy = await deps.client.createMonitorPolicy(MONITOR_POLICY_NAME, token.id);
  } catch (error) {
    await deps.client.deleteServiceToken(token.id).catch(() => {
      // Best effort — see the doc comment above.
    });
    throw error;
  }

  let humanPolicy: { id: string };
  try {
    const emails = await enabledUserEmails(deps.db);
    humanPolicy = await deps.client.createEmailPolicy(HUMAN_POLICY_NAME, emails);
  } catch (error) {
    await deps.client.deleteServiceToken(token.id).catch(() => {
      // Best effort — see the doc comment above.
    });
    throw error;
  }

  const record: AccessPolicies = {
    tokenId: token.id,
    clientId: token.clientId,
    monitorPolicyId: monitorPolicy.id,
    humanPolicyId: humanPolicy.id,
    expiresAt: token.expiresAt,
  };
  await deps.store.set(record, token.clientSecret);
  return record;
}

/**
 * Completes an install that already has the monitor half — the Phase 2 upgrade path (see
 * `createAccessPolicies`'s own doc comment). Creates ONLY the human policy; the existing
 * token and monitor policy are carried through unchanged, never recreated and never
 * re-rotated. No new service token means no compensating delete on failure either — unlike
 * `createAccessPolicies`'s own token-creation path, there is nothing THIS call made that
 * needs unwinding if `createEmailPolicy` throws; the existing monitor token and policy are
 * exactly as usable after a failed attempt as before it, so the error is simply propagated.
 *
 * `store.set()` always rewrites the secret alongside the four settings (`set()`'s own doc
 * comment — there is no "settings-only" write on this store), so the existing plaintext
 * secret is read back via `getCredentials()` — the one method on this store that reads it
 * without requiring `get()`'s full-completeness check — and written back byte-for-byte. If
 * it is somehow missing (the token id recorded with no paired secret — not reachable through
 * this store's own transactional `set()`, only through direct tampering), this throws rather
 * than guessing: inventing a placeholder secret would silently break every external probe's
 * authentication, which is a worse outcome than a loud failure here.
 */
async function completeHumanPolicy(
  deps: { store: AccessPoliciesStore; client: CloudflareClient; db: Db },
  monitorOnly: {
    tokenId: string;
    clientId: string;
    monitorPolicyId: string;
    expiresAt: number | null;
  },
): Promise<AccessPolicies> {
  const credentials = await deps.store.getCredentials();
  if (!credentials) {
    throw new Error(
      "the monitor token's id is recorded but its secret is not — cannot complete the human " +
        "policy without re-deriving a secret this store never had; this indicates the local " +
        "record was tampered with outside of AccessPoliciesStore.set()",
    );
  }

  const emails = await enabledUserEmails(deps.db);
  const humanPolicy = await deps.client.createEmailPolicy(HUMAN_POLICY_NAME, emails);

  const record: AccessPolicies = {
    tokenId: monitorOnly.tokenId,
    clientId: monitorOnly.clientId,
    monitorPolicyId: monitorOnly.monitorPolicyId,
    humanPolicyId: humanPolicy.id,
    expiresAt: monitorOnly.expiresAt,
  };
  await deps.store.set(record, credentials.clientSecret);
  return record;
}

/**
 * Replaces the secret on the existing token and re-persists it — the token id and both
 * policy ids never change, which is the whole point (§6: N apps keep pointing at one
 * monitor policy through one token id; only the secret every probe authenticates with
 * rotates. The human policy is untouched by a rotation — it has no service token in it at
 * all).
 */
export async function rotateMonitorSecret(deps: {
  store: AccessPoliciesStore;
  client: CloudflareClient;
}): Promise<AccessPolicies> {
  const existing = await deps.store.get();
  if (!existing) {
    throw new Error("cannot rotate the monitor service token before it has been created");
  }

  const rotated = await deps.client.rotateServiceToken(existing.tokenId);
  const record: AccessPolicies = {
    tokenId: existing.tokenId,
    clientId: rotated.clientId,
    monitorPolicyId: existing.monitorPolicyId,
    humanPolicyId: existing.humanPolicyId,
    expiresAt: rotated.expiresAt,
  };
  await deps.store.set(record, rotated.clientSecret);
  return record;
}
