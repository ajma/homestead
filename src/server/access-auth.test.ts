import { ACCESS_JWT_HEADER, clearJwksCache } from "@server/auth/access-plugin";
import { auditLog, users } from "@server/db/schema";
import { buildTestApp, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

const TEAM = "acme";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const AUD = "homestead-aud-tag";

/**
 * Written as an attacker would, per the Task 3 brief: every test below is either the
 * attack the audience check exists to stop, a forgery of one of the other three
 * verified claims, or a boundary this mounted hook must fail closed on without leaking
 * whether Access is even configured.
 */
async function mintToken(
  privateKey: CryptoKey,
  email: string,
  over: { iss?: string; aud?: string | string[]; exp?: number } = {},
) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "1h")
    .sign(privateKey);
}

/** Builds a test app with Access "configured" via the environment path (2E Task 2:
 * the environment wins when it supplies both values) and a `fetch` that answers the
 * JWKS endpoint with this test's own key — no test in this file makes a real network
 * call. */
async function withAccessConfigured() {
  const app = await buildTestApp();
  app.deps.config = { ...app.deps.config, accessTeamDomain: TEAM, accessAud: AUD };

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" };
  app.deps.fetch = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const { cookie: adminCookie, id: adminId } = await signUpAdmin(app);
  return { app, privateKey, adminCookie, adminId };
}

describe("the mounted Access sign-in path", () => {
  // Every test in this file uses the same team domain ("acme"), and each generates its
  // own fresh key pair — without this, `access-plugin.ts`'s module-level JWKS cache
  // would keep an EARLIER test's public key live under that domain for its full TTL,
  // so a LATER test's genuinely valid, correctly-signed token would fail verification
  // against a stale key and read as "rejected" for the wrong reason entirely. The
  // module's own test file (`access-plugin.test.ts`) clears the same cache the same
  // way for the same reason.
  beforeEach(() => {
    clearJwksCache();
  });

  it("establishes a session for a valid assertion naming a known user", async () => {
    const { app, privateKey, adminId } = await withAccessConfigured();
    const token = await mintToken(privateKey, "admin@example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(adminId);
    await app.close();
  });

  it("rejects a structurally valid, correctly-signed assertion minted for a DIFFERENT Access application", async () => {
    // The attack that matters: every Access application in the same Cloudflare account
    // shares the same signing keys and issuer, so signature validity alone proves only
    // that the bearer may access SOMETHING in the account. Without the audience check,
    // this token — otherwise perfectly valid — would sign the bearer in as the admin.
    const { app, privateKey } = await withAccessConfigured();
    const token = await mintToken(privateKey, "admin@example.com", { aud: "some-other-app-aud" });

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an audience array naming only other applications", async () => {
    // Cloudflare issues `aud` as an array; this is the realistic shape of the same
    // attack above.
    const { app, privateKey } = await withAccessConfigured();
    const token = await mintToken(privateKey, "admin@example.com", {
      aud: ["jellyfin-aud", "immich-aud"],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an expired token", async () => {
    const { app, privateKey } = await withAccessConfigured();
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await mintToken(privateKey, "admin@example.com", { exp: past });

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a token with a bad signature", async () => {
    const { app } = await withAccessConfigured();
    // Signed by a DIFFERENT, unrelated key pair — the JWKS endpoint (mocked to return
    // the real key) will not contain this one.
    const forger = await generateKeyPair("RS256");
    const token = await mintToken(forger.privateKey, "admin@example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a token from the wrong issuer", async () => {
    const { app, privateKey } = await withAccessConfigured();
    const token = await mintToken(privateKey, "admin@example.com", {
      iss: "https://evil-team.cloudflareaccess.com",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("ignores the header entirely when Access settings are unresolved, identically to no header at all", async () => {
    // Neither the environment nor the database supplies both values here — the default
    // `buildTestApp()` config has no Access configuration and no self app is seeded.
    // Inert means inert: not a partial check, and not an error that would let a caller
    // distinguish "not configured" from "bad token" by probing.
    //
    // Deliberately supplies a `fetch` that WOULD serve a working JWKS for a token that
    // WOULD verify successfully, and mints exactly that token — so this test fails if
    // the hook falls back to some default team domain/audience instead of genuinely
    // treating unresolved settings as "nothing to check", not only if it happens to
    // error out because a fetch was never wired up.
    const app = await buildTestApp();
    await signUpAdmin(app);
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" };
    app.deps.fetch = (async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const token = await mintToken(privateKey, "admin@example.com");

    const withHeader = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });
    const withoutHeader = await app.inject({ method: "GET", url: "/api/me" });

    expect(withHeader.statusCode).toBe(401);
    expect(withHeader.statusCode).toBe(withoutHeader.statusCode);
    expect(withHeader.json()).toEqual(withoutHeader.json());
    await app.close();
  });

  it("an existing password session is unaffected by a garbage Access assertion header", async () => {
    const { app, adminCookie, adminId } = await withAccessConfigured();

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: adminCookie, [ACCESS_JWT_HEADER]: "not.a.jwt.at.all" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(adminId);
    await app.close();
  });

  it("an existing password session survives a VALID Access assertion naming a different user", async () => {
    // The garbage-token test above is rejected by `verifyAccessJwt` whether or not the
    // session-precedence guard (`if (request.auth) return;`) exists, so it cannot tell
    // the two worlds apart. This is the binding version: a token that WOULD verify and
    // WOULD resolve to a real, different user. Without the guard, the Access hook would
    // run anyway, find `viewer@example.com`, and overwrite `request.auth` with the
    // viewer's identity — silently replacing the admin's own session with whoever the
    // header names.
    const { app, privateKey, adminCookie, adminId } = await withAccessConfigured();
    const email = "viewer@example.com";
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: adminCookie },
      payload: {
        email,
        password: "correct-horse-battery",
        name: "Viewer",
        role: "viewer",
        scopeAllApps: true,
        appIds: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const viewerId = created.json().id as string;

    const token = await mintToken(privateKey, email);
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: adminCookie, [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(adminId);
    expect(res.json().id).not.toBe(viewerId);
    await app.close();
  });

  it("does not implicitly create a Homestead user for an assertion naming an unknown email", async () => {
    const { app, privateKey } = await withAccessConfigured();
    const token = await mintToken(privateKey, "nobody@example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(401);
    const rows = await app.deps.db
      .select()
      .from(users)
      .where(eq(users.email, "nobody@example.com"));
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("rejects a disabled user's assertion", async () => {
    // Phase 1C's carry-forward: a stale AuthContext kept a disabled user's streams open.
    // The same care applies to a freshly-verified Access assertion — disabled must mean
    // disabled regardless of which sign-in path presents the identity.
    const { app, privateKey, adminCookie } = await withAccessConfigured();
    const email = "viewer@example.com";
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: adminCookie },
      payload: {
        email,
        password: "correct-horse-battery",
        name: "Viewer",
        role: "viewer",
        scopeAllApps: true,
        appIds: [],
      },
    });
    const viewerId = created.json().id as string;
    const disableRes = await app.inject({
      method: "PATCH",
      url: `/api/users/${viewerId}`,
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });
    expect(disableRes.statusCode).toBe(200);

    const token = await mintToken(privateKey, email);
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("scopes an Access-authenticated user exactly like the password path", async () => {
    // Proves the shared row->AuthContext resolution (scope, role) is not just "any
    // session" but the real thing — a scoped viewer signing in via Access sees the same
    // capability wall a scoped viewer signing in with a password would.
    const { app, privateKey, adminCookie } = await withAccessConfigured();
    const email = "scoped-viewer@example.com";
    await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: adminCookie },
      payload: {
        email,
        password: "correct-horse-battery",
        name: "Scoped Viewer",
        role: "viewer",
        scopeAllApps: true,
        appIds: [],
      },
    });

    const token = await mintToken(privateKey, email);
    const meRes = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().email).toBe(email);

    // A viewer cannot create another user, whichever sign-in path it arrived through.
    const createRes = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { [ACCESS_JWT_HEADER]: token },
      payload: {
        email: "someone-else@example.com",
        password: "correct-horse-battery",
        name: "Someone",
        role: "viewer",
        scopeAllApps: true,
        appIds: [],
      },
    });
    expect(createRes.statusCode).toBe(403);
    await app.close();
  });

  it("records the audit trail's auth path as access, not password", async () => {
    // §7, Hygiene: every audit row records which path authenticated the actor. This is
    // the first phase Access is reachable at all, so nothing asserted this before —
    // an admin signed in via Access whose actions logged as "password" would be
    // indistinguishable, during an incident, from someone on the LAN with the password.
    const { app, privateKey, adminId } = await withAccessConfigured();
    const token = await mintToken(privateKey, "admin@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { [ACCESS_JWT_HEADER]: token },
      payload: {
        email: "audited-via-access@example.com",
        password: "correct-horse-battery",
        name: "Audited",
        role: "viewer",
        scopeAllApps: true,
        appIds: [],
      },
    });
    expect(res.statusCode).toBe(201);

    const [row] = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user.created"));
    expect(row?.authPath).toBe("access");
    expect(row?.userId).toBe(adminId);
    await app.close();
  });

  it("ignores a valid Access assertion presented directly on the LAN, not through the tunnel", async () => {
    // §6/§9: externally exposed apps stay LAN-reachable without passing through Access,
    // which makes an Access assertion arriving on a LAN-origin request meaningless —
    // Cloudflare never evaluated its policy for it, so a bearer token copied out of a
    // revoked user's browser would otherwise keep working until it expired.
    // `app.inject`'s default `remoteAddress` is `127.0.0.1` — cloudflared's own
    // loopback address, and `trustedProxies`' default — which is why every other test
    // in this file is implicitly "through the tunnel". This one overrides it to a LAN
    // address to prove the same, otherwise-valid token is ignored rather than accepted,
    // and that the response is byte-identical to no header at all: a LAN caller cannot
    // use this to fingerprint whether Access is configured or probe a candidate email.
    const { app, privateKey } = await withAccessConfigured();
    const token = await mintToken(privateKey, "admin@example.com");
    const remoteAddress = "192.168.1.50";

    const withHeader = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
      remoteAddress,
    });
    const withoutHeader = await app.inject({ method: "GET", url: "/api/me", remoteAddress });

    expect(withHeader.statusCode).toBe(401);
    expect(withHeader.statusCode).toBe(withoutHeader.statusCode);
    expect(withHeader.json()).toEqual(withoutHeader.json());
    await app.close();
  });

  it("matches the asserted email against the stored user case-insensitively", async () => {
    // The IdP behind Access is a different system from Homestead's own `users` table
    // and has no reason to agree on case; a mismatch here must not silently and
    // permanently lock out an otherwise-valid Access sign-in.
    const { app, privateKey, adminId } = await withAccessConfigured();
    const token = await mintToken(privateKey, "Admin@Example.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { [ACCESS_JWT_HEADER]: token },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(adminId);
    await app.close();
  });
});
