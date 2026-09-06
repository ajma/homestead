import { execFile } from "node:child_process";

export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (
  args: string[],
  opts?: { cwd?: string },
) => Promise<RunResult>;

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
