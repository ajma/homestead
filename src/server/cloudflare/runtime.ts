import type { TunnelRuntime } from "@shared/cloudflare.js";

export type RuntimeDeps = {
  listContainers: () => Promise<
    { id: string; image: string; project: string }[]
  >;
  writeProject: (slug: string, files: Record<string, string>) => Promise<void>;
  /**
   * Brings the written stack up. Optional so callers that only detect — the
   * status route — need not supply one.
   */
  startProject?: (slug: string) => Promise<void>;
};

export const TUNNEL_PROJECT_SLUG = "homestead-tunnel";

/**
 * What is actually connecting this tunnel, right now.
 *
 * Only a *running* container counts. A written stack that nobody started is
 * `none`, because reporting otherwise is how "Setup complete" came to mean
 * "the files exist" while no connector was attached and every hostname was
 * dead.
 */
export async function detectRuntime(
  deps: Pick<RuntimeDeps, "listContainers">,
): Promise<TunnelRuntime> {
  const containers = await deps.listContainers();
  const cloudflared = containers.find((c) => c.image.includes("cloudflared"));
  if (!cloudflared) return { kind: "none" };

  // Ours to restart, update and read logs from — as opposed to one somebody
  // else started, which Homestead uses but does not own.
  if (cloudflared.project === TUNNEL_PROJECT_SLUG) {
    return { kind: "deployed", projectSlug: TUNNEL_PROJECT_SLUG };
  }
  return { kind: "adopted", containerId: cloudflared.id };
}

export async function deployTunnel(
  deps: RuntimeDeps,
  runToken: string,
): Promise<TunnelRuntime> {
  const composeYaml = `x-homestead:
  system: true
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    network_mode: host
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: \${TUNNEL_TOKEN}
`;

  const envFile = `TUNNEL_TOKEN=${runToken}
`;

  await deps.writeProject(TUNNEL_PROJECT_SLUG, {
    "compose.yaml": composeYaml,
    ".env": envFile,
  });

  // Files on disk are not a running tunnel. Starting here is what makes
  // "Setup complete" mean the hostnames actually resolve to something.
  await deps.startProject?.(TUNNEL_PROJECT_SLUG);

  return { kind: "deployed", projectSlug: TUNNEL_PROJECT_SLUG };
}
