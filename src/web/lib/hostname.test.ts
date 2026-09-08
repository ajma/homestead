import { describe, expect, it } from "vitest";
import { composeHostname, splitHostname } from "./hostname.js";

const zones = [
  { id: "z1", name: "example.com" },
  { id: "z2", name: "sub.example.com" },
];

describe("composeHostname", () => {
  it("joins a label to its zone", () => {
    expect(composeHostname("metube", "example.com")).toBe("metube.example.com");
  });

  it("treats an empty label as the zone apex", () => {
    // Exposing the bare domain is legitimate, and "" is how the field says so.
    expect(composeHostname("", "example.com")).toBe("example.com");
    expect(composeHostname("   ", "example.com")).toBe("example.com");
  });

  it("allows a multi-label prefix", () => {
    expect(composeHostname("a.b", "example.com")).toBe("a.b.example.com");
  });

  it("tolerates a label typed with a trailing dot", () => {
    expect(composeHostname("metube.", "example.com")).toBe(
      "metube.example.com",
    );
  });

  it("lowercases, because DNS does not care and comparisons do", () => {
    expect(composeHostname("MeTube", "Example.COM")).toBe("metube.example.com");
  });

  it("returns nothing without a zone, rather than a bare label", () => {
    // A half-built hostname must not look submittable.
    expect(composeHostname("metube", "")).toBe("");
  });
});

describe("splitHostname", () => {
  it("recovers the label and zone of an existing hostname", () => {
    expect(splitHostname("metube.example.com", zones)).toEqual({
      label: "metube",
      zoneId: "z1",
    });
  });

  it("recovers an apex as an empty label", () => {
    expect(splitHostname("example.com", zones)).toEqual({
      label: "",
      zoneId: "z1",
    });
  });

  it("prefers the most specific zone", () => {
    // Splitting on example.com would leave the label "app.sub", which would
    // then recompose into the wrong zone.
    expect(splitHostname("app.sub.example.com", zones)).toEqual({
      label: "app",
      zoneId: "z2",
    });
  });

  it("gives up cleanly on a hostname no zone covers", () => {
    // Editing an exposure whose zone has since been removed must not silently
    // reattach it to some other zone.
    expect(splitHostname("thing.elsewhere.net", zones)).toEqual({
      label: "thing.elsewhere.net",
      zoneId: null,
    });
  });

  it("round-trips with composeHostname", () => {
    for (const host of [
      "metube.example.com",
      "example.com",
      "a.b.example.com",
    ]) {
      const { label, zoneId } = splitHostname(host, zones);
      const zone = zones.find((z) => z.id === zoneId);
      expect(composeHostname(label, zone?.name ?? "")).toBe(host);
    }
  });
});
