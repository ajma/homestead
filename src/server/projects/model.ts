import type {
  AppMeta,
  ProjectModel,
  PublishedPort,
  ServiceModel,
  VolumeRef,
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

function parseVolumes(raw: unknown): VolumeRef[] {
  const volumes: VolumeRef[] = [];
  const volumesObj = asRecord(raw);
  const entries = Object.entries(volumesObj);

  for (const [key, value] of entries) {
    const vol = asRecord(value);
    const name = typeof vol.name === "string" ? vol.name : key;
    const external = vol.external === true;

    volumes.push({
      key,
      name,
      external,
    });
  }

  // Sort by key using code-unit comparison (not localeCompare)
  volumes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return volumes;
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
    volumes: parseVolumes(root.volumes),
  };
}
