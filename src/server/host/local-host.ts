import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import Docker from "dockerode";
import { ChunkQueue } from "./chunk-queue.js";
import { LogDemultiplexer } from "./log-demux.js";
import { PathGuard } from "./paths.js";
import type {
  ComposeOptions,
  ComposeResult,
  ComposeTarget,
  ContainerInspect,
  ContainerSummary,
  DiscoveredDir,
  FileRead,
  Host,
  ImageInspect,
  JobHandle,
  LogLine,
  LogOptions,
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

/** Fixed width, so the mask reveals nothing about a secret's length. Matches env-file.ts. */
const MASK = "••••••••";

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

  /**
   * Creates an app's directory under the compose root. Idempotent.
   *
   * `resolveForWrite` is the confinement check reused here rather than duplicated: its
   * "parent must exist" rule is trivially satisfied for a brand-new top-level directory,
   * because the parent IS the compose root, which always exists. That rule only ever
   * bites when something tries to write a FILE whose own directory does not exist yet —
   * which is exactly the bug this method exists to fix, by running first and making that
   * directory exist. `resolveForWrite` also runs the guard's `assertAddressesChild`
   * check and its symlink/traversal checks, so a nested or escaping path (e.g. "a/../b")
   * is rejected here without a second, competing implementation of path confinement.
   *
   * `recursive: true` is deliberate, not a shortcut someone should "harden" away. It
   * makes this call idempotent: a create can fail AFTER this step — the compose write,
   * or the row insert — and a retry with the same directory name must not then die on
   * `EEXIST`. It cannot be used to create a nested path, because `resolveForWrite` has
   * already rejected anything that is not a direct child of the root.
   */
  async createAppDirectory(directory: string): Promise<void> {
    const abs = await this.guard.resolveForWrite(directory);
    await mkdir(abs, { recursive: true });
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

  /**
   * Follows a container's logs.
   *
   * `Config.Tty` decides the framing. With a TTY, Docker sends raw bytes on one stream.
   * Without one — the normal case for a compose service — it interleaves stdout and stderr
   * with an 8-byte header per chunk, so the bytes must be demultiplexed or the log fills
   * with control characters.
   */
  /**
   * Consume this with `for await`, or call `return()` on the iterator yourself.
   *
   * The body is a generator, so nothing runs — and no socket is opened — until the first
   * `next()`. Measured: obtaining five iterables and never iterating them left the
   * process's handle count unchanged. But an iterator advanced once and then abandoned
   * without `return()` does leak, because only `return()` runs the `finally` below:
   * three such iterators added three handles. `for await` always calls `return()` on
   * break or throw, which is why every caller in this phase uses it.
   */
  async *streamLogs(opts: LogOptions): AsyncIterable<LogLine> {
    const container = this.docker.getContainer(opts.containerId);
    const details = await container.inspect();
    const tty = details.Config?.Tty === true;

    // dockerode types `logs` as Buffer | ReadableStream depending on `follow`; at runtime
    // with follow:true it is a stream, and with follow:false a Buffer. The overload requires
    // literal boolean types; work around by widening to the union result type.
    const stream = (await container.logs({
      follow: opts.follow ?? false,
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 200,
      ...(opts.since === undefined ? {} : { since: opts.since }),
    } as Parameters<typeof container.logs>[0])) as Buffer | NodeJS.ReadableStream;

    const queue = new ChunkQueue();
    const demux = tty ? null : new LogDemultiplexer();
    const ttyDecoder = tty ? new StringDecoder("utf8") : null;

    // Without this, an abandoned log stream on an idle container holds the Docker socket
    // open indefinitely: the loop below consults `disconnected` only when a chunk arrives,
    // and on an idle container with follow:true no chunk ever arrives.
    const onAbort = () => {
      if (!Buffer.isBuffer(stream)) {
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      }
      queue.close();
    };
    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    }

    if (Buffer.isBuffer(stream)) {
      try {
        for (const chunk of demux
          ? demux.push(stream)
          : [{ text: stream.toString("utf8"), stream: "stdout" as const }]) {
          queue.push(chunk);
        }
        if (demux) for (const chunk of demux.flush()) queue.push(chunk);
      } catch (error) {
        queue.push({
          text: `\n[log stream ended: ${error instanceof Error ? error.message : "framing error"}]\n`,
          stream: "stderr",
        });
      }
      queue.close();
    } else {
      // At this point, stream is a NodeJS.ReadableStream.
      const readable = stream as NodeJS.ReadableStream & { destroy?: () => void };
      readable.on("data", (buffer: Buffer) => {
        if (demux) {
          try {
            for (const chunk of demux.push(buffer)) queue.push(chunk);
          } catch (error) {
            // `LogFramingError`: the bytes are not framed after all — most likely the
            // container was recreated with a TTY between our inspect and this stream.
            // End cleanly rather than throwing from a 'data' handler, which would be an
            // unhandled rejection rather than a closed log pane.
            queue.push({
              text: `\n[log stream ended: ${error instanceof Error ? error.message : "framing error"}]\n`,
              stream: "stderr",
            });
            for (const chunk of demux.flush()) queue.push(chunk);
            queue.close();
            readable.destroy?.();
          }
        } else if (ttyDecoder) {
          const text = ttyDecoder.write(buffer);
          if (text !== "") queue.push({ text, stream: "stdout" });
        }
      });
      readable.on("end", () => {
        if (demux) for (const chunk of demux.flush()) queue.push(chunk);
        // The TTY path needs the same courtesy: without `end()` a stream finishing
        // mid-character drops it, so "café" arrives as "caf".
        if (ttyDecoder) {
          const trailing = ttyDecoder.end();
          if (trailing !== "") queue.push({ text: trailing, stream: "stdout" });
        }
        queue.close();
      });
      readable.on("error", () => {
        // Same flush as the `end` path. A socket dying mid-character would otherwise
        // drop it, and the two paths differing is how one of them silently rots.
        if (demux) for (const chunk of demux.flush()) queue.push(chunk);
        if (ttyDecoder) {
          const trailing = ttyDecoder.end();
          if (trailing !== "") queue.push({ text: trailing, stream: "stdout" });
        }
        queue.close();
      });
    }

    try {
      yield* queue;
    } finally {
      // The consumer breaking out of its `for await` lands here — which is the NORMAL
      // exit for the SSE log route, because browsers disconnect constantly. Without the
      // destroy the handlers keep firing into a queue nobody reads and the Docker socket
      // stays open, one per abandoned viewer.
      if (!Buffer.isBuffer(stream))
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const raw = await this.docker.getContainer(id).inspect();
    return {
      id: raw.Id,
      name: raw.Name?.replace(/^\//, "") ?? id,
      image: raw.Config?.Image ?? "",
      imageDigest: raw.Image ?? null,
      state: raw.State?.Status ?? "unknown",
      exitCode: raw.State?.ExitCode ?? null,
      oomKilled: raw.State?.OOMKilled === true,
      startedAt: raw.State?.StartedAt ?? null,
      finishedAt: raw.State?.FinishedAt ?? null,
      restartPolicy: raw.HostConfig?.RestartPolicy?.Name ?? "no",
      restartCount: raw.RestartCount ?? 0,
      tty: raw.Config?.Tty === true,
      // Masked here, at the boundary, not at the route. Config.Env is where a container's
      // secrets are, and a projection carrying raw values is one JSON.stringify away from
      // an error body or a log line.
      env: (raw.Config?.Env ?? []).map((entry) => {
        const eq = entry.indexOf("=");
        const key = eq === -1 ? entry : entry.slice(0, eq);
        const value = eq === -1 ? "" : entry.slice(eq + 1);
        return { key, masked: value === "" ? "" : MASK };
      }),
      mounts: (raw.Mounts ?? []).map((mount) => ({
        source: mount.Source ?? "",
        destination: mount.Destination ?? "",
        mode: mount.RW === false ? "ro" : "rw",
        type: mount.Type ?? "bind",
      })),
      ports: Object.entries(raw.NetworkSettings?.Ports ?? {}).flatMap(([spec, bindings]) => {
        const [portText, protocol] = spec.split("/");
        const container = Number(portText);
        if (!Number.isFinite(container)) return [];
        // `HostPort` is "" for a port that is exposed but not published. `Number("")` is
        // 0, which is finite, so a naive coercion reports the app as reachable on port 0.
        const host = bindings?.[0]?.HostPort;
        const hostPort = host === undefined || host === "" ? Number.NaN : Number(host);
        return [
          {
            container,
            host: Number.isFinite(hostPort) && hostPort > 0 ? hostPort : null,
            protocol: protocol ?? "tcp",
          },
        ];
      }),
      networks: Object.keys(raw.NetworkSettings?.Networks ?? {}),
      health: raw.State?.Health
        ? {
            status: raw.State.Health.Status ?? "unknown",
            failingStreak: raw.State.Health.FailingStreak ?? 0,
            log: (raw.State.Health.Log ?? []).slice(-5).map((entry) => ({
              exitCode: entry.ExitCode ?? 0,
              output: entry.Output ?? "",
              end: entry.End ?? "",
            })),
          }
        : null,
    };
  }

  /**
   * `null` when the image has never been pulled — a normal state — but a **throw** for
   * anything else.
   *
   * Swallowing every error made a wedged Docker socket indistinguishable from a missing
   * image, and the image-update checker reads `null` as "nothing local to compare", so a
   * broken socket would have reported every app as up to date rather than as unknown.
   * Docker answers 404 for a genuinely absent image; everything else is infrastructure.
   */
  async inspectImage(ref: string): Promise<ImageInspect | null> {
    try {
      const raw = await this.docker.getImage(ref).inspect();
      return { id: raw.Id, repoDigests: raw.RepoDigests ?? [] };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
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
