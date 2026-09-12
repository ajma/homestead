/**
 * Resolves Vite's `server.host` / `server.allowedHosts` from environment variables, so the
 * hot-reload deployment (compose.dev.yaml) can be reached from another machine without
 * hardcoding anything VM-specific into this repo. Ordinary local development leaves both
 * variables unset and gets Vite's untouched defaults (loopback only, no allowedHosts check).
 */
export type DevServerOptions = {
  host?: true;
  allowedHosts?: string[];
};

export function resolveDevServerOptions(
  env: Pick<NodeJS.ProcessEnv, "VITE_DEV_HOST" | "VITE_ALLOWED_HOSTS">,
): DevServerOptions {
  const options: DevServerOptions = {};

  // The hot-reload deployment runs with network_mode: host and needs to accept connections
  // from other machines, not just loopback — a bare IP reaches it fine without this (Vite's
  // Host-header check exempts bare IPs), but binding stays loopback-only unless asked.
  if (env.VITE_DEV_HOST) {
    options.host = true;
  }

  // Vite refuses an unrecognised Host header outright; bare IPs are exempt from that check,
  // hostnames are not — which is exactly why this only bites once the box is addressed by
  // name. Comma-separated, and supplied entirely through environment so no VM-specific
  // hostname is hardcoded here.
  if (env.VITE_ALLOWED_HOSTS) {
    const hosts = env.VITE_ALLOWED_HOSTS.split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (hosts.length > 0) {
      options.allowedHosts = hosts;
    }
  }

  return options;
}
