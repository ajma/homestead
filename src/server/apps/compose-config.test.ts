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

  it.each([
    ["malformed JSON", '{"incomplete'],
    ["empty output", ""],
    ["JSON that is not an object", '"just a string"'],
    ["services reported as a string", '{"name":"a","services":"nope"}'],
    ["a null service entry", '{"name":"a","services":{"web":null}}'],
  ])("returns a failure rather than throwing for %s", async (_label, stdout) => {
    // Every one of these was measured against an earlier version: the first three threw
    // SyntaxError, the null service threw TypeError, and `"services":"nope"` returned
    // valid:true carrying four bogus services because Object.entries enumerates a
    // string's characters. A non-object service must FAIL rather than be filtered —
    // dropping it would shrink the expected set the status rollup checks against.
    const cache = new ComposeConfigCache(hostWith(stdout));
    const result = await cache.resolve(target);
    expect(result.valid).toBe(false);
  });

  it("drops port shapes Number() cannot read, keeping the rest", async () => {
    // "8080-8090" and "127.0.0.1:9000" are legal compose and both yield NaN. Ports are
    // advisory (launch-URL suggestions), so they are dropped rather than failing.
    const ports = JSON.stringify({
      name: "a",
      services: {
        web: {
          image: "x",
          ports: [
            { published: "8080-8090" },
            { published: "127.0.0.1:9000" },
            { published: "7000" },
          ],
        },
      },
    });
    const result = await new ComposeConfigCache(hostWith(ports)).resolve(target);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.resolved.services[0]?.publishedPorts).toEqual([7000]);
  });

  it("does not confuse two targets whose concatenated paths are identical", async () => {
    const host = new FakeHost();
    host.files.set("foo/bar/compose.yaml", "A");
    host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: '{"name":"A","services":{}}',
      stderr: "",
    });
    const cache = new ComposeConfigCache(host);
    await cache.resolve({ directory: "foo", composeFile: "bar/compose.yaml" });
    await cache.resolve({ directory: "foo/bar", composeFile: "compose.yaml" });
    // One call would mean the second target read the first's cached entry.
    expect(host.composeCalls).toHaveLength(2);
  });

  it("does not treat an unreadable .env as an absent one", async () => {
    // Cache once with no .env at all, then make a read fail for a different reason.
    // A shared 'absent' marker would collide here and serve the stale valid result,
    // even though the CLI — which reads .env itself — would now fail.
    const host = hostWith(configJson);
    const cache = new ComposeConfigCache(host);
    await cache.resolve(target);
    host.readTextFileErrors.set("jellyfin/.env", new Error("EACCES: permission denied"));
    await cache.resolve(target);
    expect(host.composeCalls).toHaveLength(2);
  });

  it("re-runs the CLI when only the sibling .env changed", async () => {
    const host = hostWith(configJson);
    host.files.set("jellyfin/.env", "COMPOSE_PROJECT_NAME=one\n");
    const cache = new ComposeConfigCache(host);
    await cache.resolve(target);
    host.files.set("jellyfin/.env", "COMPOSE_PROJECT_NAME=two\n");
    await cache.resolve(target);
    // compose.yaml is untouched, but the CLI resolves the project name from .env.
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

  it("re-runs the CLI when an override file changes", async () => {
    // Compose reads compose.override.yaml automatically. Editing one over SSH changes
    // the resolved services without touching the base file, so the override must be part
    // of inputHash or a stale service set is served.
    const host = hostWith(configJson);
    host.files.set("jellyfin/compose.override.yaml", "services:\n  db:\n    image: postgres\n");
    const cache = new ComposeConfigCache(host);
    await cache.resolve(target);
    host.files.set("jellyfin/compose.override.yaml", "services:\n  db:\n    image: mysql\n");
    await cache.resolve(target);
    // The base compose.yaml is untouched, but the override changed.
    expect(host.composeCalls).toHaveLength(2);
  });
});
