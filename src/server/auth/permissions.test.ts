import { describe, expect, it } from "vitest";
import { adminRole, viewerRole } from "./permissions.js";

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
});
