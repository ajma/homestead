import { createHash } from "node:crypto";
import { chmod, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Docker from "dockerode";
import { PathGuard } from "./paths.js";
import type { ContainerSummary, DiscoveredDir, FileRead, Host } from "./types.js";
import { HashMismatchError } from "./types.js";

const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class LocalHost implements Host {
  private readonly guard: PathGuard;
  private readonly docker: Docker;

  constructor(
    readonly id: string,
    private readonly composeRoot: string,
    dockerSocket: string,
  ) {
    this.guard = new PathGuard(composeRoot);
    this.docker = new Docker({ socketPath: dockerSocket });
  }

  async init(): Promise<void> {
    await this.guard.init();
  }

  async listAppDirectories(): Promise<DiscoveredDir[]> {
    const entries = await readdir(this.composeRoot, { withFileTypes: true });
    const found: DiscoveredDir[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const candidate of COMPOSE_FILENAMES) {
        try {
          await stat(join(this.composeRoot, entry.name, candidate));
          found.push({ directory: entry.name, composeFile: candidate });
          break;
        } catch {
          // Try the next candidate filename.
        }
      }
    }
    return found.sort((a, b) => a.directory.localeCompare(b.directory));
  }

  async readTextFile(rel: string): Promise<FileRead> {
    const abs = await this.guard.resolveExisting(rel);
    const content = await readFile(abs, "utf8");
    return { content, hash: hashContent(content) };
  }

  async writeTextFile(
    rel: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }> {
    const abs = await this.guard.resolveForWrite(rel);

    let currentHash: string | null = null;
    try {
      currentHash = hashContent(await readFile(abs, "utf8"));
    } catch {
      currentHash = null;
    }

    if (currentHash !== expectedHash) {
      throw new HashMismatchError(expectedHash, currentHash ?? "<absent>");
    }

    // Write to a sibling temp file and rename. Two reasons: a crash cannot truncate the
    // original, and `rename` REPLACES a symlink at the destination rather than following
    // it — so even if a symlink is planted between PathGuard's check and this write
    // (a TOCTOU race), the write lands inside the root. Never `writeFile` to `abs`
    // directly; that call follows symlinks.
    //
    // The temp file's mode becomes the destination's mode after rename, so it must be
    // chosen deliberately. `.env` files hold database passwords and API keys, and the
    // compose root is an SMB share. Defaulting to the umask (0644 here) would publish
    // new secrets to every local user AND silently downgrade a file the user had
    // already chmod'ed to 0600.
    const mode = await stat(abs)
      .then((s) => s.mode & 0o777)
      .catch(() => 0o600); // New file: owner-only. Callers may relax it afterwards.

    const temp = join(dirname(abs), `.homestead-${process.pid}-${Date.now()}.tmp`);
    let renamed = false;
    try {
      // 'wx' fails if the path exists, so a pre-created file with a permissive mode
      // cannot be reused. Mode is applied at creation, then forced with chmod because
      // the process umask can strip bits from the requested mode.
      await writeFile(temp, content, { encoding: "utf8", mode, flag: "wx" });
      await chmod(temp, mode);
      await rename(temp, abs);
      renamed = true;
      return { hash: hashContent(content) };
    } finally {
      // Clean up temp file if it still exists (rename failed). After a successful rename,
      // the temp path no longer exists, so `force: true` makes this safe.
      if (!renamed) {
        await rm(temp, { force: true });
      }
    }
  }

  async listContainers(filters?: { project?: string }): Promise<ContainerSummary[]> {
    const label = filters?.project ? [`com.docker.compose.project=${filters.project}`] : undefined;
    const raw = await this.docker.listContainers({
      all: true,
      filters: label ? { label } : undefined,
    });
    return raw.map((c) => ({
      id: c.Id,
      names: (c.Names ?? []).map((n) => n.replace(/^\//, "")),
      image: c.Image,
      state: c.State,
      status: c.Status,
      project: c.Labels?.["com.docker.compose.project"] ?? null,
      service: c.Labels?.["com.docker.compose.service"] ?? null,
      labels: c.Labels ?? {},
    }));
  }

  async inspectContainer(id: string): Promise<unknown> {
    return this.docker.getContainer(id).inspect();
  }
}
