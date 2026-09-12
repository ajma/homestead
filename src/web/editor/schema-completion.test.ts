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
});
