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

  /** Same shape as `row`, with a `graceUntil` the tests below control directly. */
  function rowWithGrace(graceUntil: number | null) {
    return {
      id: "a1",
      hostId: "local",
      slug: "jellyfin",
      displayName: "Jellyfin",
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
      graceUntil,
    } as never;
  }

  it("reads starting, not down, while a deploy's grace window is still open", async () => {
    // Measured in the 1E final-fix brief at the same instant: `applyTransition` (the
    // probe pipeline) already says `starting` here via its own grace check; `statusFor`
    // said `down` — the disagreement this test guards against.
    const d = deps("media");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const result = await statusFor(d, rowWithGrace(nowSeconds + 120));
    expect(result).toEqual({ status: "starting", detail: "0/1 services up, 1 missing" });
  });

  it("reads down once the grace window has closed", async () => {
    const d = deps("media");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const result = await statusFor(d, rowWithGrace(nowSeconds - 1));
    expect(result).toEqual({ status: "down", detail: "0/1 services up, 1 missing" });
  });

  it("does not report starting for a stack that is actually up, just because grace is open", async () => {
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
    const nowSeconds = Math.floor(Date.now() / 1000);
    const result = await statusFor(d, rowWithGrace(nowSeconds + 120));
    expect(result.status).toBe("up");
  });

  it("does not let grace mask an unreadable compose configuration as starting", async () => {
    const d = deps("media");
    d.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "broken",
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const result = await statusFor(d, rowWithGrace(nowSeconds + 120));
    expect(result.status).toBe("unknown");
  });
});
