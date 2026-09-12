import { readFileSync } from "node:fs";
import { enumsAt, isKnownPath, keysAt } from "@shared/compose-schema";
import { describe, expect, it } from "vitest";

// A miniature schema shaped like the real one: `patternProperties` under `services`,
// a `$ref` into `$defs`, an enum, and descriptions.
const SCHEMA = {
  properties: {
    services: { patternProperties: { "^[a-zA-Z0-9._-]+$": { $ref: "#/$defs/service" } } },
    volumes: { patternProperties: { ".+": { $ref: "#/$defs/volume" } } },
  },
  $defs: {
    service: {
      properties: {
        image: { type: "string", description: "The image to start the container from." },
        restart: { type: "string", enum: ["no", "always", "on-failure", "unless-stopped"] },
        ports: { type: "array", description: "Exposed ports." },
        deploy: { $ref: "#/$defs/deployment" },
      },
    },
    deployment: { properties: { replicas: { type: "integer", description: "How many." } } },
    volume: { properties: { driver: { type: "string" } } },
  },
};

describe("keysAt", () => {
  it("offers the top-level compose keys at the root", () => {
    expect(keysAt(SCHEMA, []).map((s) => s.label)).toEqual(
      expect.arrayContaining(["services", "volumes"]),
    );
  });

  it("offers service properties inside a named service", () => {
    // The service name is arbitrary, so this only works by matching patternProperties
    // rather than looking up a literal key.
    const labels = keysAt(SCHEMA, ["services", "web"]).map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(["image", "restart", "ports", "deploy"]));
  });

  it("follows a $ref to nested properties", () => {
    expect(keysAt(SCHEMA, ["services", "web", "deploy"]).map((s) => s.label)).toEqual(["replicas"]);
  });

  it("carries the description through as hover docs", () => {
    const image = keysAt(SCHEMA, ["services", "web"]).find((s) => s.label === "image");
    expect(image?.docs).toBe("The image to start the container from.");
  });

  it("returns nothing for a path the schema does not describe", () => {
    expect(keysAt(SCHEMA, ["services", "web", "nonsense"])).toEqual([]);
  });

  it("does not loop forever on a self-referential $ref", () => {
    // A malformed or unusually recursive schema must not hang the editor. Compose's real
    // schema has recursive definitions.
    const cyclic = {
      properties: { a: { $ref: "#/$defs/a" } },
      $defs: { a: { $ref: "#/$defs/a" } },
    };
    expect(() => keysAt(cyclic, ["a"])).not.toThrow();
  });
});

describe("enumsAt", () => {
  it("offers a key's enum values", () => {
    expect(enumsAt(SCHEMA, ["services", "web", "restart"]).map((s) => s.label)).toEqual([
      "no",
      "always",
      "on-failure",
      "unless-stopped",
    ]);
  });

  it("returns nothing where there is no enum", () => {
    expect(enumsAt(SCHEMA, ["services", "web", "image"])).toEqual([]);
  });
});

describe("isKnownPath", () => {
  it("accepts a real path", () => {
    expect(isKnownPath(SCHEMA, ["services", "web", "image"])).toBe(true);
  });

  it("rejects a typo, which is what the unknown-key warning is for", () => {
    expect(isKnownPath(SCHEMA, ["services", "web", "imag"])).toBe(false);
  });

  it("accepts any service name, since those are user-chosen", () => {
    expect(isKnownPath(SCHEMA, ["services", "anything-at-all"])).toBe(true);
  });

  it("does not crash on a garbage schema", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      expect(() => isKnownPath(bad, ["services"])).not.toThrow();
    }
  });
});

describe("against the real vendored schema", () => {
  const real = JSON.parse(readFileSync("src/shared/schema/compose-spec.json", "utf8"));

  it("offers real service properties inside a named service", () => {
    // A walk that only works on a hand-made fixture someone wrote to match the walk is
    // worth very little; this exercises the vendored file's actual shape.
    const labels = keysAt(real, ["services", "web"]).map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(["image", "ports", "environment", "depends_on"]));
  });

  it("offers a real enum", () => {
    // The vendored schema describes `restart`'s options only in prose, not as a JSON
    // Schema `enum` — `cgroup` is the property that actually carries one.
    expect(enumsAt(real, ["services", "web", "cgroup"]).length).toBeGreaterThan(0);
  });
});
