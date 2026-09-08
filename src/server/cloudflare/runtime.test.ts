import { expect, it } from "vitest";
import { deployTunnel, detectRuntime } from "./runtime.js";

it("detects an existing cloudflared container for adoption", async () => {
  const r = await detectRuntime({
    listContainers: async () => [
      { id: "c1", image: "cloudflare/cloudflared:latest", project: "" },
    ],
  });
  expect(r).toEqual({ kind: "adopted", containerId: "c1" });
});

it("reports none when nothing is running", async () => {
  const r = await detectRuntime({
    listContainers: async () => [],
  });
  expect(r).toEqual({ kind: "none" });
});

it("does not mistake an unrelated container for cloudflared", async () => {
  const r = await detectRuntime({
    listContainers: async () => [
      { id: "c9", image: "nginx:latest", project: "" },
    ],
  });
  expect(r.kind).toBe("none");
});

it("deploys a host-network project carrying the token in .env", async () => {
  const written: Record<string, string> = {};
  const r = await deployTunnel(
    {
      listContainers: async () => [],
      writeProject: async (_s, files) => {
        Object.assign(written, files);
      },
    },
    "RUNTOKEN",
  );
  expect(r).toEqual({ kind: "deployed", projectSlug: "homestead-tunnel" });
  expect(written["compose.yaml"]).toContain("network_mode: host");
  expect(written["compose.yaml"]).toContain("x-homestead");
  expect(written[".env"]).toContain("RUNTOKEN");
});

it("keeps the run token out of the compose file", async () => {
  // compose.yaml is readable by anything that can read the projects directory
  // and is shown in the editor UI; .env is treated as a secret everywhere else.
  const written: Record<string, string> = {};
  await deployTunnel(
    {
      listContainers: async () => [],
      writeProject: async (_s, files) => {
        Object.assign(written, files);
      },
    },
    "RUNTOKEN",
  );
  expect(written["compose.yaml"]).not.toContain("RUNTOKEN");
});

it("reports our own stack as deployed, not adopted", async () => {
  // Both are "a cloudflared is running", but the setup screen says different
  // things about them, and only one is Homestead's to restart or update.
  const r = await detectRuntime({
    listContainers: async () => [
      {
        id: "c2",
        image: "cloudflare/cloudflared:latest",
        project: "homestead-tunnel",
      },
    ],
  });
  expect(r).toEqual({ kind: "deployed", projectSlug: "homestead-tunnel" });
});

it("reports none when the stack exists but nothing is running", async () => {
  // The failure this prevents: "Setup complete" while no connector is
  // attached, which is exactly the state that went unnoticed for an evening.
  // Written files are not a running daemon.
  const r = await detectRuntime({
    listContainers: async () => [],
  });
  expect(r).toEqual({ kind: "none" });
});
