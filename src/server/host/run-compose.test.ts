import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHost } from "@server/host/local-host";
import Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker({ socketPath: "/var/run/docker.sock" }).ping();
    return true;
  } catch {
    return false;
  }
}
const hasDocker = await dockerAvailable();

let root: string;
let host: LocalHost;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-compose-"));
  await mkdir(join(root, "good"), { recursive: true });
  await writeFile(
    join(root, "good", "compose.yaml"),
    "services:\n  web:\n    image: nginx:alpine\n",
  );
  await mkdir(join(root, "bad"), { recursive: true });
  await writeFile(
    join(root, "bad", "compose.yaml"),
    "services:\n  web:\n    image: nginx\n    depends_on: [ghost]\n",
  );
  host = new LocalHost("local", root, "/var/run/docker.sock");
  await host.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!hasDocker)("runCompose", () => {
  it("exits 0 and returns stdout for a valid project", async () => {
    const result = await host.runCompose({ directory: "good", composeFile: "compose.yaml" }, [
      "config",
      "--format",
      "json",
    ]).result;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).services.web.image).toBe("nginx:alpine");
  });

  it("exits non-zero with a usable message for an invalid project", async () => {
    const result = await host.runCompose({ directory: "bad", composeFile: "compose.yaml" }, [
      "config",
    ]).result;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ghost");
  });

  it("streams output as the process runs", async () => {
    const chunks: string[] = [];
    const handle = host.runCompose({ directory: "good", composeFile: "compose.yaml" }, ["config"]);
    for await (const chunk of handle.output) chunks.push(chunk.text);
    expect(chunks.join("")).toContain("nginx:alpine");
  });

  it("refuses a directory outside the compose root", async () => {
    const result = await host.runCompose({ directory: "../escape", composeFile: "compose.yaml" }, [
      "config",
    ]).result;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("escape");
  });

  it("passes arguments as an array, so shell metacharacters are inert", async () => {
    // If args were concatenated into a shell string this would execute `id`.
    const result = await host.runCompose({ directory: "good", composeFile: "compose.yaml" }, [
      "config",
      "--format",
      "json; id",
    ]).result;
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toMatch(/uid=\d+/);
  });

  it.skipIf(!hasDocker)("streams output before the process exits", async () => {
    const handle = host.runCompose({ directory: "good", composeFile: "compose.yaml" }, [
      "config",
      "--format",
      "json",
    ]);
    const chunks: string[] = [];
    for await (const chunk of handle.output) chunks.push(chunk.text);
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    // The point of the handle: output was observable as an iterable, not only at the end.
    expect(chunks.join("")).toContain("services");
  });

  it.skipIf(!hasDocker)("settles result even when nobody reads output", async () => {
    const result = await host.runCompose({ directory: "good", composeFile: "compose.yaml" }, [
      "config",
      "--format",
      "json",
    ]).result;
    expect(result.exitCode).toBe(0);
  });
});

describe("runCompose without Docker", () => {
  it("settles result when the compose path does not resolve", async () => {
    // No Docker needed: the path guard rejects before anything spawns. Without the
    // `.catch` on the async IIFE this hangs forever instead of resolving.
    const result = await host.runCompose({ directory: "nope", composeFile: "compose.yaml" }, [
      "config",
    ]).result;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toBe("");
  });
});
