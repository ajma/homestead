import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(readFileSync("src/server/schema/compose-spec.json", "utf8"));

describe("the vendored compose schema", () => {
  it("is JSON Schema draft 2020-12", () => {
    expect(String(schema.$schema)).toContain("2020-12");
  });

  it("declares the top-level compose keys the editor completes against", () => {
    for (const key of ["services", "volumes", "networks"]) {
      expect(Object.keys(schema.properties ?? {})).toContain(key);
    }
  });

  it("carries a service definition with descriptions, which is where hover docs come from", () => {
    // The spec's claim, verified rather than trusted: 93 service properties of which 89
    // carry descriptions. If a refresh drops descriptions, hover docs silently vanish and
    // nothing else would notice.
    const service = schema.$defs?.service?.properties ?? {};
    expect(Object.keys(service).length).toBeGreaterThan(50);
    const described = Object.values(service).filter(
      (p) => typeof (p as { description?: unknown }).description === "string",
    );
    expect(described.length).toBeGreaterThan(Object.keys(service).length * 0.8);
  });

  it("records the commit it was vendored from", () => {
    // Not fetched at runtime: the NAS may be offline, and an upstream edit must not
    // silently change editor behaviour. The pin is what makes that true.
    const pinned = readFileSync("src/server/schema/PINNED.md", "utf8");
    expect(pinned).toMatch(/[0-9a-f]{40}/);
  });

  it("is small enough to ship to a browser", () => {
    // Roughly 76 KB. An order of magnitude larger would mean upstream restructured and
    // the walk in `@shared/compose-schema` probably needs revisiting too.
    expect(readFileSync("src/server/schema/compose-spec.json").byteLength).toBeLessThan(300_000);
  });
});
