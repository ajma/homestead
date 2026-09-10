import { isAccessEnabled, verifyAccessJwt } from "@server/auth/access-plugin";
import { loadConfig } from "@server/config";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

const TEAM = "acme";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const AUD = "homestead-aud-tag";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" };
  const fetchJwks = async () => ({ keys: [jwk] });

  const mint = (over: Record<string, unknown> = {}) =>
    new SignJWT({ email: "ada@example.com", ...over })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(String(over.iss ?? ISSUER))
      .setAudience((over.aud as string) ?? AUD)
      .setIssuedAt()
      .setExpirationTime(over.exp ? Number(over.exp) : "1h")
      .sign(privateKey);

  return { fetchJwks, mint, privateKey };
}

describe("verifyAccessJwt", () => {
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
