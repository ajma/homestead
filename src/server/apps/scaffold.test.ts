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

  it("does not let a newline in the display name break out of the comment", () => {
    // Measured before the sanitiser: this produced a SECOND top-level `services:` key,
    // which `docker compose config` accepted, planting an arbitrary service. The
    // slugified service key legitimately contains the whole name, "injected" included —
    // that is a safe alnum-and-dash string, not the vulnerability. What must not happen
    // is a second top-level `services:` document key, or the raw text leaking past the
    // first comment line.
    const yaml = scaffoldCompose("Jellyfin\nservices:\n  injected:\n    image: evil");
    expect(yaml.match(/^services:$/gm)).toHaveLength(1);
    expect(yaml.split("\n")[0]).toBe("# Jellyfin");
    expect(yaml).not.toContain("image: evil");
  });

  it("does not let a carriage return in the display name break out of the comment", () => {
    const yaml = scaffoldCompose("Jellyfin\rservices:\r  injected:\r    image: evil");
    expect(yaml.match(/^services:$/gm)).toHaveLength(1);
    expect(yaml.split("\n")[0]).toBe("# Jellyfin");
    expect(yaml).not.toContain("image: evil");
  });

  it("caps a very long display name rather than emitting a wall of comment", () => {
    const yaml = scaffoldCompose("x".repeat(10_000));
    const commentLine = yaml.split("\n")[0] ?? "";
    expect(commentLine.length).toBeLessThan(200);
  });
});
