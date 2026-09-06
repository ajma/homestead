import { execFile, spawn } from "node:child_process";

export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (
  args: string[],
  opts?: { cwd?: string },
) => Promise<RunResult>;

export type StreamOpts = { cwd?: string; signal?: AbortSignal };
export type StreamRunner = (
  args: string[],
  opts: StreamOpts,
  onOutput: (chunk: string) => void,
) => Promise<number>;

/**
 * The two ways this process is allowed to talk to `docker`. Everything else —
 * compose, the routes, the tests — goes through one of these two, so a fake
 * runner is enough to exercise the whole stack without a daemon.
 */
export type DockerRunner = { run: Runner; stream: StreamRunner };

/** Spawns `docker` directly — never through a shell, so no argument is ever interpreted. */
export const runDocker: Runner = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { cwd: opts?.cwd, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number")
          return reject(err);
        resolve({
          stdout,
          stderr,
          code: err ? ((err as { code: number }).code ?? 1) : 0,
        });
      },
    );
  });

/**
 * Streaming counterpart of {@link runDocker}: merges stdout and stderr into
 * `onOutput` and resolves with the exit code. Does not throw on non-zero.
 *
 * `opts.signal` terminates the child with SIGTERM — that is how a closed SSE
 * connection stops a `docker compose logs --follow` instead of leaking it.
 */
export const streamDocker: StreamRunner = (args, opts, onOutput) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: opts.cwd });
    const kill = () => child.kill("SIGTERM");
    if (opts.signal) {
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", kill, { once: true });
    }
    const detach = () => opts.signal?.removeEventListener("abort", kill);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", (err) => {
      detach();
      reject(err);
    });
    child.on("close", (code) => {
      detach();
      resolve(code ?? 1);
    });
  });

export const dockerRunner: DockerRunner = {
  run: runDocker,
  stream: streamDocker,
};
