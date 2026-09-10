import type { Role } from "./types.js";

export const CAPABILITIES = [
  "app:read",
  "app:config",
  "app:lifecycle",
  "app:secrets",
  "cf:write",
  "user:manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  admin: CAPABILITIES,
  // Viewers see status and health only. No config, no secrets, no logs, no actions.
  viewer: ["app:read"],
};

export function roleHas(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}
