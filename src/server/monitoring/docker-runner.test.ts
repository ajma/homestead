import { ComposeConfigCache } from "@server/apps/compose-config";
import type { ContainerSummary } from "@server/host/types";
import { dockerRunner } from "@server/monitoring/docker-runner";
import { FakeHost } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const CONFIG = JSON.stringify({
  name: "jellyfin",
  services: { web: { image: "nginx" }, db: { image: "postgres" } },
});

const app = {
  id: "a1",
  hostId: "local",
  slug: "jellyfin",
  displayName: "Jellyfin",
  directory: "jellyfin",
  composeFile: "compose.yaml",
  projectName: "jellyfin",
} as never;

const probe = { id: "p1", appId: "a1", kind: "docker" } as never;

const container = (service: string, state: string, project = "jellyfin"): ContainerSummary => ({
  id: `${project}-${service}`,
  names: [`${project}-${service}-1`],
  image: "x",
  state,
  status: state === "running" ? "Up 2 hours" : "Exited (1)",
  project,
  service,
  labels: {},
});

function ctx(containers: ContainerSummary[] | null) {
  const host = new FakeHost();
  host.files.set("jellyfin/compose.yaml", "services: {}\n");
  host.composeResults.set("config --format json", { exitCode: 0, stdout: CONFIG, stderr: "" });
  return { app, containers, deps: { host, composeConfig: new ComposeConfigCache(host) } };
}

describe("dockerRunner", () => {
  it("is up when every expected service is running", async () => {
    const result = await dockerRunner.run(
      probe,
      ctx([container("web", "running"), container("db", "running")]),
    );
    expect(result.status).toBe("up");
    expect(result.faultClass).toBeUndefined();
    expect(result.detail?.summary).toBe("2/2 services up");
  });

  it("is down with an app fault when a service is missing", async () => {
    const result = await dockerRunner.run(probe, ctx([container("web", "running")]));
    expect(result).toMatchObject({ status: "down", faultClass: "app" });
  });

  it("filters the shared snapshot by project, ignoring other apps", async () => {
    // The snapshot is every container on the host. Counting another project's would make
    // an unrelated app's health change this one's.
    const result = await dockerRunner.run(
      probe,
      ctx([
        container("web", "running"),
        container("db", "running"),
        container("web", "exited", "paperless"),
      ]),
    );
    expect(result.status).toBe("up");
  });

  it("reports config, not app, when the compose file will not resolve", async () => {
    const c = ctx([]);
    c.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "bad yaml",
    });
    expect(await dockerRunner.run(probe, c)).toMatchObject({
      status: "down",
      faultClass: "config",
    });
  });

  it("reports network, not app, when the snapshot is unavailable", async () => {
    // `null` means the Engine API call failed. Reporting that as an app fault blames the
    // user's stack for a broken Docker socket.
    expect(await dockerRunner.run(probe, ctx(null))).toMatchObject({
      status: "down",
      faultClass: "network",
    });
  });

  it("keeps raw compose stderr out of the detail payload", async () => {
    const c = ctx([]);
    c.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "/volume2/docker/jellyfin/.env: sk-live-9",
    });
    const result = await dockerRunner.run(probe, c);
    expect(JSON.stringify(result.detail)).not.toContain("sk-live-9");
  });
});
