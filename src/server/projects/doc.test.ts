import { describe, expect, it } from "vitest";
import {
  blankScaffold,
  hasHomesteadBlock,
  injectHomesteadBlock,
} from "./doc.js";

const ANNOTATED = `# My homelab media stack
# get the API key from the Immich admin panel
services:
  web:
    image: nginx   # pinned deliberately
    ports:
      - '127.0.0.1:8080:80'
`;

describe("injectHomesteadBlock", () => {
  it("keeps every comment, including inline ones", () => {
    const out = injectHomesteadBlock(ANNOTATED, { kind: "paste" });
    expect(out).toContain("# My homelab media stack");
    expect(out).toContain("# get the API key from the Immich admin panel");
    expect(out).toContain("# pinned deliberately");
  });

  it("adds the provenance block", () => {
    const out = injectHomesteadBlock(ANNOTATED, { kind: "paste" });
    expect(hasHomesteadBlock(out)).toBe(true);
    expect(out).toContain("x-homestead:");
    expect(out).toContain("kind: paste");
  });

  it("leaves an existing x-homestead block alone", () => {
    const already =
      "x-homestead:\n  schemaVersion: 1\n  source:\n    kind: blank\nservices: {}\n";
    expect(injectHomesteadBlock(already, { kind: "paste" })).toBe(already);
  });

  it("returns unparseable content untouched rather than throwing", () => {
    // Spec §6.1: an invalid paste is stored as given; the detail page surfaces
    // parseError. Discarding it would lose content the user has nowhere else.
    const broken = "services:\n  - this is: [not valid\n";
    expect(injectHomesteadBlock(broken, { kind: "paste" })).toBe(broken);
  });

  /**
   * The gap the test above could not express: its fixture fails `doc.errors`,
   * which is the branch that already returned. These parse *cleanly* into
   * something `setIn` refuses — a pasted URL, log line, or list fragment. The
   * throw escaped into the route as a 500 after `createProject` had already
   * made the directory, so the advertised retry then hit a 409.
   */
  it("returns valid YAML that is not a mapping untouched rather than throwing", () => {
    for (const content of ["just a string", "- a\n- b\n", "42\n"]) {
      expect(() =>
        injectHomesteadBlock(content, { kind: "paste" }),
      ).not.toThrow();
      expect(injectHomesteadBlock(content, { kind: "paste" })).toBe(content);
    }
  });

  it("preserves CRLF line endings from Windows editors", () => {
    const crlf =
      "# Windows compose\r\nservices:\r\n  web:\r\n    image: nginx\r\n";
    const out = injectHomesteadBlock(crlf, { kind: "paste" });
    expect(out).toContain("\r\n");
    expect(out.includes("\r\n")).toBe(true);
    expect(out.split("\r\n").length).toBeGreaterThan(1);
  });

  it("preserves LF line endings for Unix files", () => {
    const lf = "# Unix compose\nservices:\n  web:\n    image: nginx\n";
    const out = injectHomesteadBlock(lf, { kind: "paste" });
    // Should have LF but no CRLF sequences
    expect(out.includes("\n")).toBe(true);
    expect(out.includes("\r\n")).toBe(false);
  });

  it("leaves scalar x-homestead values alone rather than overwriting", () => {
    const scalar = "x-homestead: hello\nservices: {}\n";
    expect(injectHomesteadBlock(scalar, { kind: "paste" })).toBe(scalar);
  });
});

describe("hasHomesteadBlock", () => {
  it("is false for an adopted project, which is the provenance signal", () => {
    expect(hasHomesteadBlock(ANNOTATED)).toBe(false);
  });
  it("is false for content it cannot parse", () => {
    expect(hasHomesteadBlock("services:\n  - [broken\n")).toBe(false);
  });
  it("is false when x-homestead is a scalar string", () => {
    expect(hasHomesteadBlock("x-homestead: hello\nservices: {}\n")).toBe(false);
  });
  it("is false when x-homestead is a number", () => {
    expect(hasHomesteadBlock("x-homestead: 42\nservices: {}\n")).toBe(false);
  });
  it("is false when x-homestead is an array", () => {
    expect(hasHomesteadBlock("x-homestead: [a, b]\nservices: {}\n")).toBe(
      false,
    );
  });
  it("is false when x-homestead is null", () => {
    expect(hasHomesteadBlock("x-homestead: null\nservices: {}\n")).toBe(false);
  });
});

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
    expect(hasHomesteadBlock(out)).toBe(true);
  });
});
