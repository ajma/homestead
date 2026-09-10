import { loadConfig } from "@server/config";
import { describe, expect, it } from "vitest";

const base = {
  HOMESTEAD_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  HOMESTEAD_BASE_URL: "http://localhost:3000",
};

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const c = loadConfig({ ...base });
    expect(c.port).toBe(3000);
    expect(c.composeRoot).toBe("/volume2/docker");
    expect(c.dockerSocket).toBe("/var/run/docker.sock");
  });

  it("decodes the secret key to 32 bytes", () => {
    expect(loadConfig({ ...base }).secretKey).toHaveLength(32);
  });

  it("rejects a secret key that is not 32 bytes", () => {
    expect(() =>
      loadConfig({ ...base, HOMESTEAD_SECRET_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/32 bytes/);
  });

  it("rejects a missing secret key", () => {
    expect(() => loadConfig({ HOMESTEAD_BASE_URL: base.HOMESTEAD_BASE_URL })).toThrow();
  });

  it("splits and trims trusted origins, always including the base URL", () => {
    const c = loadConfig({
      ...base,
      HOMESTEAD_TRUSTED_ORIGINS: "http://nas.local:3000 , https://hs.example.com",
    });
    expect(c.trustedOrigins).toEqual([
      "http://localhost:3000",
      "http://nas.local:3000",
      "https://hs.example.com",
    ]);
  });

  it("leaves Access disabled unless both values are present", () => {
    expect(loadConfig({ ...base }).accessEnabled).toBe(false);
    expect(loadConfig({ ...base, HOMESTEAD_ACCESS_TEAM_DOMAIN: "acme" }).accessEnabled).toBe(false);
    expect(loadConfig({ ...base, HOMESTEAD_ACCESS_AUD: "abc" }).accessEnabled).toBe(false);
    expect(
      loadConfig({ ...base, HOMESTEAD_ACCESS_TEAM_DOMAIN: "acme", HOMESTEAD_ACCESS_AUD: "abc" })
        .accessEnabled,
    ).toBe(true);
  });

  it("treats empty Access strings as absent", () => {
    const c = loadConfig({ ...base, HOMESTEAD_ACCESS_TEAM_DOMAIN: "", HOMESTEAD_ACCESS_AUD: "" });
    expect(c.accessEnabled).toBe(false);
    expect(c.accessTeamDomain).toBeNull();
  });
});
