import type {
  AppMeta,
  ProjectMeta,
  ProjectModel,
  PublishedPort,
  ServiceModel,
} from "@shared/projects.js";

const LOOPBACK_EXACT = new Set(["::1", "localhost"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsePorts(raw: unknown): PublishedPort[] {
  if (!Array.isArray(raw)) return [];
  const ports: PublishedPort[] = [];
  for (const entry of raw) {
    const p = asRecord(entry);
    const hostPort = Number.parseInt(String(p.published ?? ""), 10);
    const containerPort = Number(p.target);
    if (!Number.isFinite(hostPort) || !Number.isFinite(containerPort)) continue;
    const hostIp =
      typeof p.host_ip === "string" && p.host_ip !== "" ? p.host_ip : "0.0.0.0";
    ports.push({
      hostIp,
      hostPort,
      containerPort,
      protocol: typeof p.protocol === "string" ? p.protocol : "tcp",
      loopbackOnly: LOOPBACK_EXACT.has(hostIp) || hostIp.startsWith("127."),
    });
  }
  return ports;
}

function parseApp(
  name: string,
  labels: Record<string, string>,
  ports: PublishedPort[],
): AppMeta | null {
  if (labels["homestead.app.enabled"] === "false") return null;
  if (ports.length === 0) return null;
  const labelled = Number.parseInt(labels["homestead.app.port"] ?? "", 10);
  const port = Number.isFinite(labelled)
    ? labelled
    : ports.reduce(
        (lowest, p) => (p.containerPort < lowest ? p.containerPort : lowest),
        ports[0]?.containerPort ?? 0,
      );
  const app: AppMeta = {
    name: labels["homestead.app.name"] ?? name,
    port,
    enabled: true,
  };
  if (labels["homestead.app.icon"]) app.icon = labels["homestead.app.icon"];
  if (labels["homestead.app.path"]) app.path = labels["homestead.app.path"];
  return app;
}

function parseMeta(raw: unknown): ProjectMeta {
  const x = asRecord(raw);
  const meta: ProjectMeta = {
    schemaVersion: typeof x.schemaVersion === "number" ? x.schemaVersion : 1,
    system: x.system === true,
  };
  if (typeof x.displayName === "string") meta.displayName = x.displayName;
  if (typeof x.description === "string") meta.description = x.description;
  if (typeof x.icon === "string") meta.icon = x.icon;
  return meta;
}

export function parseCanonical(json: unknown): ProjectModel {
  const root = asRecord(json);
  if (typeof root.name !== "string" || root.name === "") {
    throw new Error("canonical compose config has no project name");
  }
  const services: ServiceModel[] = Object.entries(asRecord(root.services)).map(
    ([name, value]) => {
      const svc = asRecord(value);
      const labels: Record<string, string> = {};
      for (const [k, v] of Object.entries(asRecord(svc.labels)))
        labels[k] = String(v);
      const ports = parsePorts(svc.ports);
      const model: ServiceModel = {
        name,
        ports,
        labels,
        app: parseApp(name, labels, ports),
      };
      if (typeof svc.image === "string") model.image = svc.image;
      return model;
    },
  );
  return {
    projectName: root.name,
    services,
    meta: parseMeta(root["x-homestead"]),
  };
}
