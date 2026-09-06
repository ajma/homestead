import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeContext,
  composeConfig,
  composeExec,
  composePs,
} from "./compose.js";

// Real Docker. Opt in with HOMESTACKS_DOCKER_TESTS=1.
const enabled = process.env.HOMESTACKS_DOCKER_TESTS === "1";
const d = enabled ? describe : describe.skip;

let root: string;
let ctx: ComposeContext;
/**
 * Compose reconciles by project-name label, not by directory, so this name is
 * randomised: a fixed one that happened to match a real stack on the host
 * would have this suite recreate the operator's containers.
 */
const projectName = `hs-test-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  if (!enabled) return;
  root = await mkdtemp(join(tmpdir(), "hs-compose-"));
  await mkdir(join(root, "probe", "config"), { recursive: true });
  await writeFile(join(root, "probe", "config", "marker.txt"), "REAL\n");
  await writeFile(
    join(root, "probe", "docker-compose.yml"),
    [
      `name: ${projectName}`,
      "services:",
      "  app:",
      "    image: traefik/whoami",
      '    ports: ["127.0.0.1:18099:80"]',
      "    volumes:",
      "      - ./config:/config",
      "",
    ].join("\n"),
  );
  ctx = {
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
    slug: "probe",
  };
});

afterAll(async () => {
  if (!enabled) return;
  // Tear the stack down before the compose file disappears: once `root` is
  // gone there is no ordinary way to reach these containers again.
  try {
    await composeExec(ctx, ["down", "--remove-orphans"], () => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

d("compose against real Docker", () => {
  it("reads the project name from compose rather than the directory", async () => {
    const canonical = (await composeConfig(ctx)) as { name: string };
    expect(canonical.name).toBe(projectName);
  });

  it("brings the stack up and reports it running", async () => {
    const output: string[] = [];
    const code = await composeExec(ctx, ["up", "-d"], (c) => output.push(c));
    expect(code, output.join("")).toBe(0);
    const states = await composePs(ctx);
    expect(states.find((s) => s.service === "app")?.state).toBe("running");
  }, 120_000);

  it("streams output to the callback", async () => {
    const chunks: string[] = [];
    await composeExec(ctx, ["ps"], (c) => chunks.push(c));
    expect(chunks.join("")).toContain("app");
  }, 60_000);

  it("refuses `down -v`", async () => {
    await expect(composeExec(ctx, ["down", "-v"], () => {})).rejects.toThrow(
      /volume removal/,
    );
  });

  it("brings the stack down", async () => {
    expect(await composeExec(ctx, ["down"], () => {})).toBe(0);
    expect((await composePs(ctx)).filter((s) => s.state === "running")).toEqual(
      [],
    );
  }, 120_000);
});
