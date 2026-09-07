import type { MonitorType } from "@shared/monitoring.js";
import { describe, expect, it } from "vitest";
import { desiredMonitors, planReconcile } from "./reconcile.js";

describe("desiredMonitors", () => {
  const app = {
    key: "media:jellyfin",
    projectSlug: "media",
    service: "jellyfin",
    hostPort: 8096,
  };

  it("provisions three monitors for an unpublished app", () => {
    // DNS and reachability need a hostname to be about.
    const types = desiredMonitors(app, null)
      .map((m) => m.type)
      .sort();
    expect(types).toEqual(["docker", "http", "tcp"]);
  });

  it("adds dns and reachability once a hostname exists", () => {
    const types = desiredMonitors(app, "jf.example.com")
      .map((m) => m.type)
      .sort();
    expect(types).toEqual(["dns", "docker", "http", "reachability", "tcp"]);
  });

  it("marks reachability advisory and the rest required", () => {
    // A Cloudflare outage must not turn every published tile red.
    const monitors = desiredMonitors(app, "jf.example.com");
    const reach = monitors.find((m) => m.type === "reachability");
    expect(reach?.required).toBe(false);
    for (const m of monitors.filter((m) => m.type !== "reachability")) {
      expect(m.required, `${m.type} should be required`).toBe(true);
    }
  });

  it("points the local checks at the published port", () => {
    const monitors = desiredMonitors(app, null);
    expect(monitors.find((m) => m.type === "tcp")?.config).toMatchObject({
      port: 8096,
    });
    expect(monitors.find((m) => m.type === "http")?.config).toMatchObject({
      url: "http://127.0.0.1:8096",
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
