import type { CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { pathAt, schemaCompletion } from "./schema-completion";

describe("pathAt", () => {
  const DOC = [
    "services:",
    "  web:",
    "    image: nginx",
    "    deploy:",
    "      replicas: 2",
    "",
  ].join("\n");

  it("is empty at the top level", () => {
    expect(pathAt("", 0)).toEqual([]);
  });

  it("reads the path from indentation", () => {
    // Cursor on the `image:` line.
    expect(pathAt(DOC, DOC.indexOf("image"))).toEqual(["services", "web"]);
  });

  it("descends into a nested mapping", () => {
    expect(pathAt(DOC, DOC.indexOf("replicas"))).toEqual(["services", "web", "deploy"]);
  });

  it("ignores blank lines and comments when computing the parent", () => {
    const doc = "services:\n  web:\n\n    # a note\n    image: nginx\n";
    expect(pathAt(doc, doc.indexOf("image"))).toEqual(["services", "web"]);
  });

  it("does not walk off the top on a leading-indented first line", () => {
    expect(() => pathAt("    image: nginx\n", 6)).not.toThrow();
  });

  it("does not let a shallow-indented comment corrupt the indentation boundary", () => {
    // The comment sits at column 0 — shallower than every real ancestor. A comment-skip
    // that only fires when the comment happens to share the target's own indentation (as
    // in the case above) wouldn't catch this: without skipping comments outright, this
    // line's indentation would become the new boundary and wrongly exclude `web` and
    // `services`, both of which are indented deeper than the comment but are still the
    // real parents of `other`.
    const doc = "services:\n  web:\n    image: abc\n# a comment at column 0\n    other: def\n";
    expect(pathAt(doc, doc.indexOf("other"))).toEqual(["services", "web"]);
  });

  it("does not add a sequence item as a path segment, though it still shrinks the boundary", () => {
    // `- target: 80` is a genuine ancestor of `published:` by indentation (6 < 8), so this
    // exercises the seq-item skip itself rather than the indent check alone.
    const doc = "services:\n  web:\n    ports:\n      - target: 80\n        published: 8080\n";
    expect(pathAt(doc, doc.indexOf("published"))).toEqual(["services", "web", "ports"]);
  });
});

// Mirrors src/shared/compose-schema.test.ts's fixture shape: patternProperties under
// services, a $ref into $defs, and one real enum (cgroup, since restart's options are
// deliberately curated rather than schema-derived — see schema-completion.ts).
const SCHEMA = {
  properties: {
    services: { patternProperties: { "^[a-zA-Z0-9._-]+$": { $ref: "#/$defs/service" } } },
  },
  $defs: {
    service: {
      properties: {
        image: { type: "string", description: "The image to start the container from." },
        restart: { type: "string" },
        cgroup: { type: "string", enum: ["private", "host"] },
        network_mode: { type: "string" },
        // No `restart` property here — mirrors the real schema, where `deploy` only has
        // `restart_policy`. Exercises Important 1's `deploy.restart` case.
        deploy: { properties: { restart_policy: { type: "object" } } },
        // No `properties` at all — a shell command has no schema-described sub-keys.
        // Exercises Important 1's block-scalar case: a line inside `command: |` that
        // happens to read `restart: ` is not the same path as a service's own `restart`.
        command: { type: "string" },
        // A property whose name is itself the literal 7-character string `"tag:x"`
        // (quotes included) — exists only so Minor 4's test can tell the last-unquoted-
        // colon split apart from a leftmost split by which one it matches.
        '"tag:x"': { type: "string", enum: ["A", "B"] },
        // Mirrors the real schema's long-form `depends_on`: a mapping of dependency
        // service name to a config object with its own `restart` — a boolean meaning
        // "restart dependent services", unrelated to the service-level restart policy.
        // Schema-known (so `isKnownPath` alone would let the curated table through) but
        // not service-level — exercises Minor 5's path-shape gate.
        depends_on: {
          type: "object",
          patternProperties: {
            "^[a-zA-Z0-9._-]+$": {
              type: "object",
              properties: { restart: { type: "boolean" } },
            },
          },
        },
      },
    },
  },
};

function contextAt(text: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc: text, selection: { anchor: pos } });
  return new CompletionContext(state, pos, explicit);
}

// `CompletionSource` is typed to allow an async result (`CompletionResult | null |
// Promise<...>`), even though this implementation is always synchronous — `await`ing it
// resolves either shape identically, so the tests don't need to know which.
async function complete(
  source: CompletionSource,
  context: CompletionContext,
): Promise<CompletionResult | null> {
  return await source(context);
}

describe("schemaCompletion", () => {
  it("offers keysAt at a key position", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    ";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(["image", "restart", "cgroup"]),
    );
  });

  it("carries a key's schema description as info text", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    ";
    const result = await complete(source, contextAt(text, text.length, true));
    const image = result?.options.find((o) => o.label === "image");
    expect(image?.info).toBe("The image to start the container from.");
  });

  it("offers a schema enum after a colon", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    cgroup: ";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual(["private", "host"]);
  });

  it("offers the curated table after a colon when the schema has no enum", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    restart: ";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual([
      "no",
      "always",
      "on-failure",
      "unless-stopped",
    ]);
    expect(result?.options[0]?.info).toBe(
      "Hand-maintained value; not present in the vendored schema.",
    );
  });

  it("prefers the schema's own enum over the curated table when both exist", async () => {
    const schemaWithBoth = {
      properties: {
        services: {
          patternProperties: {
            "^[a-zA-Z0-9._-]+$": {
              properties: { restart: { type: "string", enum: ["only-schema-value"] } },
            },
          },
        },
      },
    };
    const source = schemaCompletion(schemaWithBoth);
    const text = "services:\n  web:\n    restart: ";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual(["only-schema-value"]);
  });

  it("offers nothing inside a comment", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    # image: ";
    expect(await complete(source, contextAt(text, text.length, true))).toBeNull();
  });

  it("offers nothing inside a quoted string", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = 'services:\n  web:\n    image: "nginx: ';
    expect(await complete(source, contextAt(text, text.length, true))).toBeNull();
  });

  it("returns null for a path the schema does not know", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "nonsense:\n  ";
    expect(await complete(source, contextAt(text, text.length, true))).toBeNull();
  });

  // Important 1: the curated table must not fire at a path the schema doesn't recognise,
  // even though the trailing segment matches a curated key.
  it("offers nothing for restart under deploy, where the real key is restart_policy", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    deploy:\n      restart: ";
    expect(await complete(source, contextAt(text, text.length, true))).toBeNull();
  });

  it("offers nothing for a 'restart: ' line inside a command block scalar", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = ["services:", "  web:", "    command: |", "      echo hi", "      restart: "].join(
      "\n",
    );
    expect(await complete(source, contextAt(text, text.length, true))).toBeNull();
  });

  // The binding check that proves the gate fixes rather than disables the feature: a real
  // `restart:` directly under a service (a path the schema does know) must still offer the
  // curated list. This is exercised above too by "offers the curated table after a colon
  // when the schema has no enum", which uses the same service-level position.
  it("still offers the curated restart values directly under a service", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    restart: ";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual([
      "no",
      "always",
      "on-failure",
      "unless-stopped",
    ]);
  });

  // Important 2: network_mode's curated list is genuinely partial (compose also accepts
  // `service:<name>` and `container:<name>`), so its note must say so rather than reading
  // as exhaustive.
  it("marks the network_mode curated list as common values, not the full set", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    network_mode: ";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual(["bridge", "host", "none"]);
    expect(result?.options[0]?.info).toBe(
      "Hand-maintained value; not present in the vendored schema. These are common values, not the full set compose accepts.",
    );
  });

  // Minor 3: YAML only starts a comment at a `#` that opens the line or follows whitespace.
  // Modeled on a git build-context URL fragment (`...r.git#branch:dir`) — the `#` here sits
  // mid-token, so it is not a comment starter, and must not suppress completion.
  it("does not treat a '#' that isn't preceded by whitespace as a comment", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    restart: unless-stopped#pinned";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual([
      "no",
      "always",
      "on-failure",
      "unless-stopped",
    ]);
  });

  // Minor 5: `services.<svc>.depends_on.<svc>.restart` is a real, schema-known path (so
  // `isKnownPath` alone lets it through), but there `restart` is a boolean flag meaning
  // "restart dependent services", not a restart policy — offering `unless-stopped` there
  // would be a wrong list, not an absent one. The curated table must be keyed on the
  // path's shape (`services.<name>.restart` only), not just its trailing key.
  it("offers nothing for restart under a depends_on entry, which is a different flag entirely", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = "services:\n  web:\n    depends_on:\n      db:\n        restart: ";
    expect(await complete(source, contextAt(text, text.length, true))).toBeNull();
  });

  // Minor 4: the key/value split must use the nearest unquoted colon before the cursor, not
  // the first colon in the line — otherwise a quoted key containing a colon (e.g. a Traefik
  // label like `"traefik.http:rule": `) gets split at the colon embedded inside the quotes
  // instead of the real separator after the closing quote.
  it("splits on the colon after a closed quoted key, not one embedded inside it", async () => {
    const source = schemaCompletion(SCHEMA);
    const text = 'services:\n  web:\n    "tag:x": ';
    const result = await complete(source, contextAt(text, text.length, true));
    // A leftmost split would extract the key as `"tag` (truncated at the embedded colon,
    // never closed) — matching nothing and returning null. The rightmost, quote-aware
    // split extracts the whole `"tag:x"`, matching this schema's property of that exact
    // name and returning its enum.
    expect(result?.options.map((o) => o.label)).toEqual(["A", "B"]);
  });
});
