import { FakeHost } from "@server/test-helpers";
import type { ContainerSummary } from "@shared/admin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectSelfDirectory } from "./self-detect";

const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: "abcdef123456abcdef123456abcdef123456abcdef123456abcdef12345678",
    names: ["homestead"],
    image: "homestead:latest",
    state: "running",
    status: "Up",
    project: "homestead",
    service: "homestead",
    labels: {},
    ...overrides,
  };
}

describe("detectSelfDirectory", () => {
  const originalHostname = process.env.HOSTNAME;

  beforeEach(() => {
    delete process.env.HOSTNAME;
  });

  afterEach(() => {
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  });

  it("finds nothing outside a container — no HOSTNAME, no guess", async () => {
    const host = new FakeHost();
    host.containers = [
      container({
        id: "abcdef123456",
        labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" },
      }),
    ];

    const result = await detectSelfDirectory({ host, composeRoot: "/volume2/docker" });
    expect(result).toBeNull();
  });

  it("finds nothing when HOSTNAME matches no known container", async () => {
    process.env.HOSTNAME = "abcdef123456";
    const host = new FakeHost();
    host.containers = [
      container({ id: "00000000000000000000000000000000000000000000000000000000000000" }),
    ];

    const result = await detectSelfDirectory({ host, composeRoot: "/volume2/docker" });
    expect(result).toBeNull();
  });

  it("matches HOSTNAME (the short id) against listContainers' full id by prefix", async () => {
    process.env.HOSTNAME = "abcdef123456";
    const host = new FakeHost();
    host.containers = [
      container({
        id: "abcdef123456abcdef123456abcdef123456abcdef123456abcdef12345678",
        labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" },
      }),
    ];

    const result = await detectSelfDirectory({ host, composeRoot: "/volume2/docker" });
    expect(result).toBe("homestead");
  });

  it("finds nothing when the matched container carries no compose working-dir label", async () => {
    // A container that is not itself a `docker compose` service — or one Docker Compose
    // labelled differently than this version stamps — must not produce a guess.
    process.env.HOSTNAME = "abcdef123456";
    const host = new FakeHost();
    host.containers = [container({ id: `abcdef123456${"0".repeat(52)}`, labels: {} })];

    const result = await detectSelfDirectory({ host, composeRoot: "/volume2/docker" });
    expect(result).toBeNull();
  });

  it("finds nothing when the working directory IS the compose root itself", async () => {
    process.env.HOSTNAME = "abcdef123456";
    const host = new FakeHost();
    host.containers = [
      container({
        id: `abcdef123456${"0".repeat(52)}`,
        labels: { [WORKING_DIR_LABEL]: "/volume2/docker" },
      }),
    ];

    const result = await detectSelfDirectory({ host, composeRoot: "/volume2/docker" });
    expect(result).toBeNull();
  });

  it("finds nothing when the working directory sits outside the compose root", async () => {
    process.env.HOSTNAME = "abcdef123456";
    const host = new FakeHost();
    host.containers = [
      container({
        id: `abcdef123456${"0".repeat(52)}`,
        labels: { [WORKING_DIR_LABEL]: "/some/other/place/homestead" },
      }),
    ];

    const result = await detectSelfDirectory({ host, composeRoot: "/volume2/docker" });
    expect(result).toBeNull();
  });

  it("resolves a nested directory relative to the compose root", async () => {
    process.env.HOSTNAME = "abcdef123456";
    const host = new FakeHost();
    host.containers = [
      container({
        id: `abcdef123456${"0".repeat(52)}`,
        labels: { [WORKING_DIR_LABEL]: "/volume2/docker/infra/homestead" },
      }),
    ];

    const result = await detectSelfDirectory({ host, composeRoot: "/volume2/docker" });
    expect(result).toBe("infra/homestead");
  });
});
