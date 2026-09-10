import { CLIENT_IP_HEADERS } from "@server/app";
import { IP_ADDRESS_HEADERS } from "@server/auth/auth";
import { describe, expect, it } from "vitest";

describe("IP header invariants", () => {
  it("CLIENT_IP_HEADERS contains every header Better-Auth reads", () => {
    // Better-Auth's ipAddressHeaders must be a subset of CLIENT_IP_HEADERS.
    // A header in the former but not the latter would let a client forge IPs:
    // `buildForwardedHeaders` wouldn't strip it, so Better-Auth would believe it.
    for (const header of IP_ADDRESS_HEADERS) {
      expect(CLIENT_IP_HEADERS.has(header)).toBe(true);
    }
  });
});
