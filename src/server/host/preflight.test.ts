import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMountPreflight } from "@server/host/preflight";
import Docker from "dockerode";
import { describe, expect, it } from "vitest";

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker({ socketPath: "/var/run/docker.sock" }).ping();
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("runMountPreflight", () => {
  it("passes when the compose root is visible to the daemon at the same path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hs-preflight-"));
    try {
      const result = await runMountPreflight({
        composeRoot: root,
        dockerSocket: "/var/run/docker.sock",
      });
      expect(result).toEqual({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails when the configured path is not the one the daemon sees", async () => {
    const result = await runMountPreflight({
      composeRoot: "/definitely/not/mounted/anywhere",
      dockerSocket: "/var/run/docker.sock",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/marker/i);
  }, 60_000);
});
