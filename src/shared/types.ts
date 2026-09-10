export const APP_STATUSES = ["up", "degraded", "down", "starting", "unknown"] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const FAULT_CLASSES = ["app", "network", "config"] as const;
export type FaultClass = (typeof FAULT_CLASSES)[number];

export const PROBE_KINDS = ["docker", "http_internal", "http_external"] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export const ROLES = ["admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isAppStatus(value: string): value is AppStatus {
  return (APP_STATUSES as readonly string[]).includes(value);
}
