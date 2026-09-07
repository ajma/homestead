import { describe, expect, it } from "vitest";
import { adminRole, roles, viewerRole } from "./permissions.js";

describe("roles", () => {
  it("lets an admin write compose files", () => {
    expect(adminRole.authorize({ compose: ["write"] }).success).toBe(true);
  });

  it("denies a viewer compose read, because .env holds passwords", () => {
    expect(viewerRole.authorize({ compose: ["read"] }).success).toBe(false);
  });

  it("lets a viewer read apps", () => {
    expect(viewerRole.authorize({ app: ["read"] }).success).toBe(true);
  });

  it("denies a viewer project control", () => {
    expect(viewerRole.authorize({ project: ["control"] }).success).toBe(false);
  });

  it("denies a viewer tunnel management", () => {
    expect(viewerRole.authorize({ tunnel: ["create"] }).success).toBe(false);
  });

  it("keeps the admin plugin's built-in user permissions", () => {
    expect(adminRole.authorize({ user: ["create"] }).success).toBe(true);
  });

  it("grants an admin the new device and monitor verbs", () => {
    for (const verb of ["read", "create", "update", "delete"] as const) {
      expect(
        adminRole.authorize({ device: [verb] }).success,
        `device:${verb}`,
      ).toBe(true);
      expect(
        adminRole.authorize({ monitor: [verb] }).success,
        `monitor:${verb}`,
      ).toBe(true);
    }
  });

  it("grants a viewer neither, and still only app:read", () => {
    expect(viewerRole.authorize({ device: ["read"] }).success).toBe(false);
    expect(viewerRole.authorize({ monitor: ["read"] }).success).toBe(false);
    // A device list showing when each phone was last connected is a presence
    // signal. Keeping it admin-only is the decision, not an oversight.
    expect(viewerRole.authorize({ app: ["read"] }).success).toBe(true);
    expect(viewerRole.authorize({ project: ["read"] }).success).toBe(false);
  });

  it("gives an admin full control of exposures", () => {
    for (const action of ["read", "create", "update", "delete"] as const) {
      expect(
        roles.admin.authorize({ exposure: [action] }).success,
        `admin should have exposure:${action}`,
      ).toBe(true);
    }
  });

  it("gives a viewer no exposure permission at all", () => {
    // A hostname is a map of what this household runs and where it is reachable.
    for (const action of ["read", "create", "update", "delete"] as const) {
      expect(
        roles.viewer.authorize({ exposure: [action] }).success,
        `viewer must not have exposure:${action}`,
      ).toBe(false);
    }
  });

  it("exposes exactly the two roles", () => {
    expect(Object.keys(roles).sort()).toEqual(["admin", "viewer"]);
  });
});
