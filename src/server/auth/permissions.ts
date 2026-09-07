import { homesteadStatement } from "@shared/permissions.js";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

export const statement = {
  ...defaultStatements,
  ...homesteadStatement,
} as const;

export const ac = createAccessControl(statement);

export const adminRole = ac.newRole({
  ...adminAc.statements,
  project: ["read", "create", "update", "delete", "control"],
  compose: ["read", "write"],
  tunnel: ["read", "create", "delete"],
  app: ["read", "create", "update", "delete"],
  logs: ["read"],
  stats: ["read"],
  settings: ["read", "write"],
  device: ["read", "create", "update", "delete"],
  monitor: ["read", "create", "update", "delete"],
  exposure: ["read", "create", "update", "delete"],
});

export const viewerRole = ac.newRole({
  app: ["read"],
});

export const roles = { admin: adminRole, viewer: viewerRole };
