import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent, LocalHost } from "@server/host/local-host";
import { HashMismatchError } from "@server/host/types";
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

let root: string;
let host: LocalHost;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-host-"));
  await mkdir(join(root, "jellyfin"), { recursive: true });
  await writeFile(join(root, "jellyfin", "compose.yaml"), "services:\n  web:\n    image: alpine\n");
  await mkdir(join(root, "immich"), { recursive: true });
  await writeFile(join(root, "immich", "docker-compose.yml"), "services: {}\n");
  await mkdir(join(root, "not-an-app"), { recursive: true });
  await writeFile(join(root, "loose-file.txt"), "ignored");
  host = new LocalHost("local", root, "/var/run/docker.sock");
  await host.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalHost filesystem", () => {
  it("discovers only directories containing a compose file", async () => {
    const dirs = await host.listAppDirectories();
    expect(dirs.map((d) => d.directory).sort()).toEqual(["immich", "jellyfin"]);
  });

  it("reports which compose filename each directory uses", async () => {
    const dirs = await host.listAppDirectories();
    expect(dirs.find((d) => d.directory === "immich")?.composeFile).toBe("docker-compose.yml");
    expect(dirs.find((d) => d.directory === "jellyfin")?.composeFile).toBe("compose.yaml");
  });

  it("reads a file with its hash", async () => {
    const { content, hash } = await host.readTextFile("jellyfin/compose.yaml");
    expect(content).toContain("image: alpine");
    expect(hash).toBe(hashContent(content));
  });

  it("writes when the expected hash matches", async () => {
    const { hash } = await host.readTextFile("jellyfin/compose.yaml");
    await host.writeTextFile("jellyfin/compose.yaml", "services: {}\n", hash);
    expect(await readFile(join(root, "jellyfin", "compose.yaml"), "utf8")).toBe("services: {}\n");
  });

  it("refuses to write when the file changed on disk", async () => {
    const { hash } = await host.readTextFile("jellyfin/compose.yaml");
    await writeFile(join(root, "jellyfin", "compose.yaml"), "changed by ssh\n");
    await expect(
      host.writeTextFile("jellyfin/compose.yaml", "services: {}\n", hash),
    ).rejects.toBeInstanceOf(HashMismatchError);
  });

  it("creates a new file when the expected hash is null", async () => {
    const { hash } = await host.writeTextFile("jellyfin/.env", "PUID=1000\n", null);
    expect(hash).toBe(hashContent("PUID=1000\n"));
  });

  it("refuses to overwrite an existing file when the expected hash is null", async () => {
    await expect(host.writeTextFile("jellyfin/compose.yaml", "x", null)).rejects.toBeInstanceOf(
      HashMismatchError,
    );
  });

  it("rejects a path outside the root", async () => {
    await expect(host.readTextFile("../escape.txt")).rejects.toThrow();
  });

  it("creates new files owner-only, because .env holds secrets", async () => {
    await host.writeTextFile("jellyfin/.env", "DB_PASSWORD=hunter2\n", null);
    const { mode } = await stat(join(root, "jellyfin", ".env"));
    expect(mode & 0o777).toBe(0o600);
  });

  it("preserves the existing mode instead of resetting it to the umask", async () => {
    const target = join(root, "jellyfin", "locked.env");
    await writeFile(target, "API_KEY=abc\n");
    await chmod(target, 0o600);

    const { hash } = await host.readTextFile("jellyfin/locked.env");
    await host.writeTextFile("jellyfin/locked.env", "API_KEY=xyz\n", hash);

    const { mode } = await stat(target);
    expect(mode & 0o777).toBe(0o600); // Was silently becoming 0644 before this guard.
  });

  it("leaves no temp files behind", async () => {
    await host.writeTextFile("jellyfin/compose.yaml", "services: {}\n", null).catch(() => {});
    const entries = await readdir(join(root, "jellyfin"));
    expect(entries.filter((e) => e.includes(".tmp"))).toHaveLength(0);
  });
});

describe.skipIf(!(await dockerAvailable()))("LocalHost docker reads", () => {
  it("lists containers and surfaces compose labels", async () => {
    const containers = await host.listContainers();
    expect(Array.isArray(containers)).toBe(true);
    for (const c of containers) {
      expect(typeof c.id).toBe("string");
      expect(c.project === null || typeof c.project === "string").toBe(true);
    }
  });

  it("filters by compose project without error", async () => {
    await expect(
      host.listContainers({ project: "definitely-not-a-real-project" }),
    ).resolves.toEqual([]);
  });
});
