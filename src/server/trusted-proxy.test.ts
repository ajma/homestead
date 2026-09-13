import { accessRejectionLogFields, isTrustedProxyAddress } from "@server/app";
import { describe, expect, it } from "vitest";

/**
 * Unit coverage for the two pure helpers behind the Access hook's trust boundary
 * (`app.ts`). The end-to-end equivalents live in `access-auth.test.ts`, mounted
 * through `app.inject`; some of what matters here — a destroyed socket's `undefined`
 * `remoteAddress` — has no reliable way to be produced through that HTTP-shaped
 * surface, so it is pinned directly against the function instead.
 */
describe("isTrustedProxyAddress", () => {
  it("fails closed when the peer address is undefined", () => {
    // A destroyed socket reports `remoteAddress` as `undefined`. The un-pinned version
    // of this function coerced that to `""` before comparing, which is closed only by
    // accident (no configured entry happens to be the empty string) — mutating the
    // fallback to let `undefined` through survived every existing test. This asserts
    // the behaviour directly rather than relying on that accident.
    expect(isTrustedProxyAddress(undefined, ["127.0.0.1", "::1"])).toBe(false);
    expect(isTrustedProxyAddress(undefined, [])).toBe(false);
  });

  it("rejects garbage that is not an IP address at all", () => {
    expect(isTrustedProxyAddress("not-an-ip", ["127.0.0.1"])).toBe(false);
    expect(isTrustedProxyAddress("", ["127.0.0.1"])).toBe(false);
  });

  it("matches an exact address", () => {
    expect(isTrustedProxyAddress("127.0.0.1", ["127.0.0.1", "::1"])).toBe(true);
    expect(isTrustedProxyAddress("::1", ["127.0.0.1", "::1"])).toBe(true);
    expect(isTrustedProxyAddress("192.168.1.50", ["127.0.0.1", "::1"])).toBe(false);
  });

  it("matches CIDR notation, the way @fastify/proxy-addr (and so trustProxy) does", () => {
    // A plain `includes()` — what this function used to be — accepts neither of these.
    expect(isTrustedProxyAddress("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(isTrustedProxyAddress("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(isTrustedProxyAddress("10.255.255.255", ["10.0.0.0/8"])).toBe(true);
  });

  it("treats an IPv4-mapped IPv6 peer as equal to its IPv4 form, in both directions", () => {
    // Measured by the whole-branch re-review: @fastify/proxy-addr accepts
    // `::ffff:127.0.0.1` against a plain `127.0.0.1` entry; `includes()` does not.
    expect(isTrustedProxyAddress("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
    // And the reverse direction: a plain IPv4 peer against an IPv6-notated entry.
    expect(isTrustedProxyAddress("127.0.0.1", ["::ffff:127.0.0.1"])).toBe(true);
  });

  it("ignores unparseable configuration entries instead of throwing", () => {
    expect(isTrustedProxyAddress("127.0.0.1", ["not-an-ip", "127.0.0.1"])).toBe(true);
    expect(isTrustedProxyAddress("127.0.0.1", ["10.0.0.0/99"])).toBe(false);
  });

  it("trusts the shipped production default (127.0.0.1,::1), not only a test's synthetic peer", () => {
    // The whole-branch review measured that dropping loopback from the trusted list
    // survives the full suite, because every Access test passes through a synthetic
    // `198.18.x.x` address `test-helpers.ts` appends on top of the real default. This
    // exercises the literal default `config.ts` ships (`HOMESTEAD_TRUSTED_PROXIES`'s
    // own default value), independent of any test-harness addition.
    const shippedDefault = ["127.0.0.1", "::1"];
    expect(isTrustedProxyAddress("127.0.0.1", shippedDefault)).toBe(true);
    expect(isTrustedProxyAddress("::1", shippedDefault)).toBe(true);
    expect(isTrustedProxyAddress("192.168.1.50", shippedDefault)).toBe(false);
  });
});

describe("accessRejectionLogFields", () => {
  it("never includes the decoded claim set jose attaches to a claim-validation error", () => {
    const err = Object.assign(new Error('unexpected "aud" claim value'), {
      name: "JWTClaimValidationFailed",
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "aud",
      reason: "check_failed",
      payload: {
        email: "someone@example.com",
        sub: "user-123",
        identity_nonce: "abc123",
        country: "US",
        iss: "https://acme.cloudflareaccess.com",
        aud: ["some-other-app-aud"],
      },
    });

    const fields = accessRejectionLogFields(err, "homestead-aud-tag");

    expect(fields).toMatchObject({
      name: "JWTClaimValidationFailed",
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      expectedAud: "homestead-aud-tag",
      actualAud: ["some-other-app-aud"],
    });
    expect(fields).not.toHaveProperty("payload");
    expect(fields).not.toHaveProperty("email");
    expect(fields).not.toHaveProperty("sub");
    expect(fields).not.toHaveProperty("identity_nonce");
    expect(fields).not.toHaveProperty("country");
    expect(JSON.stringify(fields)).not.toContain("someone@example.com");
    expect(JSON.stringify(fields)).not.toContain("identity_nonce");
  });

  it("reports name/code/message for a non-audience failure, without inventing an aud diagnosis", () => {
    const err = Object.assign(new Error("signature verification failed"), {
      name: "JWSSignatureVerificationFailed",
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });

    const fields = accessRejectionLogFields(err, "homestead-aud-tag");

    expect(fields).toEqual({
      name: "JWSSignatureVerificationFailed",
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      message: "signature verification failed",
    });
  });

  it("handles a thrown non-Error without crashing", () => {
    expect(accessRejectionLogFields("plain string throw", "aud")).toEqual({
      message: "plain string throw",
    });
  });
});
