import { z } from "zod";

export type EnumeratedApp = {
  key: string;
  projectSlug: string;
  service: string;
  hostPort: number;
};

// Zod schema for a port entry
const portSchema = z.object({
  published: z.union([z.string(), z.number()]).optional(),
  target: z.number().optional(),
  mode: z.string().optional(),
  protocol: z.string().optional(),
  host_ip: z.string().optional(),
});

// Zod schema for a service
const serviceSchema = z.object({
  ports: z.array(portSchema).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

// Zod schema for the compose config
const composeConfigSchema = z.object({
  services: z.record(z.string(), serviceSchema),
});

export function enumerateApps(
  projectSlug: string,
  config: unknown,
): EnumeratedApp[] {
  // Defensively parse the config, returning [] on any error
  const parseResult = composeConfigSchema.safeParse(config);
  if (!parseResult.success) {
    return [];
  }

  const { services } = parseResult.data;
  const apps: EnumeratedApp[] = [];

  for (const [serviceName, service] of Object.entries(services)) {
    // Skip services without published ports
    if (!service.ports || service.ports.length === 0) {
      continue;
    }

    // Skip services that explicitly opt out
    if (service.labels?.["homestead.app.enabled"]?.toLowerCase() === "false") {
      continue;
    }

    // Extract all published ports (container-only ports have no published field)
    const publishedPorts = service.ports
      .filter((p) => p.published !== undefined)
      .map((p) => Number(p.published))
      .filter((p) => !Number.isNaN(p));

    if (publishedPorts.length === 0) {
      continue; // Skip if no valid published ports
    }

    // Determine which port to use
    let hostPort: number;
    const labeledPort = service.labels?.["homestead.app.port"];

    if (labeledPort) {
      // Use the explicitly labeled port, but only if it's actually published
      const labeledPortNum = Number(labeledPort);
      if (
        !Number.isNaN(labeledPortNum) &&
        publishedPorts.includes(labeledPortNum)
      ) {
        hostPort = labeledPortNum;
      } else {
        // Fall back to lowest if label is invalid or not published
        hostPort = Math.min(...publishedPorts);
      }
    } else {
      // Use the lowest published port
      hostPort = Math.min(...publishedPorts);
    }

    apps.push({
      key: `${projectSlug}:${serviceName}`,
      projectSlug,
      service: serviceName,
      hostPort,
    });
  }

  // Sort by service name for stable ordering
  return apps.sort((a, b) => a.service.localeCompare(b.service));
}
