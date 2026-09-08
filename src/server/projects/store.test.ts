import {
  mkdir,
  readFile as read,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-support/tmp.js";
import {
  createProject,
  deleteProjectDir,
  isValidSlug,
  listSnapshots,
  ProjectExistsError,
  projectPath,
  readProjectFile,
  SNAPSHOT_RETENTION,
  scanProjects,
  writeProjectFile,
  writeProjectFiles,
} from "./store.js";

let root: string;

beforeEach(async () => {
  root = await tempDir("hs-store-");
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
  await mkdir(join(root, ".homestead"), { recursive: true }); // data dir living inside
  await writeFile(join(root, ".homestead", "compose.yaml"), "services: {}\n");
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
    expect(entries.map((e) => e.slug)).not.toContain(".homestead");
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

  it("throws rather than reporting an unreadable file as absent", async () => {
    // A directory where a file is expected stands in for the NAS case: an
    // ACL'd share yields EACCES, and "not found" would send the operator
    // hunting for the wrong problem. Only ENOENT may become null.
    await mkdir(join(root, "notes", ".env"), { recursive: true });
    await expect(readProjectFile(root, "notes", "env")).rejects.toThrow();
  });
});

describe("slug safety", () => {
  it("accepts ordinary slugs", () => {
    expect(isValidSlug("jellyfin")).toBe(true);
    expect(isValidSlug("media-stack_2")).toBe(true);
  });

  it("rejects traversal and separators via isValidSlug", () => {
    for (const bad of ["..", "a/b", "/abs", ".hidden", "", "a b", "a\\b"]) {
      expect(isValidSlug(bad)).toBe(false);
    }
  });

  it("projectPath throws on relative traversal", () => {
    // Caught by isValidSlug first, but containment would catch them too
    // (verified by temporarily bypassing isValidSlug during development).
    expect(() => projectPath(root, "../etc")).toThrow();
    expect(() => projectPath(root, "../evil")).toThrow();
    expect(() => projectPath(root, "..")).toThrow();
  });

  it("projectPath throws on embedded traversal", () => {
    // a/../../x would normalize to ../x outside the root — caught by
    // isValidSlug's "/" rejection, but containment would catch it too.
    expect(() => projectPath(root, "a/../../x")).toThrow();
  });

  it("projectPath throws on absolute paths", () => {
    // Caught by isValidSlug's "/" rejection and by containment.
    expect(() => projectPath(root, "/etc")).toThrow();
    expect(() => projectPath(root, "/tmp/evil")).toThrow();
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

  it("retains snapshots per file, so editing .env cannot evict compose history", async () => {
    // The regression: retention took slice(SNAPSHOT_RETENTION) of the combined
    // listing, so a handful of password tweaks silently destroyed every
    // snapshot of the compose file — the undo this feature exists to provide.
    await writeProjectFile(root, "jellyfin", "compose", "compose-rev-1\n");
    await writeProjectFile(root, "jellyfin", "compose", "compose-rev-2\n");
    for (let i = 0; i < SNAPSHOT_RETENTION; i++) {
      await writeProjectFile(root, "jellyfin", "env", `TZ=zone-${i}\n`);
    }

    const snaps = await listSnapshots(root, "jellyfin");
    const composeSnaps = snaps.filter((n) => n.endsWith("docker-compose.yml"));
    const envSnaps = snaps.filter((n) => n.endsWith(".env"));

    expect(composeSnaps).toHaveLength(2);
    expect(envSnaps).toHaveLength(SNAPSHOT_RETENTION);
    const contents = await Promise.all(
      composeSnaps.map((n) =>
        read(join(root, "jellyfin", ".snapshots", n), "utf8"),
      ),
    );
    expect(contents.sort()).toEqual(["compose-rev-1\n", "services: {}\n"]);
  });

  it("prunes each file's own history independently", async () => {
    for (let i = 0; i < SNAPSHOT_RETENTION + 3; i++) {
      await writeProjectFile(root, "jellyfin", "env", `TZ=zone-${i}\n`);
      await writeProjectFile(root, "jellyfin", "compose", `compose-${i}\n`);
    }
    const snaps = await listSnapshots(root, "jellyfin");
    expect(snaps.filter((n) => n.endsWith("docker-compose.yml"))).toHaveLength(
      SNAPSHOT_RETENTION,
    );
    expect(snaps.filter((n) => n.endsWith(".env"))).toHaveLength(
      SNAPSHOT_RETENTION,
    );
  });

  it("leaves foreign files in .snapshots alone", async () => {
    await mkdir(join(root, "jellyfin", ".snapshots"), { recursive: true });
    await writeFile(join(root, "jellyfin", ".snapshots", "README"), "keep me");
    for (let i = 0; i < SNAPSHOT_RETENTION + 3; i++) {
      await writeProjectFile(root, "jellyfin", "compose", `rev-${i}\n`);
    }
    expect(await listSnapshots(root, "jellyfin")).toContain("README");
  });

  it("leaves no temp files behind", async () => {
    await writeProjectFile(root, "jellyfin", "compose", "x\n");
    const names = await readdir(join(root, "jellyfin"));
    expect(names.filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});

describe("createProject", () => {
  it("writes a valid blank scaffold into a new directory", async () => {
    const root = await tempDir("hs-create-");
    await createProject(root, "media", { kind: "blank" });
    const content = await readProjectFile(root, "media", "compose");
    expect(content).toContain("name: media");
    expect(content).toContain("services: {}");
  });

  it("stores a pasted file with provenance injected and comments intact", async () => {
    const root = await tempDir("hs-create-");
    await createProject(root, "immich", {
      kind: "paste",
      content: "# keep me\nservices:\n  web:\n    image: nginx\n",
    });
    const content = (await readProjectFile(root, "immich", "compose")) ?? "";
    expect(content).toContain("# keep me");
    expect(content).toContain("kind: paste");
  });

  it("refuses to overwrite an existing directory", async () => {
    const root = await tempDir("hs-create-");
    await createProject(root, "media", { kind: "blank" });
    await expect(
      createProject(root, "media", { kind: "blank" }),
    ).rejects.toBeInstanceOf(ProjectExistsError);
  });

  it("rejects a slug that would escape the projects root", async () => {
    const root = await tempDir("hs-create-");
    await expect(
      createProject(root, "../evil", { kind: "blank" }),
    ).rejects.toThrow();
  });
});

describe("deleteProjectDir", () => {
  it("removes the directory and everything in it", async () => {
    const root = await tempDir("hs-delete-");
    await createProject(root, "media", { kind: "blank" });
    await writeProjectFile(root, "media", "env", "A=1\n");
    await deleteProjectDir(root, "media");
    expect(await scanProjects(root)).toEqual([]);
  });

  it("rejects a slug that would escape the projects root", async () => {
    const root = await tempDir("hs-delete-");
    await expect(deleteProjectDir(root, "../..")).rejects.toThrow();
  });
});

describe("writeProjectFiles", () => {
  it("creates the directory and writes each file", async () => {
    await writeProjectFiles(root, "homestead-tunnel", {
      "compose.yaml": "services: {}\n",
      ".env": "TUNNEL_TOKEN=abc\n",
    });
    expect(
      await read(join(root, "homestead-tunnel", "compose.yaml"), "utf8"),
    ).toBe("services: {}\n");
    expect(await read(join(root, "homestead-tunnel", ".env"), "utf8")).toBe(
      "TUNNEL_TOKEN=abc\n",
    );
  });

  it("produces a directory the scanner recognises as a project", async () => {
    // The whole point of writing it here is that it becomes an ordinary
    // Homestead project — logs, restart, image updates. A file the scanner
    // does not accept as compose would be an inert directory instead.
    await writeProjectFiles(root, "homestead-tunnel", {
      "compose.yaml": "services: {}\n",
    });
    const found = await scanProjects(root);
    expect(found.map((e) => e.slug)).toContain("homestead-tunnel");
  });

  it("keeps a written .env private", async () => {
    // It holds the tunnel run token, which is what authorises a connector.
    await writeProjectFiles(root, "homestead-tunnel", { ".env": "T=1\n" });
    const { mode } = await stat(join(root, "homestead-tunnel", ".env"));
    expect(mode & 0o077).toBe(0);
  });

  it("refuses a filename that climbs out of the project", async () => {
    await expect(
      writeProjectFiles(root, "homestead-tunnel", { "../escaped": "x" }),
    ).rejects.toThrow(/filename/i);
  });

  it("refuses a slug that escapes the projects root", async () => {
    await expect(
      writeProjectFiles(root, "../evil", { "compose.yaml": "x" }),
    ).rejects.toThrow(/slug/i);
  });

  it("overwrites an existing file rather than failing", async () => {
    // Re-running setup must be safe; a half-written tunnel project is exactly
    // the state someone retries from.
    await writeProjectFiles(root, "homestead-tunnel", { ".env": "T=old\n" });
    await writeProjectFiles(root, "homestead-tunnel", { ".env": "T=new\n" });
    expect(await read(join(root, "homestead-tunnel", ".env"), "utf8")).toBe(
      "T=new\n",
    );
  });
});
