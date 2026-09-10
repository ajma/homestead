import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  const token = randomUUID();

  try {
    await mkdir(markerDir, { recursive: true });
    await writeFile(join(markerDir, markerName), token, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `cannot write a marker into ${opts.composeRoot}: ${String(error)}`,
    };
  }

  try {
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
      logs.on("data", (chunk: Buffer) => chunks.push(chunk));

      await container.start();
      await container.wait();

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
    await rm(markerDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Docker frames non-TTY output as [type, 0, 0, 0, len32be, ...payload]. */
function demultiplex(buffer: Buffer): string {
  let offset = 0;
  const parts: string[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    parts.push(buffer.subarray(offset + 8, offset + 8 + length).toString("utf8"));
    offset += 8 + length;
  }
  // If framing did not apply (TTY mode), fall back to the raw buffer.
  return parts.length > 0 ? parts.join("") : buffer.toString("utf8");
}
