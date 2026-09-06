export type PublishedPort = {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
  /** True when bound to loopback only — reachable by the tunnel but not the LAN (spec §7.4). */
  loopbackOnly: boolean;
};

export type AppMeta = {
  name: string;
  icon?: string;
  port?: number;
  path?: string;
  enabled: boolean;
};

export type ServiceModel = {
  name: string;
  image?: string;
  ports: PublishedPort[];
  labels: Record<string, string>;
  app: AppMeta | null;
};

export type ProjectMeta = {
  schemaVersion: number;
  displayName?: string;
  description?: string;
  icon?: string;
  system: boolean;
};

export type VolumeRef = {
  /** The compose file's key for this volume. */
  key: string;
  /** The resolved Docker volume name — what `docker volume ls` shows. */
  name: string;
  /** True when declared external: owned elsewhere, must never be offered for deletion. */
  external: boolean;
};

export type ProjectModel = {
  projectName: string;
  services: ServiceModel[];
  /** Top-level named volumes this project owns, sorted by key. */
  volumes: VolumeRef[];
  meta: ProjectMeta;
};

export type OperationKind = "up" | "down" | "restart" | "pull";
export type OperationStatus = "running" | "succeeded" | "failed";

/**
 * The one shape a lifecycle operation ever has, in memory or out of the
 * database. Deliberately excludes `output` — history listings must not carry
 * command output — and `actorUserId`, which is an audit column, not client
 * state.
 */
export type Operation = {
  id: string;
  slug: string;
  kind: OperationKind;
  status: OperationStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
};
