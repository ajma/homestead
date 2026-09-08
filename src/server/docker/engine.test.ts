import { describe, expect, it, vi } from "vitest";
import { listContainers } from "./engine.js";
import type { Runner } from "./run.js";

const runner = (stdout: string, code = 0): Runner =>
  vi.fn(async () => ({ stdout, stderr: "", code }));

describe("listContainers", () => {
  it("asks the daemon for every container, not just this project's", async () => {
    // Adoption has to see a cloudflared someone started by hand, outside
    // $HOMESTEAD_PROJECTS. `docker compose ps` is scoped to one stack and
    // cannot answer that, which is why this exists rather than reusing it.
    const run = runner("");
    await listContainers(run);
    const args = (run as unknown as { mock: { calls: string[][][] } }).mock
      .calls[0]?.[0] as unknown as string[];
    expect(args[0]).toBe("ps");
    expect(args).toContain("--format");
  });

  it("parses id and image from each line", async () => {
    const run = runner(
      "abc123\tcloudflare/cloudflared:latest\ndef456\tnginx:alpine\n",
    );
    await expect(listContainers(run)).resolves.toEqual([
      { id: "abc123", image: "cloudflare/cloudflared:latest" },
      { id: "def456", image: "nginx:alpine" },
    ]);
  });

  it("returns nothing when no container is running", async () => {
    await expect(listContainers(runner("\n"))).resolves.toEqual([]);
  });

  it("skips a malformed line rather than inventing a container", async () => {
    // A container with no image would match nothing and adopt nothing, but an
    // entry with an empty id could be handed to a later docker command.
    const run = runner("abc123\tnginx\ngarbage-with-no-tab\n\t\n");
    await expect(listContainers(run)).resolves.toEqual([
      { id: "abc123", image: "nginx" },
    ]);
  });

  it("reports no containers rather than throwing when docker is unreachable", async () => {
    // Homestead must still finish setup on a box whose socket is missing —
    // the startup checks already say so loudly. Adoption simply finds nothing.
    await expect(listContainers(runner("", 1))).resolves.toEqual([]);
  });

  it("reports no containers when the runner itself rejects", async () => {
    const run: Runner = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    await expect(listContainers(run)).resolves.toEqual([]);
  });
});
