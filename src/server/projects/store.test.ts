import {
  mkdir,
  mkdtemp,
  readFile as read,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isValidSlug,
  listSnapshots,
  projectPath,
  readProjectFile,
  SNAPSHOT_RETENTION,
  scanProjects,
  writeProjectFile,
} from "./store.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-store-"));
  await mkdir(join(root, "jellyfin"), { recursive: true });
  await writeFile(
    join(root, "jellyfin", "docker-compose.yml"),
    "services: {}\n",
  );
  await writeFile(join(root, "jellyfin", ".env"), "TZ=UTC\n");
  await mkdir(join(root, "paperless"), { recursive: true });
  await writeFile(join(root, "paperless", "compose.yaml"), "services: {}\n");
  await mkdir(join(root, "notes"), { recursive: true }); // no compose file
  // Add directories with - and _ for sort order testing
  await mkdir(join(root, "media-stack"), { recursive: true });
  await writeFile(join(root, "media-stack", "compose.yaml"), "services: {}\n");
  await mkdir(join(root, "media_stack"), { recursive: true });
  await writeFile(join(root, "media_stack", "compose.yaml"), "services: {}\n");
  // Create a real directory for symlink test
  await mkdir(join(root, "real-project"), { recursive: true });
  await writeFile(join(root, "real-project", "compose.yaml"), "services: {}\n");
  // Create symlink to it
  await symlink(join(root, "real-project"), join(root, "symlinked-project"));
  // Create broken symlink
  await symlink(join(root, "nonexistent"), join(root, "broken-link"));
  await mkdir(join(root, ".homestacks"), { recursive: true }); // data dir living inside
  await writeFile(join(root, ".homestacks", "compose.yaml"), "services: {}\n");
  await writeFile(join(root, "loose-file.txt"), "x");
});

describe("scanProjects", () => {
  it("finds projects and reports which files they have", async () => {
    const entries = await scanProjects(root);
    const jellyfin = entries.find((e) => e.slug === "jellyfin");
    expect(jellyfin).toMatchObject({
      hasCompose: true,
      hasEnv: true,
      composeFile: "docker-compose.yml",
    });
  });

  it("recognises the compose.yaml filename too", async () => {
    const entries = await scanProjects(root);
    expect(entries.find((e) => e.slug === "paperless")?.composeFile).toBe(
      "compose.yaml",
    );
  });

  it("lists a directory with no compose file rather than hiding it", async () => {
    const entries = await scanProjects(root);
    expect(entries.find((e) => e.slug === "notes")).toMatchObject({
      hasCompose: false,
      composeFile: null,
    });
  });

  it("ignores dot-directories so a nested data dir is not adopted", async () => {
    const entries = await scanProjects(root);
    expect(entries.map((e) => e.slug)).not.toContain(".homestacks");
  });

  it("ignores plain files at the root", async () => {
    const entries = await scanProjects(root);
    expect(entries.map((e) => e.slug)).not.toContain("loose-file.txt");
  });

  it("returns entries sorted by slug", async () => {
    const slugs = (await scanProjects(root)).map((e) => e.slug);
    expect(slugs).toEqual([...slugs].sort());
  });

  it("returns an empty list when the root does not exist", async () => {
    expect(await scanProjects(join(root, "nope"))).toEqual([]);
  });

  it("includes symlinked directories containing a compose file", async () => {
    const entries = await scanProjects(root);
    expect(entries.map((e) => e.slug)).toContain("symlinked-project");
    const symlinked = entries.find((e) => e.slug === "symlinked-project");
    expect(symlinked).toMatchObject({
      hasCompose: true,
      composeFile: "compose.yaml",
    });
  });

  it("skips broken symlinks without throwing", async () => {
    const entries = await scanProjects(root);
    expect(entries.map((e) => e.slug)).not.toContain("broken-link");
  });

  it("sorts with code-unit order for consistent ordering", async () => {
    const entries = await scanProjects(root);
    const slugs = entries.map((e) => e.slug);
    // media-stack should come before media_stack in code-unit order
    const dashIdx = slugs.indexOf("media-stack");
    const underIdx = slugs.indexOf("media_stack");
    expect(dashIdx).toBeLessThan(underIdx);
  });
});

describe("readProjectFile", () => {
  it("reads the compose file", async () => {
    expect(await readProjectFile(root, "jellyfin", "compose")).toBe(
      "services: {}\n",
    );
  });

  it("returns null for a missing .env rather than throwing", async () => {
    expect(await readProjectFile(root, "paperless", "env")).toBeNull();
  });
});

describe("slug safety", () => {
  it("accepts ordinary slugs", () => {
    expect(isValidSlug("jellyfin")).toBe(true);
    expect(isValidSlug("media-stack_2")).toBe(true);
  });

  it("rejects traversal and separators", () => {
    for (const bad of ["..", "a/b", "/abs", ".hidden", "", "a b", "a\\b"]) {
      expect(isValidSlug(bad)).toBe(false);
    }
  });

  it("projectPath throws rather than escaping the root", () => {
    expect(() => projectPath(root, "../etc")).toThrow();
  });
});

describe("writeProjectFile", () => {
  it("writes the new content", async () => {
    await writeProjectFile(
      root,
      "jellyfin",
      "compose",
      "services:\n  web: {}\n",
    );
    expect(
      await read(join(root, "jellyfin", "docker-compose.yml"), "utf8"),
    ).toBe("services:\n  web: {}\n");
  });

  it("snapshots the previous content before overwriting", async () => {
    await writeProjectFile(root, "jellyfin", "compose", "v2\n");
    const snaps = await listSnapshots(root, "jellyfin");
    expect(snaps).toHaveLength(1);
    expect(
      await read(join(root, "jellyfin", ".snapshots", snaps[0]!), "utf8"),
    ).toBe("services: {}\n");
  });

  it("does not snapshot when there was no previous file", async () => {
    await writeProjectFile(root, "paperless", "env", "TZ=UTC\n");
    expect(await listSnapshots(root, "paperless")).toHaveLength(0);
  });

  it("writes into the existing compose filename rather than creating a second one", async () => {
    await writeProjectFile(
      root,
      "paperless",
      "compose",
      "services:\n  a: {}\n",
    );
    const entries = await scanProjects(root);
    expect(entries.find((e) => e.slug === "paperless")?.composeFile).toBe(
      "compose.yaml",
    );
  });

  it("prunes snapshots beyond the retention limit, keeping the newest", async () => {
    for (let i = 0; i < SNAPSHOT_RETENTION + 5; i++) {
      await writeProjectFile(root, "jellyfin", "compose", `rev-${i}\n`);
    }
    const snaps = await listSnapshots(root, "jellyfin");
    expect(snaps).toHaveLength(SNAPSHOT_RETENTION);
    const newest = await read(
      join(root, "jellyfin", ".snapshots", snaps[0]!),
      "utf8",
    );
    expect(newest).toBe(`rev-${SNAPSHOT_RETENTION + 3}\n`);
  });

  it("leaves no temp files behind", async () => {
    await writeProjectFile(root, "jellyfin", "compose", "x\n");
    const names = await readdir(join(root, "jellyfin"));
    expect(names.filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});
