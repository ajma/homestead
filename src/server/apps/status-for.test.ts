import { ComposeConfigCache } from "@server/apps/compose-config";
import { currentProjectName, statusFor } from "@server/apps/status-for";
import { FakeHost } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const CONFIG = (name: string) => JSON.stringify({ name, services: { web: { image: "nginx" } } });

const row = {
  id: "a1",
  hostId: "local",
  slug: "jellyfin",
  displayName: "Jellyfin",
  directory: "jellyfin",
  composeFile: "compose.yaml",
  projectName: "jellyfin",
} as never;

function deps(configName: string) {
  const host = new FakeHost();
  host.files.set("jellyfin/compose.yaml", "services: {}\n");
  host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: CONFIG(configName),
    stderr: "",
  });
  return { host, composeConfig: new ComposeConfigCache(host) };
}

describe("currentProjectName", () => {
  it("prefers what compose resolves over the stored copy", async () => {
    // The stored copy is written at adoption. An SSH edit to `.env` setting
    // COMPOSE_PROJECT_NAME makes it wrong, and every container lookup then matches
    // nothing — a running stack reads as down with all services missing.
    expect(await currentProjectName(deps("media"), row)).toBe("media");
  });

  it("falls back to the stored copy when compose cannot be resolved", async () => {
    const d = deps("media");
    d.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "broken",
    });
    expect(await currentProjectName(d, row)).toBe("jellyfin");
  });

  it("falls back when the compose file cannot be read at all", async () => {
    const d = deps("media");
    d.host.readTextFileErrors.set("jellyfin/compose.yaml", new Error("ENOENT"));
    expect(await currentProjectName(d, row)).toBe("jellyfin");
  });
});

describe("statusFor", () => {
  it("finds containers under the resolved name, not the stored one", async () => {
    const d = deps("media");
    d.host.containers = [
      {
        id: "c1",
        names: ["media-web-1"],
        image: "nginx",
        state: "running",
        status: "Up 2 hours",
        project: "media",
        service: "web",
        labels: {},
      },
    ];
    // With the stored name the query matches nothing and this reads "down, 1 missing".
    expect(await statusFor(d, row)).toEqual({ status: "up", detail: "1/1 services up" });
  });

  it("keeps raw compose stderr out of the viewer-facing field", async () => {
    const d = deps("media");
    d.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "/volume2/docker/jellyfin/.env: bad value sk-live-9",
    });
    const result = await statusFor(d, row);
    expect(result.detail).toBe("compose configuration is invalid");
    expect(result.adminDetail).toContain("sk-live-9");
  });

  it("uses a supplied container list without asking Docker", async () => {
    const d = deps("media");
    const before = d.host.listContainersCalls;
    await statusFor(d, row, []);
    expect(d.host.listContainersCalls).toBe(before);
  });
});
