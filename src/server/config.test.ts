import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("applies defaults when nothing is set", () => {
    const c = loadConfig({});
    expect(c.dataDir).toBe("/var/lib/homestacks");
    expect(c.projectsDir).toBe("/opt/stacks");
    expect(c.port).toBe(7420);
    expect(c.secretKey).toBeUndefined();
  });

  it("defaults projectsHostDir to projectsDir", () => {
    const c = loadConfig({ HOMESTACKS_PROJECTS: "/opt/stacks" });
    expect(c.projectsHostDir).toBe("/opt/stacks");
  });

  it("keeps projectsHostDir distinct when set, for path translation", () => {
    const c = loadConfig({
      HOMESTACKS_PROJECTS: "/data/stacks",
      HOMESTACKS_PROJECTS_HOST: "/volume2/docker",
    });
    expect(c.projectsDir).toBe("/data/stacks");
    expect(c.projectsHostDir).toBe("/volume2/docker");
  });

  it("rejects relative paths", () => {
    expect(() => loadConfig({ HOMESTACKS_DATA: "relative/path" })).toThrow(
      ConfigError,
    );
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(ConfigError);
  });

  it("strips a trailing slash so path joins do not double up", () => {
    const c = loadConfig({ HOMESTACKS_PROJECTS: "/opt/stacks/" });
    expect(c.projectsDir).toBe("/opt/stacks");
  });

  describe("baseUrl", () => {
    it("defaults to localhost on the configured port when unset", () => {
      expect(loadConfig({}).baseUrl).toBe("http://localhost:7420");
      expect(loadConfig({ PORT: "9000" }).baseUrl).toBe(
        "http://localhost:9000",
      );
    });

    it("falls back to the default when empty or whitespace", () => {
      expect(loadConfig({ HOMESTACKS_BASE_URL: "" }).baseUrl).toBe(
        "http://localhost:7420",
      );
      expect(loadConfig({ HOMESTACKS_BASE_URL: "   " }).baseUrl).toBe(
        "http://localhost:7420",
      );
    });

    it("accepts a LAN origin", () => {
      const c = loadConfig({ HOMESTACKS_BASE_URL: "http://192.168.1.50:7420" });
      expect(c.baseUrl).toBe("http://192.168.1.50:7420");
    });

    it("accepts an https origin", () => {
      const c = loadConfig({
        HOMESTACKS_BASE_URL: "https://homestacks.example.com",
      });
      expect(c.baseUrl).toBe("https://homestacks.example.com");
    });

    it("trims surrounding whitespace", () => {
      const c = loadConfig({
        HOMESTACKS_BASE_URL: "  https://homestacks.example.com  ",
      });
      expect(c.baseUrl).toBe("https://homestacks.example.com");
    });

    it("rejects a malformed value", () => {
      expect(() => loadConfig({ HOMESTACKS_BASE_URL: "not-a-url" })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ HOMESTACKS_BASE_URL: "not-a-url" })).toThrow(
        "invalid origin format",
      );
    });

    it("rejects a value with a path", () => {
      expect(() =>
        loadConfig({ HOMESTACKS_BASE_URL: "https://example.com/homestacks" }),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({ HOMESTACKS_BASE_URL: "https://example.com/homestacks" }),
      ).toThrow("must not contain path, query, or hash");
    });

    it("rejects a wildcard", () => {
      expect(() => loadConfig({ HOMESTACKS_BASE_URL: "*" })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ HOMESTACKS_BASE_URL: "*" })).toThrow(
        "wildcard (*) not allowed",
      );
    });
  });

  describe("trustedOrigins", () => {
    it("returns undefined when unset", () => {
      const c = loadConfig({});
      expect(c.trustedOrigins).toBeUndefined();
    });

    it("returns undefined when empty string", () => {
      const c = loadConfig({ HOMESTACKS_TRUSTED_ORIGINS: "" });
      expect(c.trustedOrigins).toBeUndefined();
    });

    it("returns undefined when whitespace only", () => {
      const c = loadConfig({ HOMESTACKS_TRUSTED_ORIGINS: "   " });
      expect(c.trustedOrigins).toBeUndefined();
    });

    it("parses a single origin", () => {
      const c = loadConfig({
        HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173",
      });
      expect(c.trustedOrigins).toEqual(["http://localhost:5173"]);
    });

    it("parses comma-separated origins", () => {
      const c = loadConfig({
        HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173,https://example.com",
      });
      expect(c.trustedOrigins).toEqual([
        "http://localhost:5173",
        "https://example.com",
      ]);
    });

    it("trims whitespace around entries", () => {
      const c = loadConfig({
        HOMESTACKS_TRUSTED_ORIGINS:
          " http://localhost:5173 , https://example.com ",
      });
      expect(c.trustedOrigins).toEqual([
        "http://localhost:5173",
        "https://example.com",
      ]);
    });

    it("rejects wildcard", () => {
      expect(() => loadConfig({ HOMESTACKS_TRUSTED_ORIGINS: "*" })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ HOMESTACKS_TRUSTED_ORIGINS: "*" })).toThrow(
        "wildcard (*) not allowed",
      );
    });

    it("rejects wildcard in list", () => {
      expect(() =>
        loadConfig({
          HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173,*",
        }),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({
          HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173,*",
        }),
      ).toThrow("wildcard (*) not allowed");
    });

    it("rejects origin with path", () => {
      expect(() =>
        loadConfig({
          HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173/path",
        }),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({
          HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173/path",
        }),
      ).toThrow("must not contain path");
    });

    it("rejects origin with query", () => {
      expect(() =>
        loadConfig({
          HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173?query",
        }),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({
          HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173?query",
        }),
      ).toThrow("must not contain path, query, or hash");
    });

    it("rejects origin with hash", () => {
      expect(() =>
        loadConfig({
          HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173#hash",
        }),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({
          HOMESTACKS_TRUSTED_ORIGINS: "http://localhost:5173#hash",
        }),
      ).toThrow("must not contain path, query, or hash");
    });

    it("rejects invalid origin format", () => {
      expect(() =>
        loadConfig({ HOMESTACKS_TRUSTED_ORIGINS: "not-a-url" }),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({ HOMESTACKS_TRUSTED_ORIGINS: "not-a-url" }),
      ).toThrow("invalid origin format");
    });
  });
});
