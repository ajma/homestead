import { rollUpProbes } from "@server/launcher/status-phrase";
import type { ProbeSnapshot } from "@shared/launcher";
import { describe, expect, it } from "vitest";

const probe = (over: Partial<ProbeSnapshot>): ProbeSnapshot => ({
  kind: "docker",
  label: null,
  status: "up",
  faultClass: null,
  statusSince: 1000,
  lastCheckedAt: 1000,
  ...over,
});

describe("rollUpProbes", () => {
  it("reads 'Healthy' when every probe is up, staying visually quiet", () => {
    expect(rollUpProbes([probe({}), probe({ kind: "http_internal" })])).toEqual({
      status: "up",
      reason: "Healthy",
      since: 1000,
    });
  });

  it("reports unknown for an app with no probes rather than claiming it is up", () => {
    expect(rollUpProbes([])).toEqual({ status: "unknown", reason: "Not checked yet", since: null });
  });

  it("names the tunnel and exonerates the app when only the external probe fails", () => {
    // The whole point of the cause phrase: "Degraded" would send the user to debug
    // Jellyfin when Jellyfin is fine and Cloudflare is not.
    const out = rollUpProbes([
      probe({ kind: "docker", status: "up" }),
      probe({ kind: "http_internal", status: "up" }),
      probe({ kind: "http_external", status: "down", faultClass: "network", statusSince: 2000 }),
    ]);
    expect(out).toEqual({
      status: "degraded",
      reason: "Tunnel unreachable — app is fine",
      since: 2000,
    });
  });

  it("does not exonerate the app when the internal probe is also failing", () => {
    const out = rollUpProbes([
      probe({ kind: "http_internal", status: "down", faultClass: "app", statusSince: 2000 }),
      probe({ kind: "http_external", status: "down", faultClass: "network", statusSince: 2500 }),
    ]);
    expect(out.status).toBe("down");
    expect(out.reason).toBe("App not responding");
  });

  it("blames the containers when the docker probe is down", () => {
    expect(rollUpProbes([probe({ status: "down", faultClass: "app", statusSince: 7 })])).toEqual({
      status: "down",
      reason: "Containers not running",
      since: 7,
    });
  });

  it("names a config fault distinctly, since restarting will not fix it", () => {
    expect(rollUpProbes([probe({ status: "down", faultClass: "config" })]).reason).toBe(
      "Compose config invalid",
    );
  });

  it("reports starting during the grace window", () => {
    expect(rollUpProbes([probe({ status: "starting" })]).reason).toBe("Starting");
  });

  it("takes `since` from the worst probe, not the first or the newest", () => {
    const out = rollUpProbes([
      probe({ kind: "docker", status: "up", statusSince: 5000 }),
      probe({ kind: "http_internal", status: "down", faultClass: "app", statusSince: 300 }),
    ]);
    expect(out.since).toBe(300);
  });

  it("prefers down over degraded over starting over unknown over up", () => {
    const statuses = ["up", "unknown", "starting", "degraded", "down"] as const;
    for (let i = 1; i < statuses.length; i++) {
      const worse = statuses[i] as (typeof statuses)[number];
      const better = statuses[i - 1] as (typeof statuses)[number];
      expect(rollUpProbes([probe({ status: better }), probe({ status: worse })]).status).toBe(
        worse,
      );
    }
  });
});
