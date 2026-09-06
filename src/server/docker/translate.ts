import { stringify } from "yaml";

type Mount = Record<string, unknown> & { type?: unknown; source?: unknown };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildOverride(
  canonical: unknown,
  opts: { projectsDir: string; projectsHostDir: string; slug: string },
): string | null {
  if (opts.projectsDir === opts.projectsHostDir) return null;

  const from = `${opts.projectsDir}/${opts.slug}`;
  const to = `${opts.projectsHostDir}/${opts.slug}`;
  const services: Record<string, { volumes: Mount[] }> = {};

  for (const [name, raw] of Object.entries(
    asRecord(asRecord(canonical).services),
  )) {
    const volumes = asRecord(raw).volumes;
    if (!Array.isArray(volumes)) continue;

    const rewritten: Mount[] = [];
    for (const entry of volumes) {
      const mount = asRecord(entry) as Mount;
      if (mount.type !== "bind" || typeof mount.source !== "string") continue;
      // Exact match, or a path genuinely beneath the project directory. The
      // trailing-slash test stops `/data/stacks/media-archive` matching `media`.
      const isProjectDir = mount.source === from;
      const isBeneath = mount.source.startsWith(`${from}/`);
      if (!isProjectDir && !isBeneath) continue;
      rewritten.push({
        ...mount,
        source: to + mount.source.slice(from.length),
      });
    }

    if (rewritten.length > 0) services[name] = { volumes: rewritten };
  }

  if (Object.keys(services).length === 0) return null;
  return stringify({ services });
}
