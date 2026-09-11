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
  describe("status-level cases, which win before any fault is considered", () => {
    it("reads 'Healthy' when every probe is up, staying visually quiet", () => {
      expect(rollUpProbes([probe({}), probe({ kind: "http_internal" })])).toEqual({
        status: "up",
        reason: "Healthy",
        since: 1000,
      });
    });

    it("reports unknown for an app with no probes rather than claiming it is up", () => {
      expect(rollUpProbes([])).toEqual({
        status: "unknown",
        reason: "Not checked yet",
        since: null,
      });
    });

    it("reports starting during the grace window", () => {
      expect(rollUpProbes([probe({ status: "starting" })]).reason).toBe("Starting");
    });
  });

  describe("docker: kind and faultClass read together", () => {
    it("names a wedged Docker socket distinctly from stopped containers", () => {
      expect(
        rollUpProbes([probe({ status: "down", faultClass: "network", statusSince: 7 })]),
      ).toEqual({ status: "down", reason: "Docker is unreachable", since: 7 });
    });

    it("names a config fault distinctly, since restarting will not fix it", () => {
      expect(rollUpProbes([probe({ status: "down", faultClass: "config" })]).reason).toBe(
        "Compose config invalid",
      );
    });

    it("blames the containers when they are genuinely not running", () => {
      expect(rollUpProbes([probe({ status: "down", faultClass: "app", statusSince: 7 })])).toEqual({
        status: "down",
        reason: "Containers not running",
        since: 7,
      });
    });

    it("blames the containers when faultClass is null, same as 'app'", () => {
      expect(rollUpProbes([probe({ status: "down", faultClass: null })]).reason).toBe(
        "Containers not running",
      );
    });
  });

  describe("http_internal: kind and faultClass read together", () => {
    it("names an unresolvable address distinctly from a routing failure", () => {
      expect(
        rollUpProbes([probe({ kind: "http_internal", status: "down", faultClass: "config" })])
          .reason,
      ).toBe("Address does not resolve");
    });

    it("names a routing failure distinctly from an unresolvable address", () => {
      expect(
        rollUpProbes([probe({ kind: "http_internal", status: "down", faultClass: "network" })])
          .reason,
      ).toBe("No route to the app");
    });

    it("blames the app when it responded but not acceptably", () => {
      expect(
        rollUpProbes([probe({ kind: "http_internal", status: "down", faultClass: "app" })]).reason,
      ).toBe("App not responding");
    });
  });

  describe("http_external: kind and faultClass read together", () => {
    it("names an Access token problem, not the compose file, and exonerates the app when a sibling is up", () => {
      const out = rollUpProbes([
        probe({ kind: "docker", status: "up" }),
        probe({
          kind: "http_external",
          status: "degraded",
          faultClass: "config",
          statusSince: 2000,
        }),
      ]);
      expect(out).toEqual({
        status: "degraded",
        reason: "Access misconfigured — app is fine",
        since: 2000,
      });
    });

    it("names an Access token problem without exonerating when no sibling is up", () => {
      const out = rollUpProbes([
        probe({ kind: "http_external", status: "degraded", faultClass: "config" }),
      ]);
      expect(out.reason).toBe("Access misconfigured");
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

    it("names the tunnel without exonerating when no sibling is up", () => {
      const out = rollUpProbes([
        probe({ kind: "http_external", status: "down", faultClass: "network" }),
      ]);
      expect(out).toEqual({ status: "down", reason: "Unreachable", since: 1000 });
    });

    it("blames the app through the tunnel, and never exonerates it even when a sibling is up", () => {
      // Cloudflare reached the origin and the origin returned a 5xx: the probe's own
      // classification already blames the app, so the phrase must not contradict it.
      const out = rollUpProbes([
        probe({ kind: "docker", status: "up" }),
        probe({ kind: "http_internal", status: "up" }),
        probe({ kind: "http_external", status: "down", faultClass: "app", statusSince: 2000 }),
      ]);
      expect(out).toEqual({
        status: "degraded",
        reason: "Failing through the tunnel",
        since: 2000,
      });
    });

    it("does not exonerate the app when the internal probe is also failing", () => {
      // Internal `degraded` loses to external `down` on severity, so `http_external` is
      // genuinely the worst probe and the exoneration branch is actually entered here —
      // unlike a version of this test that ties both probes at `down`, which never
      // reaches `http_external` at all and would pass even with no exoneration logic.
      const out = rollUpProbes([
        probe({ kind: "http_internal", status: "degraded", faultClass: "app", statusSince: 2000 }),
        probe({ kind: "http_external", status: "down", faultClass: "network", statusSince: 2500 }),
      ]);
      expect(out.status).toBe("down");
      expect(out.reason).toBe("Unreachable");
    });
  });

  describe("the down-to-degraded rule for a failing external probe", () => {
    it("downgrades down to degraded when a sibling is strictly up", () => {
      const out = rollUpProbes([
        probe({ kind: "docker", status: "up" }),
        probe({ kind: "http_external", status: "down", faultClass: "network" }),
      ]);
      expect(out.status).toBe("degraded");
    });

    it("stays down when there are no siblings at all", () => {
      const out = rollUpProbes([
        probe({ kind: "http_external", status: "down", faultClass: "network" }),
      ]);
      expect(out.status).toBe("down");
    });

    it("stays down when the only sibling is unknown, not up — no evidence is not exoneration", () => {
      const out = rollUpProbes([
        probe({ kind: "docker", status: "unknown" }),
        probe({ kind: "http_external", status: "down", faultClass: "network" }),
      ]);
      expect(out.status).toBe("down");
    });
  });

  describe("worst-probe selection", () => {
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

    it("breaks a severity tie by keeping the timestamp of whichever probe the scan met first", () => {
      // Both probes are `down`, tied at severity 4. A stable scan order means the first
      // one encountered wins; a later "optimisation" that reorders the scan should not be
      // able to silently change which timestamp a tile shows.
      const out = rollUpProbes([
        probe({ kind: "docker", status: "down", faultClass: "app", statusSince: 111 }),
        probe({ kind: "http_internal", status: "down", faultClass: "app", statusSince: 222 }),
      ]);
      expect(out.since).toBe(111);
    });
  });
});
