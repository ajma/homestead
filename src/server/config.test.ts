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
});
