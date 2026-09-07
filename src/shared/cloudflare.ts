export type Scheme = "http" | "https";

/**
 * Sync state belongs to the instance, not to a single exposure. Ingress is
 * pushed as one whole array, so a failed or conflicted push leaves every
 * exposure unpushed together — a per-exposure flag would imply a granularity
 * the API does not have.
 */
export type SyncState = "synced" | "pending" | "conflict" | "error";

export type ExposureSummary = {
  id: string;
  projectSlug: string | null;
  serviceName: string | null;
  hostPort: number;
  hostname: string;
  scheme: Scheme;
  noTlsVerify: boolean;
  label: string | null;
  enabled: boolean;
  accessEnabled: boolean;
};

export type ZoneOption = { id: string; name: string };
export type IdpOption = { id: string; name: string; type: string };

/** How cloudflared is running: adopted from an existing container, or deployed by us. */
export type TunnelRuntime =
  | { kind: "none" }
  | { kind: "adopted"; containerId: string }
  | { kind: "deployed"; projectSlug: string };
