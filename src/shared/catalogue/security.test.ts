/**
 * Guards the catalogue against the class of defect found in the app-catalogue security
 * review: a literal, invented value in `compose` that is credential-shaped (a password,
 * secret, token, API key, or app-encryption key) or is a placeholder word like
 * `changeme` — either way, something a real deployer would ship unchanged, because
 * shipping a catalogue entry as-is is the entire point of a catalogue. Also guards
 * against a `SIGNUPS_ALLOWED`-style open-registration flag defaulting to on, and against
 * a security-relevant flag (secure-cookie, TLS-required, certificate-verification —
 * `N8N_SECURE_COOKIE`-shaped) shipped disabled by default. Homestead's whole purpose is
 * putting apps on the internet through a tunnel, so an insecure flag someone never
 * revisits is a real, ongoing cost — the fix for a first-run friction problem like "no
 * HTTPS on my LAN" belongs in the entry's description, told to the person who hits the
 * failure, not in a value the catalogue ships pre-weakened.
 *
 * What this does NOT catch, by design of a regex-shaped "reasonable core" rather than a
 * real compose/URL parser: a credential embedded inside a connection-string VALUE under
 * an innocuous key (e.g. `DATABASE_URL=postgres://user:secret@host/db` or
 * `PHOTOVIEW_MYSQL_URL=user:pass@tcp(host)/db`). Two entries in the catalogue today
 * (`miniflux`, `photoview`) have exactly this shape — see `ACKNOWLEDGED_LITERALS` below,
 * where the same value is caught under its sibling `POSTGRES_PASSWORD` /
 * `MARIADB_PASSWORD` key instead. A future entry that embeds a *new* secret only inside
 * a URL, with no sibling key this test also inspects, would slip past this file. Reviewers
 * of new entries should still eyeball `compose` for that shape by hand.
 *
 * The other deliberate exclusion: a `..._PASSWORD`/`..._RANDOM_ROOT_PASSWORD`-named key
 * whose value is a bare boolean word (`yes`/`no`/`true`/`false`/`1`/`0`) is a feature
 * flag, not a credential (see the `mariadb`/`mysql` images' `..._RANDOM_ROOT_PASSWORD`
 * option) — flagging it would be a false positive on every entry using that flag.
 */

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CATALOGUE } from "./index.js";

type ComposeDoc = { services?: Record<string, { environment?: unknown }> };

interface EnvEntry {
  service: string;
  key: string;
  value: string;
}

/** Every `KEY=VALUE` environment entry across every service in a compose document.
 * Handles both compose's list form (`environment: ["KEY=VALUE"]`, what every entry in
 * this catalogue uses today) and its map form (`environment: {KEY: VALUE}`), since
 * either is valid compose and a future entry is free to use the other. A list item with
 * no `=` (`"KEY"`, meaning "inherit from the host shell") carries no value to check and
 * is skipped. */
function envEntriesOf(compose: string): EnvEntry[] {
  const doc = parseYaml(compose) as ComposeDoc;
  const entries: EnvEntry[] = [];
  for (const [service, definition] of Object.entries(doc.services ?? {})) {
    const env = definition.environment;
    if (Array.isArray(env)) {
      for (const item of env) {
        if (typeof item !== "string") continue;
        const splitAt = item.indexOf("=");
        if (splitAt === -1) continue;
        entries.push({ service, key: item.slice(0, splitAt), value: item.slice(splitAt + 1) });
      }
    } else if (env !== null && typeof env === "object") {
      for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
        entries.push({
          service,
          key,
          value: value === null || value === undefined ? "" : String(value),
        });
      }
    }
  }
  return entries;
}

/** A key that names a credential of some kind. `PASS` rather than `PASSWORD` so it also
 * catches the shorter `DB_PASS` spelling (`wiki-js` uses it); `APP_KEY` alongside
 * `API_KEY` so it also catches the Laravel convention (`firefly-iii`, `snipe-it`) —
 * neither is literally in the task brief's `PASSWORD|SECRET|TOKEN|API_KEY|CREDENTIAL`
 * core, but both are the same class of value under a different spelling. */
const CREDENTIAL_KEY_PATTERN = /PASS|SECRET|TOKEN|API_KEY|APP_KEY|CREDENTIAL/i;

/** A bare boolean word — see the module comment's note on `..._RANDOM_ROOT_PASSWORD`. */
const BOOLEAN_LIKE_VALUE = /^(?:yes|no|true|false|1|0)$/i;

/** Placeholder wording, checked against every value regardless of key — a `changeme` in
 * an unrelated-looking field is exactly as shipped as one in a `PASSWORD` field. */
const PLACEHOLDER_VALUE_PATTERN = /change[-_ ]?(?:me|this)|placeholder|somerandom|insecure/i;

/** A `SIGNUPS_ALLOWED`-shaped open-registration flag. */
const OPEN_REGISTRATION_KEY_PATTERN =
  /SIGNUPS_ALLOWED|ALLOW_REGISTRATION|ENABLE_REGISTRATION|OPEN_REGISTRATION|REGISTRATION_ENABLED/i;
const TRUTHY_VALUE = /^(?:true|yes|1|on)$/i;

/** A key naming a flag that governs whether the app requires HTTPS/TLS for something
 * security-relevant: a secure-cookie flag, a "TLS required" toggle, a certificate
 * verification flag. Checked against all 50 entries in the catalogue as of this writing
 * (see the n8n fix this guard was added for) — `N8N_SECURE_COOKIE` is the only key in
 * the whole catalogue this pattern, or even the broader `SECURE|COOKIE|TLS|SSL|HTTPS|
 * VERIFY` superset, matches. Bare `SECURE` is intentionally in the core (not just
 * `SECURE_COOKIE`) so a same-shaped flag under another app's own naming still gets
 * caught; re-run the same check against the full catalogue before loosening it further,
 * since a broader net over 50 free-form compose blocks risks catching an unrelated key. */
const INSECURE_FLAG_KEY_PATTERN =
  /SECURE_COOKIE|COOKIE_SECURE|SECURE|TLS_REQUIRED|REQUIRE_HTTPS|VERIFY_SSL/i;

/** A falsy value disabling the security flag above. */
const FALSY_VALUE = /^(?:false|no|0|off)$/i;

interface AcknowledgedLiteral {
  slug: string;
  key: string;
  reason: string;
}

/**
 * The ONLY way to keep a credential-shaped literal in an entry's compose: add a
 * `{ slug, key, reason }` row here, in the same diff as the value itself. There is no
 * other exemption path — no ignore-comment, no slug-wide opt-out, nothing that could
 * silently cover a second, unrelated field on the same entry. A reviewer sees exactly
 * which field is being allowed through and why, right next to the change that needs it.
 *
 * Every row below is the same shape: an app<->database linkage password that the
 * upstream `postgres`/`mariadb` image refuses to initialize without (`POSTGRES_PASSWORD`
 * / `MYSQL_PASSWORD` must be non-empty or the container fails), reused only over the
 * compose-internal network between an entry's app and its own single-tenant db service
 * (neither publishes a port), and identical to no other entry's password by accident —
 * it's simply the same fixed value on both sides of one entry's own link. Blanking it,
 * the way `APP_KEY`-style entries were fixed, would break `docker compose up` outright,
 * which the catalogue's own rules treat as worse than shipping the entry at all. Giving
 * every install a genuinely unique value needs per-install secret generation at create
 * time — real machinery, not a JSON edit — and is tracked as follow-up work, not fixed
 * here. Remove a row the day its entry gets that treatment.
 */
const ACKNOWLEDGED_LITERALS: readonly AcknowledgedLiteral[] = [
  {
    slug: "miniflux",
    key: "POSTGRES_PASSWORD",
    reason: "postgres image requires a non-empty password to initialize; internal db link only.",
  },
  {
    slug: "healthchecks",
    key: "DB_PASSWORD",
    reason: "must match the sibling db service's POSTGRES_PASSWORD below; internal db link only.",
  },
  {
    slug: "healthchecks",
    key: "POSTGRES_PASSWORD",
    reason: "postgres image requires a non-empty password to initialize; internal db link only.",
  },
  {
    slug: "wiki-js",
    key: "DB_PASS",
    reason: "must match the sibling db service's POSTGRES_PASSWORD below; internal db link only.",
  },
  {
    slug: "wiki-js",
    key: "POSTGRES_PASSWORD",
    reason: "postgres image requires a non-empty password to initialize; internal db link only.",
  },
  {
    slug: "firefly-iii",
    key: "DB_PASSWORD",
    reason: "must match the sibling db service's MYSQL_PASSWORD below; internal db link only.",
  },
  {
    slug: "firefly-iii",
    key: "MYSQL_PASSWORD",
    reason: "mariadb image requires a non-empty password to create the app's db user.",
  },
  {
    slug: "snipe-it",
    key: "DB_PASSWORD",
    reason: "must match the sibling db service's MYSQL_PASSWORD below; internal db link only.",
  },
  {
    slug: "snipe-it",
    key: "MYSQL_PASSWORD",
    reason: "mariadb image requires a non-empty password to create the app's db user.",
  },
  {
    slug: "photoview",
    key: "MARIADB_PASSWORD",
    reason: "mariadb image requires a non-empty password to create the app's db user.",
  },
];

function isAcknowledged(slug: string, key: string): boolean {
  return ACKNOWLEDGED_LITERALS.some((a) => a.slug === slug && a.key === key);
}

interface AcknowledgedInsecureFlag {
  slug: string;
  key: string;
  reason: string;
}

/**
 * The ONLY way to ship a security flag `INSECURE_FLAG_KEY_PATTERN` matches set falsy:
 * add a `{ slug, key, reason }` row here, in the same diff as the value itself — same
 * visible, per-entry shape as `ACKNOWLEDGED_LITERALS` above. Deliberately a SEPARATE
 * list rather than a new case added to `ACKNOWLEDGED_LITERALS`: that list's (slug, key)
 * gate is checked once, before ANY of that rule's own checks run, so acknowledging a key
 * there already silences both the credential-literal check and the placeholder check for
 * that key — an over-broad coupling a prior review flagged, not something to extend.
 * Routing this rule's exemption through the same gate would mean acknowledging, say, a
 * `..._TOKEN` key for the credential rule could also silently exempt it here if a future
 * key happened to match both patterns (e.g. a hypothetical `SECURE_TOKEN`). Keeping this
 * list separate means acknowledging a key for one rule never silences a different rule
 * for that same key.
 */
const ACKNOWLEDGED_INSECURE_FLAGS: readonly AcknowledgedInsecureFlag[] = [];

function isInsecureFlagAcknowledged(slug: string, key: string): boolean {
  return ACKNOWLEDGED_INSECURE_FLAGS.some((a) => a.slug === slug && a.key === key);
}

/** Every reason this env entry ships a security flag disabled by default, empty when
 * it's clean or the key doesn't name one of these flags. Kept separate from
 * `violationsFor` for the same reason `ACKNOWLEDGED_INSECURE_FLAGS` is kept separate from
 * `ACKNOWLEDGED_LITERALS`: folding it into one function would make it easy to fold the
 * acknowledgement gates together later too. */
function insecureFlagViolationsFor(entry: EnvEntry): string[] {
  const value = entry.value.trim();
  if (value.length === 0) return [];
  if (INSECURE_FLAG_KEY_PATTERN.test(entry.key) && FALSY_VALUE.test(value)) {
    return [`${entry.key}="${value}" ships a security flag disabled by default`];
  }
  return [];
}

/** Every reason this env entry should fail the guard, empty when it's clean. Named
 * functions rather than one inline predicate so a failure message says WHICH rule fired,
 * not just that one did. */
function violationsFor(entry: EnvEntry): string[] {
  const value = entry.value.trim();
  if (value.length === 0) return []; // blank on purpose: the user must supply it themselves

  const reasons: string[] = [];
  if (CREDENTIAL_KEY_PATTERN.test(entry.key) && !BOOLEAN_LIKE_VALUE.test(value)) {
    reasons.push(`${entry.key} looks like a credential and carries a literal value ("${value}")`);
  }
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) {
    reasons.push(`${entry.key}="${value}" is a placeholder-shaped literal`);
  }
  if (OPEN_REGISTRATION_KEY_PATTERN.test(entry.key) && TRUTHY_VALUE.test(value)) {
    reasons.push(`${entry.key}="${value}" ships open registration by default`);
  }
  return reasons;
}

describe("catalogue security guard", () => {
  it("has no un-acknowledged credential-shaped literal in any entry's compose", () => {
    const failures: string[] = [];
    for (const catalogueEntry of CATALOGUE) {
      for (const envEntry of envEntriesOf(catalogueEntry.compose)) {
        if (isAcknowledged(catalogueEntry.slug, envEntry.key)) continue;
        for (const reason of violationsFor(envEntry)) {
          failures.push(`${catalogueEntry.slug} [${envEntry.service}]: ${reason}`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("every acknowledged literal still points at something real, so the list can't rot", () => {
    for (const acknowledged of ACKNOWLEDGED_LITERALS) {
      const entry = CATALOGUE.find((candidate) => candidate.slug === acknowledged.slug);
      expect(entry, `acknowledged slug "${acknowledged.slug}" no longer exists`).toBeTruthy();
      if (!entry) continue;
      const stillPresent = envEntriesOf(entry.compose).some((e) => e.key === acknowledged.key);
      expect(
        stillPresent,
        `acknowledged key "${acknowledged.key}" no longer appears on "${acknowledged.slug}" — remove the row`,
      ).toBe(true);
    }
    expect(ACKNOWLEDGED_LITERALS.every((a) => a.reason.trim().length > 0)).toBe(true);
  });

  it("has no un-acknowledged insecure security-flag default in any entry's compose", () => {
    const failures: string[] = [];
    for (const catalogueEntry of CATALOGUE) {
      for (const envEntry of envEntriesOf(catalogueEntry.compose)) {
        if (isInsecureFlagAcknowledged(catalogueEntry.slug, envEntry.key)) continue;
        for (const reason of insecureFlagViolationsFor(envEntry)) {
          failures.push(`${catalogueEntry.slug} [${envEntry.service}]: ${reason}`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("every acknowledged insecure flag still points at something real, so the list can't rot", () => {
    for (const acknowledged of ACKNOWLEDGED_INSECURE_FLAGS) {
      const entry = CATALOGUE.find((candidate) => candidate.slug === acknowledged.slug);
      expect(entry, `acknowledged slug "${acknowledged.slug}" no longer exists`).toBeTruthy();
      if (!entry) continue;
      const stillPresent = envEntriesOf(entry.compose).some((e) => e.key === acknowledged.key);
      expect(
        stillPresent,
        `acknowledged key "${acknowledged.key}" no longer appears on "${acknowledged.slug}" — remove the row`,
      ).toBe(true);
    }
    expect(ACKNOWLEDGED_INSECURE_FLAGS.every((a) => a.reason.trim().length > 0)).toBe(true);
  });

  describe("the detection rules themselves", () => {
    it("flags a literal value under a credential-shaped key", () => {
      const failures = envEntriesOf(
        "services:\n  app:\n    image: x\n    environment:\n      - SOME_SECRET=totally-real-value\n",
      ).flatMap(violationsFor);
      expect(failures.length).toBeGreaterThan(0);
    });

    it("does not flag a blank value left for the user to fill in", () => {
      const failures = envEntriesOf(
        "services:\n  app:\n    image: x\n    environment:\n      - APP_KEY=\n",
      ).flatMap(violationsFor);
      expect(failures).toEqual([]);
    });

    it("does not flag a boolean-shaped *_RANDOM_ROOT_PASSWORD flag", () => {
      const failures = envEntriesOf(
        "services:\n  db:\n    image: mariadb\n    environment:\n      - MARIADB_RANDOM_ROOT_PASSWORD=yes\n",
      ).flatMap(violationsFor);
      expect(failures).toEqual([]);
    });

    it("flags a placeholder word even under an unrelated key", () => {
      const failures = envEntriesOf(
        "services:\n  app:\n    image: x\n    environment:\n      - SOME_SETTING=changeme\n",
      ).flatMap(violationsFor);
      expect(failures.length).toBeGreaterThan(0);
    });

    it("flags an open-registration flag defaulting to on", () => {
      const failures = envEntriesOf(
        "services:\n  app:\n    image: x\n    environment:\n      - SIGNUPS_ALLOWED=true\n",
      ).flatMap(violationsFor);
      expect(failures.length).toBeGreaterThan(0);
    });

    it("does not flag an open-registration flag defaulting to off", () => {
      const failures = envEntriesOf(
        "services:\n  app:\n    image: x\n    environment:\n      - SIGNUPS_ALLOWED=false\n",
      ).flatMap(violationsFor);
      expect(failures).toEqual([]);
    });

    // Pins the guarantee the module comment makes ("no slug-wide opt-out, nothing that
    // could silently cover a second, unrelated field on the same entry") against the exact
    // mutation the whole-branch review found survives without it: narrowing
    // `isAcknowledged` from a (slug, key) pair match to a slug-only match. Under that
    // mutation this assertion flips to `true` and fails, because "miniflux" already has an
    // acknowledged row for a different key.
    it("does not let acknowledging one key on a slug exempt a different key on the same slug", () => {
      expect(isAcknowledged("miniflux", "SOME_UNACKNOWLEDGED_SECRET")).toBe(false);
    });

    it("flags a security flag disabled by default", () => {
      const failures = envEntriesOf(
        "services:\n  app:\n    image: x\n    environment:\n      - APP_SECURE_COOKIE=false\n",
      ).flatMap(insecureFlagViolationsFor);
      expect(failures.length).toBeGreaterThan(0);
    });

    it("does not flag a security flag left at its (secure) default", () => {
      const failures = envEntriesOf(
        "services:\n  app:\n    image: x\n    environment:\n      - APP_SECURE_COOKIE=true\n",
      ).flatMap(insecureFlagViolationsFor);
      expect(failures).toEqual([]);
    });

    it("does not flag an unrelated key with a falsy value", () => {
      const failures = envEntriesOf(
        "services:\n  app:\n    image: x\n    environment:\n      - SIGNUPS_ALLOWED=false\n",
      ).flatMap(insecureFlagViolationsFor);
      expect(failures).toEqual([]);
    });

    // Pins the whole reason `ACKNOWLEDGED_INSECURE_FLAGS` is a separate list from
    // `ACKNOWLEDGED_LITERALS`: acknowledging a credential key for the credential/
    // placeholder rules must not also exempt that key from this rule, and vice versa.
    it("does not let acknowledging a credential key also silence the insecure-flag rule", () => {
      expect(isInsecureFlagAcknowledged("miniflux", "POSTGRES_PASSWORD")).toBe(false);
    });
  });
});
