import { describe, expect, it } from "vitest";
import { FakeHost } from "./test-helpers.js";

describe("FakeHost.listAppDirectories", () => {
  it("excludes directories with no compose file", async () => {
    const host = new FakeHost();
    host.files.set("app-with-only-env/.env", "SECRET=foo");
    host.files.set("app-with-compose/compose.yaml", "services: {}");

    const result = await host.listAppDirectories();

    expect(result).toHaveLength(1);
    expect(result[0]?.directory).toBe("app-with-compose");
  });

  it("reports the actual compose filename found", async () => {
    const host = new FakeHost();
    host.files.set("app-a/docker-compose.yml", "services: {}");
    host.files.set("app-b/compose.yaml", "services: {}");

    const result = await host.listAppDirectories();

    const appA = result.find((d) => d.directory === "app-a");
    const appB = result.find((d) => d.directory === "app-b");
    expect(appA?.composeFile).toBe("docker-compose.yml");
    expect(appB?.composeFile).toBe("compose.yaml");
  });

  it("returns results sorted by directory name", async () => {
    const host = new FakeHost();
    host.files.set("zebra/compose.yaml", "services: {}");
    host.files.set("alpha/compose.yaml", "services: {}");
    host.files.set("middle/compose.yaml", "services: {}");

    const result = await host.listAppDirectories();

    expect(result.map((d) => d.directory)).toEqual(["alpha", "middle", "zebra"]);
  });
});
