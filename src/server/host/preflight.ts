import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Docker from "dockerode";

export type PreflightResult = { ok: true } | { ok: false; reason: string };

export class PreflightError extends Error {
  constructor(reason: string) {
    super(
      `Compose root mount preflight failed: ${reason}\n\n` +
        "The compose root must be bind-mounted into this container at the SAME absolute path " +
        "it has on the host. Docker resolves each stack's bind mounts against the host " +
        "filesystem, and a host-invalid source is silently created as an empty directory — " +
        "so stacks would start with blank config and data volumes.\n" +
        "Set HOMESTEAD_SKIP_MOUNT_PREFLIGHT=true only for development or CI.",
    );
    this.name = "PreflightError";
  }
}

const DEFAULT_IMAGE = "alpine:3";

async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // Not present locally; pull it.
  }
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

export async function runMountPreflight(opts: {
  composeRoot: string;
  dockerSocket: string;
  image?: string;
}): Promise<PreflightResult> {
  const image = opts.image ?? DEFAULT_IMAGE;
  const docker = new Docker({ socketPath: opts.dockerSocket });
  const markerDir = join(opts.composeRoot, ".homestead-preflight");
  const markerName = `${randomUUID()}.marker`;
  const markerPath = join(markerDir, markerName);
  const token = randomUUID();

  // One try/finally around EVERYTHING that can create the marker directory, so no
  // early return can skip its removal. An earlier version returned from the write
  // failure before entering the block whose `finally` did the cleanup, leaking
  // `.homestead-preflight` into the user's compose root.
  try {
    try {
      await mkdir(markerDir, { recursive: true });
      await writeFile(markerPath, token, "utf8");
    } catch (error) {
      // `markerDir` is shared by every concurrent run, and this run's own `mkdir` can
      // race a DIFFERENT run's cleanup `rmdir` below: that run finishes, sees (from its
      // own perspective) an empty directory, and removes it in the microseconds-wide
      // window between this run's `mkdir` returning and its `writeFile` landing —
      // producing exactly the ENOENT `writeFile` throws when its parent directory is
      // gone. That is not a real mount failure, so it gets one retry of the same
      // mkdir+writeFile pair rather than being reported as one; a genuine problem
      // (permissions, a missing compose root) throws again immediately and is reported
      // the same way it always was.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        try {
          await mkdir(markerDir, { recursive: true });
          await writeFile(markerPath, token, "utf8");
        } catch (retryError) {
          return {
            ok: false,
            reason: `cannot write a marker into ${opts.composeRoot}: ${String(retryError)}`,
          };
        }
      } else {
        return {
          ok: false,
          reason: `cannot write a marker into ${opts.composeRoot}: ${String(error)}`,
        };
      }
    }

    await ensureImage(docker, image);

    const container = await docker.createContainer({
      Image: image,
      Cmd: ["cat", `/mnt/preflight/.homestead-preflight/${markerName}`],
      HostConfig: {
        Binds: [`${opts.composeRoot}:/mnt/preflight:ro`],
        AutoRemove: false,
      },
    });

    try {
      const logs = await container.attach({ stream: true, stdout: true, stderr: true });
      const chunks: Buffer[] = [];

      // `container.wait()` resolving means the container exited, NOT that every
      // 'data' event has fired. Reading the buffer immediately can miss the tail and
      // report a healthy mount as broken — a false negative that refuses to boot.
      const streamDrained = new Promise<void>((resolveDrained) => {
        logs.on("data", (chunk: Buffer) => chunks.push(chunk));
        logs.on("end", resolveDrained);
        logs.on("close", resolveDrained);
        logs.on("error", resolveDrained);
      });

      await container.start();
      await container.wait();

      const drainTimeout = new Promise<void>((resolveTimeout) => {
        setTimeout(resolveTimeout, 2000).unref();
      });
      await Promise.race([streamDrained, drainTimeout]);

      // Strip Docker's 8-byte stream multiplexing headers.
      const output = demultiplex(Buffer.concat(chunks));

      if (!output.includes(token)) {
        return {
          ok: false,
          reason:
            `the marker file was not visible to the Docker daemon at ${opts.composeRoot}. ` +
            "The daemon saw an empty or different directory at that path.",
        };
      }
      return { ok: true };
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  } catch (error) {
    return { ok: false, reason: `could not run the marker check: ${String(error)}` };
  } finally {
    // Remove only this run's marker file, then try the directory non-recursively and
    // swallow the error if it is not empty. `markerDir` is shared by every concurrent
    // run (and every previous abnormal exit); a recursive removal here would delete a
    // sibling run's not-yet-read marker out from under it, turning a healthy re-check
    // into a false "marker not visible" failure. A directory left behind because another
    // run's marker is still inside is harmless — the same as after an abnormal exit.
    await rm(markerPath, { force: true }).catch(() => {});
    await rmdir(markerDir).catch(() => {});
  }
}

/**
 * Docker frames non-TTY output as [type, 0, 0, 0, len32be, ...payload].
 *
 * The header is validated rather than assumed: in TTY mode output is unframed, and
 * unframed bytes whose first eight happen to parse as a header would otherwise have
 * their first eight bytes silently eaten. Validating type and padding makes the
 * "is this framed?" question answerable instead of guessed.
 */
function looksLikeFrameHeader(buffer: Buffer, offset: number): boolean {
  const streamType = buffer[offset];
  if (streamType === undefined || streamType > 2) return false;
  if (buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0)
    return false;
  return offset + 8 + buffer.readUInt32BE(offset + 4) <= buffer.length;
}

function demultiplex(buffer: Buffer): string {
  if (buffer.length < 8 || !looksLikeFrameHeader(buffer, 0)) return buffer.toString("utf8");

  let offset = 0;
  const parts: string[] = [];
  while (offset + 8 <= buffer.length && looksLikeFrameHeader(buffer, offset)) {
    const length = buffer.readUInt32BE(offset + 4);
    parts.push(buffer.subarray(offset + 8, offset + 8 + length).toString("utf8"));
    offset += 8 + length;
  }
  // Trailing bytes that are not a valid frame belong to the payload.
  if (offset < buffer.length) parts.push(buffer.subarray(offset).toString("utf8"));
  return parts.join("");
}
