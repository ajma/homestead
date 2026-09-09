import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { blankScaffold } from "./doc.js";

describe("blankScaffold", () => {
  it("puts the example comment above an explicit empty map", () => {
    // Spec §9.3: `services:` followed only by comments parses as null and is
    // an INVALID config. The empty map is what keeps the scaffold valid.
    const out = blankScaffold("media");
    expect(out).toContain("services: {}");
    expect(out.indexOf("# Add services below")).toBeLessThan(
      out.indexOf("services: {}"),
    );
    expect(out).toContain("name: media");
  });

  it("writes no x-homestead block", () => {
    // The block marked provenance — its absence meant Homestead had adopted
    // the directory rather than created it, and deletion asked for the slug
    // twice instead of once. With that distinction gone nothing reads the
    // block, and writing a key into a file the user owns to record something
    // nobody consults is worse than not writing it.
    expect(blankScaffold("media")).not.toContain("x-homestead");
  });

  it("is parseable YAML with the slug as the compose project name", () => {
    expect(parse(blankScaffold("media"))).toEqual({
      name: "media",
      services: {},
    });
  });
});
