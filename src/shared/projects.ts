/**
 * One directory under the projects root as the cheap list scan sees it: no
 * compose parsing, no Docker calls. This is the wire shape of
 * `GET /api/projects`, so it lives here rather than in the server's store —
 * the browser must never import server code, and a hand-copied twin drifts.
 *
 * Deliberately no `path`. The absolute host filesystem path was travelling to
 * the browser and no client code ever read it; the server derives it from the
 * slug through `projectPath`, which is also the only thing that validates it.
 * Do not add it back — a field nothing reads is a disclosure with no benefit,
 * and this endpoint is the one whose audience is most likely to widen.
 */
export type ScanEntry = {
  slug: string;
  hasCompose: boolean;
  hasEnv: boolean;
  composeFile: string | null;
};

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

/**
 * One container as `docker compose ps` reports it. Part of the wire shape of
 * `GET /api/projects/:slug`, so it lives here rather than in the server's
 * Docker layer — the browser must never import server code.
 *
 * `state` is whatever the daemon says: `running`, `exited`, `restarting`,
 * `created`, `paused`, `dead`, `removing`. It is deliberately not a union —
 * narrowing it here would turn a new daemon state into a parse failure — so
 * every consumer must map it totally, with a fallback.
 */
export type ContainerState = {
  service: string;
  name: string;
  state: string;
  health: string | null;
  exitCode: number;
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
