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
        ports: { type: "array", description: "Exposed ports.", items: { type: "string" } },
        deploy: { $ref: "#/$defs/deployment" },
        build: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                context: { type: "string", description: "Path to the build context." },
                dockerfile: { type: "string" },
              },
            },
          ],
        },
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

  it("returns nothing for a path the schema does not describe, though its parent is real", () => {
    // Guards against a stub that always returns `[]` regardless of input: the parent path
    // must resolve to something before the concocted grandchild path can be trusted to mean
    // anything by returning nothing.
    expect(keysAt(SCHEMA, ["services", "web"]).length).toBeGreaterThan(0);
    expect(keysAt(SCHEMA, ["services", "web", "nonsense"])).toEqual([]);
  });

  it("does not loop forever on a self-referential $ref", () => {
    // A malformed or unusually recursive schema must not hang the editor. Compose's real
    // schema has recursive definitions. Bounded with an explicit timeout so that if the
    // cycle guard regresses, this test fails fast instead of hanging the whole suite.
    const cyclic = {
      properties: { a: { $ref: "#/$defs/a" } },
      $defs: { a: { $ref: "#/$defs/a" } },
    };
    expect(() => keysAt(cyclic, ["a"])).not.toThrow();
  }, 1000);

  it("does not drop a $ref reused legitimately at a later path segment", () => {
    // The walk's cycle guard must track the chain of refs followed to reach one position,
    // not accumulate into a single set shared across an entire path. Here "a" and its child
    // "b" both resolve through the very same $ref — a real reuse, not a cycle — and both
    // must succeed.
    const shared = {
      properties: { a: { $ref: "#/$defs/node" } },
      $defs: { node: { properties: { b: { $ref: "#/$defs/node" } } } },
    };
    expect(keysAt(shared, ["a", "b"]).map((s) => s.label)).toEqual(["b"]);
  });

  it("merges properties across oneOf branches, since build: can be a string or an object", () => {
    const labels = keysAt(SCHEMA, ["services", "web", "build"]).map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(["context", "dockerfile"]));
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

  it("returns nothing where there is no enum, though the key itself is real", () => {
    // Guards against a stub that always returns `[]` regardless of input: a sibling key's
    // enum must actually resolve before "image has no enum" means anything.
    expect(enumsAt(SCHEMA, ["services", "web", "restart"]).length).toBeGreaterThan(0);
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

  it("descends into a oneOf branch's object form", () => {
    expect(isKnownPath(SCHEMA, ["services", "web", "build", "context"])).toBe(true);
  });

  it("addresses a sequence item by numeric index through items", () => {
    expect(isKnownPath(SCHEMA, ["services", "web", "ports", "0"])).toBe(true);
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

  it("offers build:'s object-form keys, since build: is a oneOf of string or object", () => {
    // `build:` in object form is mainstream compose syntax. Before the oneOf/anyOf/allOf
    // merge, this returned [] because the walk only ever looked at the schema's first,
    // string-typed branch.
    const labels = keysAt(real, ["services", "web", "build"]).map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(["context", "dockerfile"]));
  });

  it("knows build.context, reached through build:'s object oneOf branch", () => {
    expect(isKnownPath(real, ["services", "web", "build", "context"])).toBe(true);
  });

  it("knows depends_on.<name>.condition, reached through depends_on:'s object oneOf branch", () => {
    // `depends_on:` in object (long) form is the other mainstream shape this schema
    // expresses as a oneOf: a list of service names, or a map of service name to
    // restart/required/condition.
    expect(isKnownPath(real, ["services", "web", "depends_on", "db", "condition"])).toBe(true);
  });

  it("addresses a real sequence item by numeric index, e.g. ports.0", () => {
    // `ports:` is a JSON array; before the items descent, any numeric path segment under a
    // list-valued key was unknown from the first element onward.
    expect(isKnownPath(real, ["services", "web", "ports", "0"])).toBe(true);
  });
});
