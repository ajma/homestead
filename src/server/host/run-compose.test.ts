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
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).services.web.image).toBe("nginx:alpine");
  });

  it("exits non-zero with a usable message for an invalid project", async () => {
    const result = await host.runCompose({ directory: "bad", composeFile: "compose.yaml" }, [
      "config",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ghost");
  });

  it("streams output when a callback is supplied", async () => {
    const chunks: string[] = [];
    await host.runCompose({ directory: "good", composeFile: "compose.yaml" }, ["config"], {
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join("")).toContain("nginx:alpine");
  });

  it("survives an onOutput callback that throws, without killing the process", async () => {
    // Measured before this guard existed: the throw escaped as an uncaughtException
    // while the promise still resolved with exitCode 0 and the full output — so a
    // caller saw success while the process died. Phase 1B-ii passes an SSE writer
    // here, and a disconnected client is ordinary, not exceptional.
    const seen: string[] = [];
    process.once("uncaughtException", (error) => seen.push(String(error.message)));

    const result = await host.runCompose(
      { directory: "good", composeFile: "compose.yaml" },
      ["config", "--format", "json"],
      {
        onOutput: () => {
          throw new Error("SSE client disconnected");
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual([]);
    // Capture must continue despite the failing consumer.
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).services.web.image).toBe("nginx:alpine");
  });

  it("refuses a directory outside the compose root", async () => {
    await expect(
      host.runCompose({ directory: "../escape", composeFile: "compose.yaml" }, ["config"]),
    ).rejects.toThrow();
  });

  it("passes arguments as an array, so shell metacharacters are inert", async () => {
    // If args were concatenated into a shell string this would execute `id`.
    const result = await host.runCompose({ directory: "good", composeFile: "compose.yaml" }, [
      "config",
      "--format",
      "json; id",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toMatch(/uid=\d+/);
  });
});
