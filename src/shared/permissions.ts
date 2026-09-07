export const homesteadStatement = {
  project: ["read", "create", "update", "delete", "control"],
  compose: ["read", "write"],
  tunnel: ["read", "create", "delete"],
  app: ["read"],
  logs: ["read"],
  stats: ["read"],
  settings: ["read", "write"],
  device: ["read", "create", "update", "delete"],
  monitor: ["read", "create", "update", "delete"],
  exposure: ["read", "create", "update", "delete"],
} as const;
