import { clearJwksCache, isAccessEnabled, verifyAccessJwt } from "@server/auth/access-plugin";
import { loadConfig } from "@server/config";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

const TEAM = "acme";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const AUD = "homestead-aud-tag";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" };
  const fetchJwks = async () => ({ keys: [jwk] });

  // `aud` accepts an array as well as a string: Cloudflare issues arrays.
  const mint = (over: { iss?: string; aud?: string | string[]; exp?: number } = {}) =>
    new SignJWT({ email: "ada@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(over.iss ?? ISSUER)
      .setAudience(over.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(over.exp ?? "1h")
      .sign(privateKey);

  return { fetchJwks, mint, privateKey, jwk };
}

describe("verifyAccessJwt", () => {
  beforeEach(() => {
    clearJwksCache();
  });

  it("accepts a correctly signed token for this application", async () => {
    const { fetchJwks, mint } = await setup();
    const result = await verifyAccessJwt({
      token: await mint(),
      teamDomain: TEAM,
      aud: AUD,
      fetchJwks,
    });
    expect(result.email).toBe("ada@example.com");
  });

  it("rejects a valid token minted for a DIFFERENT Access application", async () => {
    const { fetchJwks, mint } = await setup();
    await expect(
      verifyAccessJwt({
        token: await mint({ aud: "jellyfin-aud-tag" }),
        teamDomain: TEAM,
        aud: AUD,
        fetchJwks,
      }),
    ).rejects.toThrow();
  });

  it("rejects a token from a different issuer", async () => {
    const { fetchJwks, mint } = await setup();
    await expect(
      verifyAccessJwt({
        token: await mint({ iss: "https://evil.cloudflareaccess.com" }),
        teamDomain: TEAM,
        aud: AUD,
        fetchJwks,
      }),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { fetchJwks, mint } = await setup();
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(
      verifyAccessJwt({ token: await mint({ exp: past }), teamDomain: TEAM, aud: AUD, fetchJwks }),
    ).rejects.toThrow();
  });

  it("rejects a token signed by an unknown key", async () => {
    const { fetchJwks } = await setup();
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "mallory@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(other.privateKey);
    await expect(
      verifyAccessJwt({ token: forged, teamDomain: TEAM, aud: AUD, fetchJwks }),
    ).rejects.toThrow();
  });

  it("rejects a garbage token", async () => {
    const { fetchJwks } = await setup();
    await expect(
      verifyAccessJwt({ token: "not.a.jwt", teamDomain: TEAM, aud: AUD, fetchJwks }),
    ).rejects.toThrow();
  });

  // Cloudflare issues `aud` as an ARRAY of audience tags, so these two cases are the
  // realistic shape of both the happy path and the cross-application attack.
  it("accepts an audience array that contains this application", async () => {
    const { fetchJwks, mint } = await setup();
    const token = await mint({ aud: ["jellyfin-aud", AUD] });
    await expect(
      verifyAccessJwt({ token, teamDomain: TEAM, aud: AUD, fetchJwks }),
    ).resolves.toMatchObject({ email: "ada@example.com" });
  });

  it("rejects an audience array listing only other applications", async () => {
    const { fetchJwks, mint } = await setup();
    const token = await mint({ aud: ["jellyfin-aud", "immich-aud"] });
    await expect(
      verifyAccessJwt({ token, teamDomain: TEAM, aud: AUD, fetchJwks }),
    ).rejects.toThrow();
  });
});

describe("JWKS refetch is not an amplification vector", () => {
  it("fetches once for many failures naming a key we already hold", async () => {
    const { mint, jwk } = await setup();
    let fetches = 0;
    const countingFetch = async () => {
      fetches += 1;
      return { keys: [jwk] };
    };
    // A unique domain so this test starts from a cold cache regardless of test order.
    const domain = `refetch-known-${Math.random().toString(36).slice(2)}`;

    for (let i = 0; i < 10; i++) {
      const forged = await mint({ aud: "wrong-aud" }); // valid signature, known kid
      await verifyAccessJwt({
        token: forged,
        teamDomain: domain,
        aud: AUD,
        fetchJwks: countingFetch,
      }).catch(() => {});
    }

    // One cold-cache fetch. Ten failures whose kid is known must add none: the failure
    // is a wrong audience, not a rotation, so refetching would be pure amplification.
    expect(fetches).toBe(1);
  });

  it("fetches at most twice for many failures naming an unknown key", async () => {
    const { jwk, privateKey } = await setup();
    let fetches = 0;
    const countingFetch = async () => {
      fetches += 1;
      return { keys: [jwk] };
    };
    const domain = `refetch-unknown-${Math.random().toString(36).slice(2)}`;

    for (let i = 0; i < 10; i++) {
      const forged = await new SignJWT({ email: "mallory@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: `unknown-${i}` })
        .setIssuer(ISSUER)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
      await verifyAccessJwt({
        token: forged,
        teamDomain: domain,
        aud: AUD,
        fetchJwks: countingFetch,
      }).catch(() => {});
    }

    // One cold-cache fetch, plus at most one rotation probe. The cooldown absorbs the
    // rest — otherwise ten unauthenticated requests would mean ten outbound fetches.
    expect(fetches).toBeLessThanOrEqual(2);
  });
});

const base = {
  HOMESTEAD_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
  HOMESTEAD_BASE_URL: "http://localhost:3000",
};

describe("dormancy", () => {
  it("is disabled with no Access configuration", () => {
    expect(isAccessEnabled(loadConfig({ ...base }))).toBe(false);
  });

  it("is disabled with only one of the two values", () => {
    expect(isAccessEnabled(loadConfig({ ...base, HOMESTEAD_ACCESS_AUD: "x" }))).toBe(false);
  });

  it("is enabled with both", () => {
    expect(
      isAccessEnabled(
        loadConfig({ ...base, HOMESTEAD_ACCESS_AUD: "x", HOMESTEAD_ACCESS_TEAM_DOMAIN: "acme" }),
      ),
    ).toBe(true);
  });
});
