import { describe, expect, it } from "vitest";
import { resolveZoneId } from "./zone.js";

const zones = [
  { id: "z-example", name: "example.com" },
  { id: "z-sub", name: "sub.example.com" },
  { id: "z-other", name: "other.org" },
];

describe("resolveZoneId", () => {
  it("finds the zone a hostname lives under", () => {
    // The exposure form asks for a hostname, not a zone: the zone is implied,
    // and making someone pick it is asking a question the hostname answers.
    expect(resolveZoneId("metube.example.com", zones)).toBe("z-example");
  });

  it("accepts the zone apex itself", () => {
    expect(resolveZoneId("example.com", zones)).toBe("z-example");
  });

  it("prefers the most specific zone", () => {
    // Both match. Choosing example.com would create the record in the wrong
    // zone, and it would resolve for nobody.
    expect(resolveZoneId("app.sub.example.com", zones)).toBe("z-sub");
  });

  it("only matches on a label boundary", () => {
    // "notexample.com" ends with "example.com" as a string but is a different
    // domain, quite possibly someone else's.
    expect(resolveZoneId("www.notexample.com", zones)).toBeNull();
  });

  it("returns null when no zone covers the hostname", () => {
    expect(resolveZoneId("thing.unrelated.net", zones)).toBeNull();
  });

  it("ignores case", () => {
    expect(resolveZoneId("MeTube.Example.COM", zones)).toBe("z-example");
  });

  it("tolerates a trailing dot", () => {
    expect(resolveZoneId("metube.example.com.", zones)).toBe("z-example");
  });

  it("returns null when the account has no zones", () => {
    expect(resolveZoneId("metube.example.com", [])).toBeNull();
  });
});
