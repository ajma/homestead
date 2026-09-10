import { ComposeConfigCache } from "@server/apps/compose-config";
import { FakeHost } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const target = { directory: "jellyfin", composeFile: "compose.yaml" };

const configJson = JSON.stringify({
  name: "jellyfin",
  services: {
    web: { image: "jellyfin/jellyfin:latest", ports: [{ published: "8096", target: 8096 }] },
    init: { image: "alpine", restart: "no" },
  },
});

function hostWith(stdout: string, exitCode = 0, stderr = "") {
  const host = new FakeHost();
  host.files.set("jellyfin/compose.yaml", "services: {}\n");
  host.composeResults.set("config --format json", { exitCode, stdout, stderr });
  return host;
}

describe("ComposeConfigCache", () => {
  it("resolves the project name and services", async () => {
    const cache = new ComposeConfigCache(hostWith(configJson));
    const result = await cache.resolve(target);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.resolved.projectName).toBe("jellyfin");
    expect(result.resolved.services.map((s) => s.name).sort()).toEqual(["init", "web"]);
    expect(result.resolved.services.find((s) => s.name === "web")?.publishedPorts).toEqual([8096]);
    expect(result.resolved.services.find((s) => s.name === "init")?.restart).toBe("no");
  });

  it("reports a validation failure with the CLI message", async () => {
    const cache = new ComposeConfigCache(
      hostWith(
        "",
        1,
        'service "web" depends on undefined service "ghost": invalid compose project',
      ),
    );
    const result = await cache.resolve(target);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.message).toContain("ghost");
  });

  it("does not re-run the CLI while the file hash is unchanged", async () => {
    const host = hostWith(configJson);
    const cache = new ComposeConfigCache(host);
    await cache.resolve(target);
    await cache.resolve(target);
    await cache.resolve(target);
    expect(host.composeCalls).toHaveLength(1);
  });

  it("re-runs the CLI after the file changes on disk", async () => {
    const host = hostWith(configJson);
    const cache = new ComposeConfigCache(host);
    await cache.resolve(target);
    host.files.set("jellyfin/compose.yaml", "services:\n  web:\n    image: nginx\n");
    await cache.resolve(target);
    expect(host.composeCalls).toHaveLength(2);
  });

  it("re-runs the CLI after explicit invalidation", async () => {
    const host = hostWith(configJson);
    const cache = new ComposeConfigCache(host);
    await cache.resolve(target);
    cache.invalidate(target);
    await cache.resolve(target);
    expect(host.composeCalls).toHaveLength(2);
  });

  it("does not cache a failure, so fixing the file recovers without a restart", async () => {
    const host = hostWith("", 1, "invalid compose project");
    const cache = new ComposeConfigCache(host);
    expect((await cache.resolve(target)).valid).toBe(false);
    host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: configJson,
      stderr: "",
    });
    expect((await cache.resolve(target)).valid).toBe(true);
  });
});
