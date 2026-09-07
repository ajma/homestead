import type { TunnelRuntime } from "@shared/cloudflare.js";

export type RuntimeDeps = {
  listContainers: () => Promise<{ id: string; image: string }[]>;
  writeProject: (slug: string, files: Record<string, string>) => Promise<void>;
};

export async function detectRuntime(deps: RuntimeDeps): Promise<TunnelRuntime> {
  const containers = await deps.listContainers();
  const cloudflared = containers.find((c) => c.image.includes("cloudflared"));
  if (cloudflared) {
    return { kind: "adopted", containerId: cloudflared.id };
  }
  return { kind: "none" };
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

  await deps.writeProject("homestead-tunnel", {
    "compose.yaml": composeYaml,
    ".env": envFile,
  });

  return { kind: "deployed", projectSlug: "homestead-tunnel" };
}
