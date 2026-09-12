import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintYaml } from "./yaml-lint";

// A miniature schema shaped like the real one (mirrors src/shared/compose-schema.test.ts):
// `patternProperties` under `services` so service names are arbitrary, a `$ref` into
// `$defs`, and a `oneOf` for `build:`'s string-or-object form.
const SCHEMA = {
  properties: {
    services: { patternProperties: { "^[a-zA-Z0-9._-]+$": { $ref: "#/$defs/service" } } },
  },
  $defs: {
    service: {
      properties: {
        image: { type: "string" },
        ports: { type: "array", items: { type: "string" } },
        build: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                context: { type: "string" },
                dockerfile: { type: "string" },
              },
            },
          ],
        },
        depends_on: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            {
              type: "object",
              patternProperties: {
                ".+": {
                  type: "object",
                  properties: { condition: { type: "string" } },
                },
              },
            },
          ],
        },
      },
    },
  },
};

describe("lintYaml", () => {
  it("yields no diagnostics for valid YAML with only known keys", () => {
    const out = lintYaml("services:\n  web:\n    image: nginx\n", SCHEMA);
    expect(out).toEqual([]);
  });

  it("reports a syntax error positioned inside the offending line", () => {
    const text = "services:\n  web:\n  image nginx\n";
    const out = lintYaml(text, SCHEMA);
    // YAML's own error recovery can turn the malformed line into extra (mis-nested)
    // structure of its own — worth keeping visible, not worth asserting an exact count
    // over. What matters here is that the syntax error itself is reported, and that it
    // is positioned inside the offending third line rather than e.g. always at offset 0.
    const errors = out.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    const thirdLineStart = text.indexOf("image nginx");
    expect(errors.some((d) => d.from >= thirdLineStart && d.to <= text.length)).toBe(true);
    for (const diagnostic of out) {
      expect(diagnostic.message.length).toBeGreaterThan(0);
      expect(diagnostic.from).toBeLessThanOrEqual(diagnostic.to);
      expect(diagnostic.to).toBeLessThanOrEqual(text.length);
    }
  });

  it("reports something legible for a tab-indented document", () => {
    // A common paste artefact: YAML rejects tabs used for indentation outright. Recovery
    // from the resulting broken structure can produce extra diagnostics of its own (e.g.
    // keys knocked out of their intended nesting look unknown at the level they land on);
    // what must hold is that the tab problem itself is reported legibly, at a valid
    // position, without crashing.
    const text = "services:\n\tweb:\n\t\timage: nginx\n";
    const out = lintYaml(text, SCHEMA);
    const errors = out.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    for (const diagnostic of out) {
      expect(diagnostic.message.length).toBeGreaterThan(0);
      expect(diagnostic.from).toBeGreaterThanOrEqual(0);
      expect(diagnostic.to).toBeGreaterThanOrEqual(diagnostic.from);
      expect(diagnostic.to).toBeLessThanOrEqual(text.length);
    }
  });

  it("names the file, not the library, when a compose file has more than one document", () => {
    // `parseDocument`'s own message for this — "Source contains multiple documents;
    // please use YAML.parseAllDocuments()" — is a JavaScript API name aimed at someone
    // calling the `yaml` library from code, not someone editing a compose file. Compose
    // rejects multi-document files too, so the verdict is already right; only the
    // wording needs fixing.
    const text =
      "services:\n  web:\n    image: nginx\n---\nservices:\n  db:\n    image: postgres\n";
    const out = lintYaml(text, SCHEMA);
    const errors = out.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    for (const diagnostic of errors) {
      expect(diagnostic.message).not.toMatch(/parseAllDocuments/);
    }
    expect(errors.some((d) => /single YAML document/.test(d.message))).toBe(true);
  });

  it("warns on an unknown service key rather than erroring", () => {
    // A warning, deliberately: the vendored schema is pinned, so a key added upstream is
    // unknown here and would otherwise look like a mistake the user made.
    const text = "services:\n  web:\n    imag: nginx\n";
    const out = lintYaml(text, SCHEMA);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("warning");
    expect(out[0]?.message).toContain("imag");
    // Positioned exactly at the key, not the whole line or document.
    const keyStart = text.indexOf("imag");
    expect(out[0]?.from).toBe(keyStart);
    expect(out[0]?.to).toBe(keyStart + "imag".length);
  });

  it("yields no diagnostics for a known key", () => {
    const out = lintYaml(
      'services:\n  web:\n    image: nginx\n    ports:\n      - "80:80"\n',
      SCHEMA,
    );
    expect(out).toEqual([]);
  });

  it("does not warn on an arbitrary service name, since service names are pattern-matched", () => {
    const out = lintYaml("services:\n  my-weird-service-name:\n    image: nginx\n", SCHEMA);
    expect(out).toEqual([]);
  });

  it("does not warn on a known key reached through a oneOf branch", () => {
    const out = lintYaml(
      "services:\n  web:\n    build:\n      context: .\n      dockerfile: Dockerfile\n",
      SCHEMA,
    );
    expect(out).toEqual([]);
  });

  it("does not warn on a known key reached through depends_on's map form", () => {
    const out = lintYaml(
      "services:\n  web:\n    depends_on:\n      db:\n        condition: service_healthy\n",
      SCHEMA,
    );
    expect(out).toEqual([]);
  });

  it("does not descend into an unknown key's value looking for further problems", () => {
    // Once "imag" itself is unknown, there is no schema shape to check its children
    // against, so only the one warning should appear, not one per nested key too.
    const out = lintYaml(
      "services:\n  web:\n    imag:\n      nested: whatever\n      more: stuff\n",
      SCHEMA,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("warning");
  });

  it("yields nothing for an empty document", () => {
    expect(lintYaml("", SCHEMA)).toEqual([]);
  });

  it("yields nothing for a document that is only whitespace", () => {
    expect(lintYaml("   \n\n  \n", SCHEMA)).toEqual([]);
  });

  it("reports a legible message, not a crash, for a bare list instead of a mapping", () => {
    const out = lintYaml("- one\n- two\n", SCHEMA);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("error");
    expect(out[0]?.message.length).toBeGreaterThan(0);
    expect(out[0]?.from).toBe(0);
    expect(out[0]?.to).toBeGreaterThan(0);
  });

  it("reports a legible message, not a crash, for a bare scalar instead of a mapping", () => {
    const out = lintYaml("just some text", SCHEMA);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("error");
    expect(out[0]?.message.length).toBeGreaterThan(0);
  });

  it("does not crash on a garbage schema", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      expect(() => lintYaml("services:\n  web:\n    image: nginx\n", bad)).not.toThrow();
    }
  });
});

describe("lintYaml against the real vendored schema", () => {
  const real = JSON.parse(readFileSync("src/shared/schema/compose-spec.json", "utf8"));

  // A reasonably broad, realistic compose document exercising commonly used keys in both
  // their short and long forms. If the schema walk (Task 3) still mis-resolves one of these
  // as unknown, that is a gap worth surfacing rather than quietly asserting it away.
  const REALISTIC = `
services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    image: myapp:latest
    container_name: myapp-web
    restart: unless-stopped
    ports:
      - "8080:80"
    environment:
      NODE_ENV: production
    env_file:
      - .env
    volumes:
      - ./data:/data
    depends_on:
      db:
        condition: service_healthy
    networks:
      - default
    labels:
      com.example.description: "web service"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
      interval: 30s
    deploy:
      replicas: 2
  db:
    image: postgres:16
    volumes:
      - db-data:/var/lib/postgresql/data
volumes:
  db-data: {}
networks:
  default: {}
`;

  it("reports no unknown-key warnings for a realistic, mainstream compose document", () => {
    const out = lintYaml(REALISTIC, real);
    const warnings = out.filter((d) => d.severity === "warning");
    expect(warnings).toEqual([]);
  });

  it("still catches a genuine typo against the real schema", () => {
    const text = "services:\n  web:\n    imag: nginx\n";
    const out = lintYaml(text, real);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("warning");
    expect(out[0]?.message).toContain("imag");
  });

  it("does not warn inside a top-level x- extension block, however deeply nested", () => {
    // `x-defaults: &defaults` is the idiomatic way to share config between services. The
    // extension key itself resolves against the schema's permissive `^x-` pattern, but
    // nothing underneath it is described by the schema at all — walking further would check
    // user-defined content against the root schema and false-warn on every nested key.
    const text = "x-defaults: &defaults\n  restart: always\n  logging:\n    driver: json-file\n";
    const out = lintYaml(text, real);
    expect(out).toEqual([]);
  });

  it("does not warn inside an x- extension block nested under a service", () => {
    const text = "services:\n  web:\n    image: nginx\n    x-custom:\n      inner: whatever\n";
    const out = lintYaml(text, real);
    expect(out).toEqual([]);
  });

  it("does not warn on a merge key inside a service", () => {
    // `parseDocument` is used with merge keys off (YAML 1.2 core schema), so `<<` arrives as
    // a literal key. The schema was never going to know a YAML syntax feature by name.
    const text =
      "x-defaults: &defaults\n  restart: always\nservices:\n  web:\n    <<: *defaults\n    image: nginx\n";
    const out = lintYaml(text, real);
    expect(out).toEqual([]);
  });

  it("still reports a real typo alongside the anchor/extension/merge-key idiom", () => {
    // The idiom in full: an x-defaults block shared via an anchor, merged into a service with
    // `<<`, plus one genuine typo elsewhere. This is the test that proves the fix suppresses
    // the false positives without suppressing real ones — if it reported zero warnings, the
    // feature would have been turned off rather than fixed.
    const text = [
      "x-defaults: &defaults",
      "  restart: always",
      "services:",
      "  web:",
      "    <<: *defaults",
      "    imag: nginx",
      "",
    ].join("\n");
    const out = lintYaml(text, real);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("warning");
    expect(out[0]?.message).toContain("imag");
  });

  it("suppresses unknown-key warnings entirely when the document has a syntax error", () => {
    // A tab-indentation mistake: `yaml`'s error recovery reparents nodes to produce some
    // tree, but it does not reflect what the user typed, so the key walk is suppressed
    // rather than reading a structure that doesn't exist and false-warning on top of it.
    const text = "services:\n\tweb:\n\t\timag: nginx\n";
    const out = lintYaml(text, real);
    const errors = out.filter((d) => d.severity === "error");
    const warnings = out.filter((d) => d.severity === "warning");
    expect(errors.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });
});
