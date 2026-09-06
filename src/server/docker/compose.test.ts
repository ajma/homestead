import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeArgs,
  composeExec,
  composeLogs,
  composePs,
  ensureOverride,
  validateComposeVerb,
} from "./compose.js";
import { createFakeDocker } from "./fake.js";
import type { Runner } from "./run.js";

const CTX = {
  projectsDir: "/data/stacks",
  projectsHostDir: "/data/stacks",
  dataDir: "/var/lib/homestead",
  slug: "media",
};

describe("composeArgs", () => {
  it("passes the compose file and no override when translation is inactive", () => {
    expect(composeArgs(CTX, "docker-compose.yml", null, ["up", "-d"])).toEqual([
      "compose",
      "-f",
      "/data/stacks/media/docker-compose.yml",
      "up",
      "-d",
    ]);
  });

  it("appends the override as a second -f, after the base file", () => {
    const args = composeArgs(
      CTX,
      "docker-compose.yml",
      "/var/lib/homestead/run/media.override.yml",
      ["up", "-d"],
    );
    expect(args.slice(0, 5)).toEqual([
      "compose",
      "-f",
      "/data/stacks/media/docker-compose.yml",
      "-f",
      "/var/lib/homestead/run/media.override.yml",
    ]);
  });

  it("honours a compose.yaml filename rather than assuming docker-compose.yml", () => {
    expect(composeArgs(CTX, "compose.yaml", null, ["ps"])).toContain(
      "/data/stacks/media/compose.yaml",
    );
  });

  it("never emits -v on down", () => {
    expect(
      composeArgs(CTX, "docker-compose.yml", null, ["down"]),
    ).not.toContain("-v");
  });
});

describe("validateComposeVerb", () => {
  describe("allows safe down operations", () => {
    it("allows down with no args", () => {
      expect(() => validateComposeVerb(["down"])).not.toThrow();
    });

    it("allows down with --remove-orphans", () => {
      expect(() =>
        validateComposeVerb(["down", "--remove-orphans"]),
      ).not.toThrow();
    });

    it("allows down with -t and timeout value", () => {
      expect(() => validateComposeVerb(["down", "-t", "30"])).not.toThrow();
    });

    it("allows down with --timeout and value", () => {
      expect(() =>
        validateComposeVerb(["down", "--timeout", "30"]),
      ).not.toThrow();
    });

    it("allows down with --timeout and zero", () => {
      expect(() =>
        validateComposeVerb(["down", "--timeout", "0"]),
      ).not.toThrow();
    });
  });

  describe("rejects dangerous down operations", () => {
    it("rejects down with -v", () => {
      expect(() => validateComposeVerb(["down", "-v"])).toThrow(
        /volume removal/,
      );
    });

    it("rejects down with --volumes", () => {
      expect(() => validateComposeVerb(["down", "--volumes"])).toThrow(
        /volume removal/,
      );
    });

    it("rejects down with stacked -fv", () => {
      expect(() => validateComposeVerb(["down", "-fv"])).toThrow(/-fv/);
    });

    it("rejects down with stacked -vf", () => {
      expect(() => validateComposeVerb(["down", "-vf"])).toThrow(/-vf/);
    });

    it("rejects down with --rmi and -v", () => {
      // --rmi is encountered first, so that's what gets rejected
      expect(() => validateComposeVerb(["down", "--rmi", "all", "-v"])).toThrow(
        /--rmi/,
      );
    });

    it("rejects down with unknown flag", () => {
      expect(() => validateComposeVerb(["down", "--nuke"])).toThrow(/--nuke/);
    });

    it("rejects down with -t followed by -v", () => {
      expect(() => validateComposeVerb(["down", "-t", "-v"])).toThrow(/-v/);
    });

    it("rejects down with --timeout followed by --volumes", () => {
      expect(() =>
        validateComposeVerb(["down", "--timeout", "--volumes"]),
      ).toThrow(/--volumes/);
    });

    it("rejects down with -t and no value", () => {
      expect(() => validateComposeVerb(["down", "-t"])).toThrow(/-t/);
    });

    it("rejects down with -t and non-numeric value", () => {
      expect(() => validateComposeVerb(["down", "-t", "abc"])).toThrow(/abc/);
    });
  });

  it("allows non-down verbs through", () => {
    expect(() => validateComposeVerb(["up", "-d"])).not.toThrow();
    expect(() => validateComposeVerb(["ps"])).not.toThrow();
    expect(() => validateComposeVerb(["logs", "-f"])).not.toThrow();
  });
});

describe("composePs", () => {
  it("returns valid containers when output contains malformed lines", async () => {
    const mockRun: Runner = async () => ({
      stdout: [
        '{"Service":"web","Name":"proj-web-1","State":"running","Health":"","ExitCode":0}',
        "WARNING: this is not JSON",
        '{"Service":"db","Name":"proj-db-1","State":"running","Health":"healthy","ExitCode":0}',
      ].join("\n"),
      stderr: "",
      code: 0,
    });

    const states = await composePs(CTX, mockRun);
    expect(states).toHaveLength(2);
    expect(states[0]?.service).toBe("web");
    expect(states[1]?.service).toBe("db");
    expect(states[1]?.health).toBe("healthy");
  });
});

describe("composeExec and composeLogs", () => {
  let root: string;
  let slug: string;

  beforeEach(async () => {
    slug = "hs-test-fixture";
    root = await mkdtemp(join(tmpdir(), "hs-compose-unit-"));
    await mkdir(join(root, slug), { recursive: true });
    await writeFile(
      join(root, slug, "docker-compose.yml"),
      `name: ${slug}\nservices:\n  web:\n    image: nginx\n`,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = () => ({
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
    slug,
  });

  it("streams through the injected runner rather than spawning", async () => {
    const fake = createFakeDocker({ output: ["up\n"], exitCode: 0 });
    const seen: string[] = [];
    const code = await composeExec(
      ctx(),
      ["up", "-d"],
      (c) => seen.push(c),
      fake.runner,
    );
    expect(code).toBe(0);
    expect(seen.join("")).toBe("up\n");
    expect(fake.streamed[0]?.args).toEqual([
      "compose",
      "-f",
      join(root, slug, "docker-compose.yml"),
      "up",
      "-d",
    ]);
    expect(fake.streamed[0]?.cwd).toBe(join(root, slug));
  });

  it("validates the verb before reaching the runner", async () => {
    const fake = createFakeDocker();
    await expect(
      composeExec(ctx(), ["down", "-v"], () => {}, fake.runner),
    ).rejects.toThrow(/volume removal/);
    expect(fake.streamed).toEqual([]);
  });

  it("builds log argv through the same compose path", async () => {
    const fake = createFakeDocker();
    await composeLogs(
      ctx(),
      { tail: 42, service: "web" },
      () => {},
      fake.runner,
    );
    expect(fake.streamed[0]?.args).toEqual([
      "compose",
      "-f",
      join(root, slug, "docker-compose.yml"),
      "logs",
      "--follow",
      "--tail",
      "42",
      "web",
    ]);
  });

  it("omits the service when none is requested", async () => {
    const fake = createFakeDocker();
    await composeLogs(ctx(), { tail: 5 }, () => {}, fake.runner);
    expect(fake.streamed[0]?.args.slice(-4)).toEqual([
      "logs",
      "--follow",
      "--tail",
      "5",
    ]);
  });
});

describe("override file lifecycle", () => {
  let root: string;
  let hostRoot: string;
  const slug = "hs-test-override";

  /** A canonical config whose bind source lives under the project directory. */
  const canonicalFor = (dir: string) => ({
    name: slug,
    services: {
      web: {
        image: "nginx",
        volumes: [
          { type: "bind", source: join(dir, "config"), target: "/config" },
        ],
      },
    },
  });
  let canonical: ReturnType<typeof canonicalFor>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hs-override-"));
    hostRoot = "/host/stacks";
    await mkdir(join(root, slug), { recursive: true });
    await writeFile(
      join(root, slug, "docker-compose.yml"),
      `name: ${slug}\nservices:\n  web:\n    image: nginx\n`,
    );
    canonical = canonicalFor(join(root, slug));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = () => ({
    projectsDir: root,
    projectsHostDir: hostRoot,
    dataDir: root,
    slug,
  });

  it("gives every invocation its own override filename", async () => {
    const fake = createFakeDocker({ config: canonical });
    const a = await ensureOverride(ctx(), fake.runner.run);
    const b = await ensureOverride(ctx(), fake.runner.run);
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a).toContain(`${slug}-`);
  });

  it("leaves no tmp file and no stale override after a run", async () => {
    const fake = createFakeDocker({ config: canonical });
    await composeExec(ctx(), ["up", "-d"], () => {}, fake.runner);
    expect(await readdir(join(root, "run"))).toEqual([]);
  });

  it("deletes the override even when the run fails", async () => {
    const fake = createFakeDocker({
      config: canonical,
      stream: async () => {
        throw new Error("docker exploded");
      },
    });
    await expect(
      composeExec(ctx(), ["up", "-d"], () => {}, fake.runner),
    ).rejects.toThrow(/exploded/);
    expect(await readdir(join(root, "run"))).toEqual([]);
  });

  it("passes the override to docker as a second -f", async () => {
    const fake = createFakeDocker({ config: canonical });
    await composeExec(ctx(), ["up", "-d"], () => {}, fake.runner);
    const args = fake.streamed[0]?.args ?? [];
    expect(args.filter((a) => a === "-f")).toHaveLength(2);
    expect(args[4]).toMatch(/\.override\.yml$/);
  });
});
