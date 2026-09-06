export const homestacksStatement = {
  project: ["read", "create", "update", "delete", "control"],
  compose: ["read", "write"],
  tunnel: ["read", "create", "delete"],
  app: ["read"],
  logs: ["read"],
  stats: ["read"],
  settings: ["read", "write"],
} as const;
