import { describe, expect, it } from "vitest";
import { checkForClobber, desiredIngress, fingerprint } from "./reconcile.js";

describe("desiredIngress", () => {
  it("emits one rule per enabled exposure, then a catch-all", () => {
    const rules = desiredIngress([
      {
        hostname: "a.example.com",
        hostPort: 1,
        scheme: "http",
        noTlsVerify: false,
        enabled: true,
      },
      {
        hostname: "b.example.com",
        hostPort: 2,
        scheme: "https",
        noTlsVerify: true,
        enabled: true,
      },
    ]);
    expect(rules).toEqual([
      { hostname: "a.example.com", service: "http://localhost:1" },
      {
        hostname: "b.example.com",
        service: "https://localhost:2",
        originRequest: { noTLSVerify: true },
      },
      { service: "http_status:404" },
    ]);
  });

  it("omits a disabled exposure", () => {
    // The whole array is replaced on every push, so a disabled row must be
    // absent rather than merely unreferenced.
    const rules = desiredIngress([
      {
        hostname: "off.example.com",
        hostPort: 1,
        scheme: "http",
        noTlsVerify: false,
        enabled: false,
      },
    ]);
    expect(rules).toEqual([{ service: "http_status:404" }]);
  });

  it("produces a lone catch-all when there are no exposures", () => {
    expect(desiredIngress([])).toEqual([{ service: "http_status:404" }]);
  });

  it("rejects an empty hostname", () => {
    expect(() =>
      desiredIngress([
        {
          hostname: "",
          hostPort: 8080,
          scheme: "http",
          noTlsVerify: false,
          enabled: true,
        },
      ]),
    ).toThrow(/hostname.*empty/i);
  });

  it("rejects a whitespace-only hostname", () => {
    expect(() =>
      desiredIngress([
        {
          hostname: "  ",
          hostPort: 8080,
          scheme: "http",
          noTlsVerify: false,
          enabled: true,
        },
      ]),
    ).toThrow(/hostname.*empty/i);
  });

  it("rejects a port of 0", () => {
    expect(() =>
      desiredIngress([
        {
          hostname: "valid.example.com",
          hostPort: 0,
          scheme: "http",
          noTlsVerify: false,
          enabled: true,
        },
      ]),
    ).toThrow(/port.*0/);
  });

  it("rejects a negative port", () => {
    expect(() =>
      desiredIngress([
        {
          hostname: "valid.example.com",
          hostPort: -1,
          scheme: "http",
          noTlsVerify: false,
          enabled: true,
        },
      ]),
    ).toThrow(/port.*-1/);
  });

  it("rejects a port above 65535", () => {
    expect(() =>
      desiredIngress([
        {
          hostname: "valid.example.com",
          hostPort: 65536,
          scheme: "http",
          noTlsVerify: false,
          enabled: true,
        },
      ]),
    ).toThrow(/port.*65536/);
  });
});

describe("checkForClobber", () => {
  it("passes when remote matches what we last wrote", () => {
    const remote = [{ service: "http_status:404" }];
    expect(checkForClobber(remote, fingerprint(remote))).toEqual({ ok: true });
  });

  it("passes on a first push with an empty remote", () => {
    expect(checkForClobber([], null).ok).toBe(true);
  });

  it("passes on a first push with only a catch-all", () => {
    expect(checkForClobber([{ service: "http_status:404" }], null).ok).toBe(
      true,
    );
  });

  it("refuses a first push when remote has existing hostname rules", () => {
    // Adopting an existing tunnel with hand-written rules - must not clobber.
    const remote = [
      { hostname: "existing.example.com", service: "http://localhost:8080" },
      { service: "http_status:404" },
    ];
    const r = checkForClobber(remote, null);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining("existing.example.com"),
    });
  });

  it("refuses when remote has drifted from what we last wrote", () => {
    // Someone added a rule in the Cloudflare dashboard. A full-replace push
    // would delete it silently.
    const written = [{ service: "http_status:404" }];
    const remote = [
      { hostname: "manual.example.com", service: "http://localhost:9" },
      { service: "http_status:404" },
    ];
    const r = checkForClobber(remote, fingerprint(written));
    expect(r.ok).toBe(false);
  });

  it("compares against what we wrote, not against what we now want", () => {
    // The distinction is the whole point: a local edit changes desired state and
    // must NOT read as foreign drift, or every push raises a false conflict.
    const written = [{ service: "http_status:404" }];
    const remoteUnchanged = [{ service: "http_status:404" }];
    expect(checkForClobber(remoteUnchanged, fingerprint(written)).ok).toBe(
      true,
    );
  });

  it("is insensitive to key order", () => {
    const a = [{ hostname: "x.example.com", service: "http://localhost:1" }];
    const b = [{ service: "http://localhost:1", hostname: "x.example.com" }];
    expect(checkForClobber(b, fingerprint(a)).ok).toBe(true);
  });

  it("normalizes equivalent values before fingerprinting", () => {
    // Cloudflare might echo back values in different forms - numeric vs string,
    // undefined vs absent, etc. These should produce the same fingerprint.
    const a = [
      {
        hostname: "x.example.com",
        service: "http://localhost:8080",
        someField: undefined,
      },
    ];
    const b = [{ hostname: "x.example.com", service: "http://localhost:8080" }];
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});
