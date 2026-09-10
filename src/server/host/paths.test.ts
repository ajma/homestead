import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathEscapeError, PathGuard } from "@server/host/paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "hs-paths-"));
  root = join(base, "compose");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(root, "jellyfin"), { recursive: true });
  await writeFile(join(root, "jellyfin", "compose.yaml"), "services: {}");
  await writeFile(join(outside, "passwd"), "root:x:0:0");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

describe("PathGuard", () => {
  it("resolves a legitimate path inside the root", async () => {
    const guard = new PathGuard(root);
    await guard.init();
    await expect(guard.resolveExisting("jellyfin/compose.yaml")).resolves.toContain("jellyfin");
  });

  it("rejects traversal with ..", async () => {
    const guard = new PathGuard(root);
    await guard.init();
    await expect(guard.resolveExisting("../outside/passwd")).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it("rejects an absolute path", async () => {
    const guard = new PathGuard(root);
    await guard.init();
    await expect(guard.resolveExisting("/etc/passwd")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a symlink escaping the root", async () => {
    await symlink(outside, join(root, "escape"));
    const guard = new PathGuard(root);
    await guard.init();
    await expect(guard.resolveExisting("escape/passwd")).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a write whose parent directory is a symlink escaping the root", async () => {
    await symlink(outside, join(root, "escape"));
    const guard = new PathGuard(root);
    await guard.init();
    await expect(guard.resolveForWrite("escape/newfile.txt")).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it("allows a write to a not-yet-existing file inside the root", async () => {
    const guard = new PathGuard(root);
    await guard.init();
    await expect(guard.resolveForWrite("jellyfin/.env")).resolves.toContain(".env");
  });

  it("accepts paths when the configured root is itself a symlink", async () => {
    const linkedRoot = join(root, "..", "linked");
    await symlink(root, linkedRoot);
    const guard = new PathGuard(linkedRoot);
    await guard.init();
    await expect(guard.resolveExisting("jellyfin/compose.yaml")).resolves.toBeTruthy();
  });
});
