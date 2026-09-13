import type { IngressRule } from "@shared/cloudflare.js";
import { describe, expect, it } from "vitest";
import { removeIngress, spliceIngress } from "./ingress.js";

const CATCH_ALL: IngressRule = { service: "http_status:404" };

describe("spliceIngress", () => {
  it("inserts the new rule before the trailing catch-all", () => {
    const rules: IngressRule[] = [
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      CATCH_ALL,
    ];
    const result = spliceIngress(rules, {
      hostname: "sonarr.example.com",
      service: "http://localhost:8989",
    });
    expect(result).toEqual([
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      { hostname: "sonarr.example.com", service: "http://localhost:8989" },
      CATCH_ALL,
    ]);
  });

  it("appends the rule at the end when there is no catch-all", () => {
    // Decision (see ingress.ts's doc comment): still reachable, since nothing after it
    // could shadow it, and this does not invent a catch-all of its own.
    const rules: IngressRule[] = [
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
    ];
    const result = spliceIngress(rules, {
      hostname: "sonarr.example.com",
      service: "http://localhost:8989",
    });
    expect(result).toEqual([
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      { hostname: "sonarr.example.com", service: "http://localhost:8989" },
    ]);
  });

  it("replaces rather than duplicates an existing entry for the same hostname", () => {
    const rules: IngressRule[] = [
      { hostname: "sonarr.example.com", service: "http://localhost:1111" },
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      CATCH_ALL,
    ];
    const result = spliceIngress(rules, {
      hostname: "sonarr.example.com",
      service: "http://localhost:8989",
    });
    expect(result).toEqual([
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      { hostname: "sonarr.example.com", service: "http://localhost:8989" },
      CATCH_ALL,
    ]);
    // Exactly one entry for the replaced hostname — never two.
    expect(result.filter((r) => r.hostname === "sonarr.example.com")).toHaveLength(1);
  });

  it("preserves the relative order of every other rule", () => {
    const rules: IngressRule[] = [
      { hostname: "a.example.com", service: "http://localhost:1" },
      { hostname: "b.example.com", service: "http://localhost:2" },
      { hostname: "c.example.com", service: "http://localhost:3" },
      CATCH_ALL,
    ];
    const result = spliceIngress(rules, {
      hostname: "d.example.com",
      service: "http://localhost:4",
    });
    expect(result.map((r) => r.hostname)).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
      "d.example.com",
      undefined,
    ]);
  });

  // Binding check (reported, not left inline as a skipped test): reversing the two
  // `slice` halves below — inserting AFTER `index` instead of before it — makes this
  // test fail, which is what proves it actually pins the ordering rather than just the
  // membership of the result.
  it("never places the new rule after the catch-all", () => {
    const rules: IngressRule[] = [CATCH_ALL];
    const result = spliceIngress(rules, {
      hostname: "only.example.com",
      service: "http://localhost:1",
    });
    const catchAllIndex = result.findIndex((r) => r.hostname === undefined);
    const newRuleIndex = result.findIndex((r) => r.hostname === "only.example.com");
    expect(newRuleIndex).toBeLessThan(catchAllIndex);
  });
});

describe("removeIngress", () => {
  it("removes only the named hostname's rule", () => {
    const rules: IngressRule[] = [
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      { hostname: "sonarr.example.com", service: "http://localhost:8989" },
      CATCH_ALL,
    ];
    const result = removeIngress(rules, "sonarr.example.com");
    expect(result).toEqual([
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      CATCH_ALL,
    ]);
  });

  it("leaves the catch-all — removing it would break every other exposed app", () => {
    const rules: IngressRule[] = [
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      CATCH_ALL,
    ];
    const result = removeIngress(rules, "jellyfin.example.com");
    expect(result).toEqual([CATCH_ALL]);
  });

  it("is a no-op on a hostname that is not present", () => {
    const rules: IngressRule[] = [
      { hostname: "jellyfin.example.com", service: "http://localhost:8096" },
      CATCH_ALL,
    ];
    const result = removeIngress(rules, "nonexistent.example.com");
    expect(result).toEqual(rules);
  });

  it("preserves order of the surviving rules", () => {
    const rules: IngressRule[] = [
      { hostname: "a.example.com", service: "http://localhost:1" },
      { hostname: "b.example.com", service: "http://localhost:2" },
      { hostname: "c.example.com", service: "http://localhost:3" },
      CATCH_ALL,
    ];
    const result = removeIngress(rules, "b.example.com");
    expect(result.map((r) => r.hostname)).toEqual(["a.example.com", "c.example.com", undefined]);
  });
});
