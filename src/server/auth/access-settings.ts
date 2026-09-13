import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { apps, exposures, settings } from "../db/schema.js";

/**
 * A nullable OBJECT, not two nullable fields — the type itself makes a half-configured
 * state unrepresentable. `resolveAccessSettings` either returns both values from the
 * same source, or `null`; there is no shape here for "team domain but no audience".
 */
export type AccessSettings = { teamDomain: string; aud: string } | null;

/**
 * The account's Cloudflare Access team domain, account-wide rather than per-app (unlike
 * `aud`, which is one value per Access application) — the same reasoning
 * `MonitorAccessStore` and `TunnelStore` already apply to their own account-wide facts.
 * `settings` is a flat key-value table that already exists; no migration needed to add a
 * key to it.
 *
 * Exported for `access-settings.test.ts` alone, the same reason `monitor-access.ts`
 * exports `MONITOR_CLIENT_SECRET_KEY` — so a test can seed this value directly, since
 * nothing in the codebase writes it yet (see this module's doc comment below).
 */
export const ACCESS_TEAM_DOMAIN_SETTING_KEY = "cloudflare.access.team_domain";

/** `""` is not a value — see the module doc comment on `resolveAccessSettings`. */
function isPresent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

async function readSetting(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row?.value ?? null;
}

/**
 * Reads the Access team domain and audience recorded for the app marked
 * `systemKind: "self"` — Homestead's own exposure, per §10: these values "normally live
 * in the database, written when Homestead provisions its own exposure." `exposures.aud`
 * is already stored per-exposure (2D); the team domain is account-wide, stored under
 * `ACCESS_TEAM_DOMAIN_SETTING_KEY`.
 *
 * **Known gap, stated plainly**: nothing in the codebase sets `systemKind: "self"` yet.
 * 1I deferred that as a design question and 2B settled only what `self` *means*, not who
 * assigns it — assigning it, and the write step that would then record these two values
 * at provisioning time, are both left to a later phase. This function only resolves what
 * is already there; if no app is marked `self`, or its exposure carries no audience, or
 * the team-domain setting was never written, this returns `null` — the correct answer
 * for "not configured yet", not a bug in this function.
 */
async function readFromDatabase(db: Db): Promise<AccessSettings> {
  const [selfApp] = await db.select().from(apps).where(eq(apps.systemKind, "self"));
  if (!selfApp) return null;

  const [exposure] = await db.select().from(exposures).where(eq(exposures.appId, selfApp.id));
  if (!exposure || !isPresent(exposure.accessAppAud)) return null;

  const teamDomain = await readSetting(db, ACCESS_TEAM_DOMAIN_SETTING_KEY);
  if (!isPresent(teamDomain)) return null;

  return { teamDomain, aud: exposure.accessAppAud };
}

/**
 * Resolves the Access team domain and audience Homestead verifies incoming
 * `Cf-Access-Jwt-Assertion` headers against.
 *
 * **Precedence, stated explicitly**: the environment (`HOMESTEAD_ACCESS_TEAM_DOMAIN` /
 * `HOMESTEAD_ACCESS_AUD`) wins ONLY when it supplies BOTH values. §10 calls the
 * environment path "an override for the case where Homestead is placed behind an Access
 * application it did not create" — a deployment Homestead does not control — not a
 * fallback to blend with the database. The database is the normal source (see
 * `readFromDatabase`).
 *
 * The two sources are NEVER mixed: a team domain from one and an audience from the other
 * is a configuration nobody wrote and nobody could reason about, so each source is
 * checked for completeness independently. Spec §7: "Failing closed on missing
 * configuration is the correct default anyway: a half-configured Access path that
 * accepted unverifiable tokens would be strictly worse than no Access path." `""` counts
 * as missing, the same as `null` or `undefined` — a truthiness check alone would treat an
 * empty string as configured, which is exactly how a half-configured state sneaks in.
 */
export async function resolveAccessSettings(deps: {
  db: Db;
  config: Config;
}): Promise<AccessSettings> {
  const { accessTeamDomain, accessAud } = deps.config;
  if (isPresent(accessTeamDomain) && isPresent(accessAud)) {
    return { teamDomain: accessTeamDomain, aud: accessAud };
  }

  return readFromDatabase(deps.db);
}
