import { describe, expect, it } from "vitest";
import { runChecks } from "../preflight.js";
import { dockerChecks } from "./preflight.js";
import type { Runner } from "./run.js";

const fake =
  (
    map: Record<string, { stdout?: string; code?: number; throws?: string }>,
  ): Runner =>
  async (args) => {
    const key = args.join(" ");
    const hit = map[key];
    if (!hit) throw new Error(`unexpected docker invocation: ${key}`);
    if (hit.throws) throw new Error(hit.throws);
    return { stdout: hit.stdout ?? "", stderr: "", code: hit.code ?? 0 };
  };

const VERSION = "version --format {{.Server.Version}}";
const COMPOSE = "compose version --short";

describe("dockerChecks", () => {
  it("passes when the daemon answers and Compose is v2", async () => {
    const results = await runChecks(
      dockerChecks(
        fake({
          [VERSION]: { stdout: "29.7.2\n" },
          [COMPOSE]: { stdout: "2.31.0\n" },
        }),
      ),
    );
    expect(results.find((r) => r.id === "docker_reachable")?.ok).toBe(true);
    expect(results.find((r) => r.id === "compose_v2")?.ok).toBe(true);
  });

  it("reports the daemon as a failure when it cannot be reached", async () => {
    const results = await runChecks(
      dockerChecks(
        fake({
          [VERSION]: {
            throws:
              "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
          },
          [COMPOSE]: { stdout: "2.31.0\n" },
        }),
      ),
    );
    const check = results.find((r) => r.id === "docker_reachable");
    expect(check?.ok).toBe(false);
    expect(check?.severity).toBe("warning");
    expect(check?.detail).toContain("docker.sock");
  });

  it("rejects Compose v1", async () => {
    const results = await runChecks(
      dockerChecks(
        fake({
          [VERSION]: { stdout: "29.7.2\n" },
          [COMPOSE]: { stdout: "1.29.2\n" },
        }),
      ),
    );
    const check = results.find((r) => r.id === "compose_v2");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("1.29.2");
  });

  it("rejects a Compose version it cannot parse rather than assuming v2", async () => {
    const results = await runChecks(
      dockerChecks(
        fake({
          [VERSION]: { stdout: "29.7.2\n" },
          [COMPOSE]: { stdout: "wat\n" },
        }),
      ),
    );
    expect(results.find((r) => r.id === "compose_v2")?.ok).toBe(false);
  });
});
