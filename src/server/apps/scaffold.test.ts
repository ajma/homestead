import { scaffoldCompose } from "@server/apps/scaffold";
import { describe, expect, it } from "vitest";

describe("scaffoldCompose", () => {
  it("produces a compose file with one commented-out service", () => {
    const yaml = scaffoldCompose("Jellyfin");
    expect(yaml).toContain("services:");
    expect(yaml).toContain("Jellyfin");
  });

  it("is valid YAML that declares at least one service key", () => {
    // A scaffold that `docker compose config` rejects makes the app unusable the moment
    // it is created, and the user has no editor yet to fix it — that is Phase 1F.
    const yaml = scaffoldCompose("Jellyfin");
    expect(yaml).toMatch(/^services:$/m);
    expect(yaml.split("\n").some((l) => /^\s{2}\w[\w-]*:$/.test(l))).toBe(true);
  });

  it("does not interpolate the display name into a YAML key", () => {
    // "My App: v2" as a service key would produce a parse error at creation time.
    const yaml = scaffoldCompose('My App: v2 "quoted"');
    expect(yaml).toMatch(/^services:$/m);
    expect(yaml).not.toMatch(/^\s{2}My App: v2/m);
  });

  it("names the service after a slugified display name where it can", () => {
    expect(scaffoldCompose("Home Assistant")).toContain("home-assistant:");
  });

  it("falls back to a generic service name when nothing usable survives slugifying", () => {
    expect(scaffoldCompose("!!!")).toContain("app:");
  });
});
