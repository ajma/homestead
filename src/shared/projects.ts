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

export type ProjectModel = {
  projectName: string;
  services: ServiceModel[];
  meta: ProjectMeta;
};
