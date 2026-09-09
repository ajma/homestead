import type { MonitorType } from "@shared/monitoring.js";

/**
 * What each monitor type is called on screen.
 *
 * `http` and `reachability` are both HTTP requests to the same service, and
 * the type names say nothing about the difference that matters: one is a
 * loopback request from inside the box, the other is the URL a person would
 * type, resolved over DNS and admitted by Cloudflare Access. Read as bare type
 * names, "http up, reachability down" reads like a contradiction rather than
 * the ordinary and useful state of "running, but not reachable from outside".
 *
 * The type strings stay as they are: `deriveTier` matches on them, they are
 * written into every monitor row, and renaming them would be a migration to
 * buy what a lookup table buys for nothing.
 */
export const monitorLabels: Record<MonitorType, string> = {
  http: "HTTP (internal)",
  reachability: "HTTP (public)",
  dns: "DNS",
  docker: "Container",
  tcp: "TCP",
  tailscale: "Tailscale",
  push: "Push",
};

export function monitorLabel(type: MonitorType): string {
  return monitorLabels[type] ?? type;
}
