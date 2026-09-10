import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Docker from "dockerode";
import { ChunkQueue } from "./chunk-queue.js";
import { PathGuard } from "./paths.js";
import type {
  ComposeOptions,
  ComposeResult,
  ComposeTarget,
  ContainerSummary,
  DiscoveredDir,
  FileRead,
  Host,
  JobHandle,
} from "./types.js";
import { HashMismatchError } from "./types.js";

export const COMPOSE_FILENAMES = [
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

  async deleteFile(rel: string): Promise<void> {
    // resolveForWrite, not resolveExisting: the same target-symlink check applies, and
    // deleting a path that has already gone is not an error.
    const abs = await this.guard.resolveForWrite(rel);
    await rm(abs, { force: true });
  }

  async fileExists(rel: string): Promise<boolean> {
    try {
      await this.guard.resolveExisting(rel);
      return true;
    } catch {
      return false;
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

  /** Output kept for the `result` tail, per stream. Beyond this the head is discarded. */
  private static readonly TAIL_BYTES = 256 * 1024;

  /**
   * Keeps the last `TAIL_BYTES` characters of a stream without re-copying the whole tail
   * on every chunk.
   *
   * Concatenating and slicing per chunk allocates two full tails each time — on a `pull`
   * emitting ten thousand chunks that is gigabytes of garbage for a quarter-megabyte of
   * output. Holding the pieces and joining once at the end is amortised linear.
   */
  private static tailKeeper() {
    const pieces: string[] = [];
    let length = 0;
    return {
      push(text: string) {
        pieces.push(text);
        length += text.length;
        while (length > LocalHost.TAIL_BYTES && pieces.length > 1) {
          length -= pieces.shift()?.length ?? 0;
        }
      },
      text(): string {
        const joined = pieces.join("");
        return joined.length > LocalHost.TAIL_BYTES
          ? joined.slice(joined.length - LocalHost.TAIL_BYTES)
          : joined;
      },
    };
  }

  /**
   * Spawns `docker compose` and returns a handle rather than a finished result.
   *
   * `spawn`, not `execFile`: `execFile` buffers the entire output while we also read it
   * chunk by chunk — two copies of a `pull`'s output — and its `maxBuffer` kills the
   * process outright at the cap. The argument array and absence of a shell are unchanged,
   * which is what keeps this injection-resistant.
   */
  runCompose(target: ComposeTarget, args: string[], opts: ComposeOptions = {}): JobHandle {
    const queue = new ChunkQueue();
    const state = { child: null as ChildProcess | null, cancelled: false };
    const tails = {
      stdout: LocalHost.tailKeeper(),
      stderr: LocalHost.tailKeeper(),
    };

    const result = (async (): Promise<ComposeResult> => {
      const composePath = await this.guard.resolveExisting(
        join(target.directory, target.composeFile),
      );
      if (state.cancelled) {
        queue.close();
        // 143 here too, not 130: a caller checking for "cancelled" should not have to
        // know whether the process had started yet.
        return { exitCode: 143, stdout: "", stderr: "cancelled before start" };
      }

      return await new Promise<ComposeResult>((resolve) => {
        const child = spawn("docker", ["compose", "-f", composePath, ...args], {
          timeout: opts.timeoutMs ?? 60_000,
          killSignal: "SIGTERM",
        });
        state.child = child;

        for (const stream of ["stdout", "stderr"] as const) {
          const pipe = child[stream];
          pipe?.setEncoding("utf8");
          pipe?.on("data", (text: string) => {
            tails[stream].push(text);
            queue.push({ text, stream });
          });
        }

        child.on("error", (error) => {
          queue.close();
          resolve({ exitCode: 1, stdout: tails.stdout.text(), stderr: error.message });
        });

        child.on("close", (code, signal) => {
          queue.close();
          // A signalled exit reports 128+n the way a shell would, so a killed `pull` is
          // distinguishable from a compose file that genuinely failed to validate.
          const exitCode = code ?? (signal === "SIGTERM" ? 143 : 1);
          resolve({ exitCode, stdout: tails.stdout.text(), stderr: tails.stderr.text() });
        });
      });
    })().catch((error: unknown) => {
      // A path-guard rejection lands here. The handle must still settle; a caller
      // awaiting `result` would otherwise hang forever on a typo in a directory name.
      queue.close();
      return {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    });

    return {
      output: queue,
      result,
      cancel: () => {
        state.cancelled = true;
        state.child?.kill("SIGTERM");
      },
    };
  }
}
