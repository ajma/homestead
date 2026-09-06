import { describe, expect, it } from "vitest";
import { composeArgs, composePs, validateComposeVerb } from "./compose.js";
import type { Runner } from "./run.js";

const CTX = {
  projectsDir: "/data/stacks",
  projectsHostDir: "/data/stacks",
  dataDir: "/var/lib/homestacks",
  slug: "media",
};

describe("composeArgs", () => {
  it("passes the compose file and no override when translation is inactive", () => {
    expect(composeArgs(CTX, "docker-compose.yml", null, ["up", "-d"])).toEqual([
      "compose",
      "-f",
      "/data/stacks/media/docker-compose.yml",
      "up",
      "-d",
    ]);
  });

  it("appends the override as a second -f, after the base file", () => {
    const args = composeArgs(
      CTX,
      "docker-compose.yml",
      "/var/lib/homestacks/run/media.override.yml",
      ["up", "-d"],
    );
    expect(args.slice(0, 5)).toEqual([
      "compose",
      "-f",
      "/data/stacks/media/docker-compose.yml",
      "-f",
      "/var/lib/homestacks/run/media.override.yml",
    ]);
  });

  it("honours a compose.yaml filename rather than assuming docker-compose.yml", () => {
    expect(composeArgs(CTX, "compose.yaml", null, ["ps"])).toContain(
      "/data/stacks/media/compose.yaml",
    );
  });

  it("never emits -v on down", () => {
    expect(
      composeArgs(CTX, "docker-compose.yml", null, ["down"]),
    ).not.toContain("-v");
  });
});

describe("validateComposeVerb", () => {
  describe("allows safe down operations", () => {
    it("allows down with no args", () => {
      expect(() => validateComposeVerb(["down"])).not.toThrow();
    });

    it("allows down with --remove-orphans", () => {
      expect(() =>
        validateComposeVerb(["down", "--remove-orphans"]),
      ).not.toThrow();
    });

    it("allows down with -t and timeout value", () => {
      expect(() => validateComposeVerb(["down", "-t", "30"])).not.toThrow();
    });

    it("allows down with --timeout and value", () => {
      expect(() =>
        validateComposeVerb(["down", "--timeout", "30"]),
      ).not.toThrow();
    });

    it("allows down with --timeout and zero", () => {
      expect(() =>
        validateComposeVerb(["down", "--timeout", "0"]),
      ).not.toThrow();
    });
  });

  describe("rejects dangerous down operations", () => {
    it("rejects down with -v", () => {
      expect(() => validateComposeVerb(["down", "-v"])).toThrow(
        /volume removal/,
      );
    });

    it("rejects down with --volumes", () => {
      expect(() => validateComposeVerb(["down", "--volumes"])).toThrow(
        /volume removal/,
      );
    });

    it("rejects down with stacked -fv", () => {
      expect(() => validateComposeVerb(["down", "-fv"])).toThrow(/-fv/);
    });

    it("rejects down with stacked -vf", () => {
      expect(() => validateComposeVerb(["down", "-vf"])).toThrow(/-vf/);
    });

    it("rejects down with --rmi and -v", () => {
      // --rmi is encountered first, so that's what gets rejected
      expect(() => validateComposeVerb(["down", "--rmi", "all", "-v"])).toThrow(
        /--rmi/,
      );
    });

    it("rejects down with unknown flag", () => {
      expect(() => validateComposeVerb(["down", "--nuke"])).toThrow(/--nuke/);
    });

    it("rejects down with -t followed by -v", () => {
      expect(() => validateComposeVerb(["down", "-t", "-v"])).toThrow(/-v/);
    });

    it("rejects down with --timeout followed by --volumes", () => {
      expect(() =>
        validateComposeVerb(["down", "--timeout", "--volumes"]),
      ).toThrow(/--volumes/);
    });

    it("rejects down with -t and no value", () => {
      expect(() => validateComposeVerb(["down", "-t"])).toThrow(/-t/);
    });

    it("rejects down with -t and non-numeric value", () => {
      expect(() => validateComposeVerb(["down", "-t", "abc"])).toThrow(/abc/);
    });
  });

  it("allows non-down verbs through", () => {
    expect(() => validateComposeVerb(["up", "-d"])).not.toThrow();
    expect(() => validateComposeVerb(["ps"])).not.toThrow();
    expect(() => validateComposeVerb(["logs", "-f"])).not.toThrow();
  });
});

describe("composePs", () => {
  it("returns valid containers when output contains malformed lines", async () => {
    const mockRun: Runner = async () => ({
      stdout: [
        '{"Service":"web","Name":"proj-web-1","State":"running","Health":"","ExitCode":0}',
        "WARNING: this is not JSON",
        '{"Service":"db","Name":"proj-db-1","State":"running","Health":"healthy","ExitCode":0}',
      ].join("\n"),
      stderr: "",
      code: 0,
    });

    const states = await composePs(CTX, mockRun);
    expect(states).toHaveLength(2);
    expect(states[0]?.service).toBe("web");
    expect(states[1]?.service).toBe("db");
    expect(states[1]?.health).toBe("healthy");
  });
});
