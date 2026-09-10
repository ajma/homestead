import { createHash } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
    const temp = join(dirname(abs), `.homestead-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temp, content, "utf8");
    await rename(temp, abs);
    return { hash: hashContent(content) };
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
