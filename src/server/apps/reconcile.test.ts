import type { MonitorType } from "@shared/monitoring.js";
import { describe, expect, it } from "vitest";
import { configSchemas } from "../monitoring/checks.js";
import { desiredMonitors, planReconcile } from "./reconcile.js";

describe("desiredMonitors", () => {
  const app = {
    key: "media:jellyfin",
    projectSlug: "media",
    service: "jellyfin",
    hostPort: 8096,
  };

  it("provisions two monitors for an unpublished app", () => {
    // DNS and reachability need a hostname to be about.
    const types = desiredMonitors(app, null)
      .map((m) => m.type)
      .sort();
    expect(types).toEqual(["docker", "http"]);
  });

  it("never provisions tcp, which http already subsumes", () => {
    // HTTP runs over TCP: a passing http check has already proved the
    // handshake, so a tcp monitor could only ever restate it — while adding a
    // second required gate that can fail on its own.
    for (const hostname of [null, "jf.example.com"]) {
      const types = desiredMonitors(app, hostname).map((m) => m.type);
      expect(types).not.toContain("tcp");
    }
  });

  it("adds dns and reachability once a hostname exists", () => {
    const types = desiredMonitors(app, "jf.example.com")
      .map((m) => m.type)
      .sort();
    expect(types).toEqual(["dns", "docker", "http", "reachability"]);
  });

  it("makes every monitor required, reachability included", () => {
    // A published app nobody outside can reach is not green. The cost — one
    // Cloudflare outage reddening every published tile — is accepted, and the
    // expanded tile names the check that failed.
    for (const m of desiredMonitors(app, "jf.example.com")) {
      expect(m.required, `${m.type} should be required`).toBe(true);
    }
  });

  it("separates the internal URL from the public one", () => {
    const monitors = desiredMonitors(app, "jf.example.com");
    // Internal: loopback, no DNS and no Cloudflare in the path.
    expect(monitors.find((m) => m.type === "http")?.config).toMatchObject({
      url: "http://127.0.0.1:8096",
    });
    // Public: the URL a person would type. No credentials here — those come
    // from the check context, so rotating the token rewrites one row.
    expect(monitors.find((m) => m.type === "reachability")?.config).toEqual({
      url: "https://jf.example.com",
    });
  });

  it("gives the docker monitor the project and service its executor requires", () => {
    // dockerConfigSchema demands both. An empty config fails validation, and
    // since the docker monitor is required, every app's dot would read down
    // no matter how healthy the container is.
    const monitors = desiredMonitors(app, null);
    expect(monitors.find((m) => m.type === "docker")?.config).toEqual({
      projectSlug: "media",
      service: "jellyfin",
    });
  });
});

describe("planReconcile", () => {
  const d = (type: MonitorType, extra: Record<string, unknown> = {}) => ({
    targetId: "media:jellyfin",
    type,
    config: extra,
    required: true,
  });
  const e = (id: string, type: MonitorType) => ({
    id,
    targetId: "media:jellyfin",
    type,
    config: "{}",
  });

  it("creates what is missing", () => {
    const plan = planReconcile([d("docker")], []);
    expect(plan.create.map((m) => m.type)).toEqual(["docker"]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("removes a monitor whose service or port is gone", () => {
    // The failure this exists to prevent: a monitor outliving the port it watches.
    const plan = planReconcile([], [e("m1", "tcp")]);
    expect(plan.remove).toEqual(["m1"]);
  });

  it("keeps an existing monitor rather than recreating it", () => {
    // Recreating would discard its uptime history.
    const plan = planReconcile([d("docker")], [e("m1", "docker")]);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(["m1"]);
  });

  it("does not touch a monitor for a different target", () => {
    const plan = planReconcile(
      [d("docker")],
      [{ id: "other", targetId: "media:sonarr", type: "docker", config: "{}" }],
    );
    expect(plan.create.map((m) => m.type)).toEqual(["docker"]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([]);
  });

  it("updates a monitor when its config changes", () => {
    // Port moved from 8096 to 8097 — update rather than recreate.
    const plan = planReconcile(
      [d("tcp", { port: 8097 })],
      [
        {
          id: "m1",
          targetId: "media:jellyfin",
          type: "tcp",
          config: '{"port":8096}',
        },
      ],
    );
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.update).toEqual([{ id: "m1", config: { port: 8097 } }]);
    expect(plan.keep).toEqual([]);
  });

  it("keeps a monitor when config is unchanged", () => {
    const plan = planReconcile(
      [d("tcp", { port: 8096 })],
      [
        {
          id: "m1",
          targetId: "media:jellyfin",
          type: "tcp",
          config: '{"port":8096}',
        },
      ],
    );
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual(["m1"]);
  });
});

describe("desiredMonitors matches the executors' config contracts", () => {
  const app = {
    key: "media:jellyfin",
    projectSlug: "media",
    service: "jellyfin",
    hostPort: 8096,
  };

  // The seam. Each side of it was already tested in isolation: reconcile.test
  // asserted what desiredMonitors produces, checks.test exercised executors
  // against hand-written config. Nothing asserted the first satisfies the
  // second, so a tcp config with no `host` shipped and pinned every app tile
  // to "down" — not because anything was down, but because the check never
  // got as far as opening a socket.
  it.each([
    ["without a hostname", null],
    ["with a hostname", "jf.example.com"],
  ])("every monitor it emits %s parses", (_label, hostname) => {
    for (const monitor of desiredMonitors(app, hostname)) {
      const schema = configSchemas[monitor.type];
      const result = schema.safeParse(monitor.config);
      expect(
        result.success,
        `${monitor.type} config ${JSON.stringify(monitor.config)} failed: ${
          result.success ? "" : result.error.message
        }`,
      ).toBe(true);
    }
  });
});
