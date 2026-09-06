import type { DockerRunner, RunResult, StreamOpts } from "./run.js";

/**
 * A `DockerRunner` that never spawns anything.
 *
 * Route tests exist to exercise routing, authorization and error handling —
 * not Docker. Reaching a real daemon from the default suite is actively
 * dangerous: compose reconciles by project-name label, not by directory, so a
 * `up` issued from a temp fixture will happily recreate a user's real stack of
 * the same name. Real-Docker coverage lives in `*.integration.test.ts`, gated
 * behind HOMESTEAD_DOCKER_TESTS.
 */
export type FakeDockerCall = { args: string[]; cwd: string | undefined };

export type FakeDockerOptions = {
  /** Returned for `compose … config --format json`. */
  config?: unknown;
  /** One object per line for `compose … ps --format json`. */
  ps?: unknown[];
  /** Chunks the default stream implementation emits before resolving. */
  output?: string[];
  /** Exit code the default stream implementation resolves with. */
  exitCode?: number;
  /** Full override of streaming behaviour, e.g. to hold an operation open. */
  stream?: (
    args: string[],
    opts: StreamOpts,
    onOutput: (chunk: string) => void,
  ) => Promise<number>;
};

export type FakeDocker = {
  runner: DockerRunner;
  /** Every invocation, in order, for argv assertions. */
  calls: FakeDockerCall[];
  /** Only the invocations that went through the streaming path. */
  streamed: FakeDockerCall[];
};

/** The compose sub-command, ignoring the leading `compose -f <path>` pairs. */
export function composeVerbOf(args: string[]): string | undefined {
  let i = args[0] === "compose" ? 1 : 0;
  while (args[i] === "-f") i += 2;
  return args[i];
}

export function createFakeDocker(options: FakeDockerOptions = {}): FakeDocker {
  const calls: FakeDockerCall[] = [];
  const streamed: FakeDockerCall[] = [];

  const runner: DockerRunner = {
    async run(args, opts): Promise<RunResult> {
      calls.push({ args, cwd: opts?.cwd });
      const verb = composeVerbOf(args);
      if (verb === "config") {
        if (options.config === undefined) {
          return {
            stdout: "",
            stderr: "no compose config configured",
            code: 1,
          };
        }
        return { stdout: JSON.stringify(options.config), stderr: "", code: 0 };
      }
      if (verb === "ps") {
        const lines = (options.ps ?? []).map((row) => JSON.stringify(row));
        return { stdout: lines.join("\n"), stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    async stream(args, opts, onOutput): Promise<number> {
      const call = { args, cwd: opts.cwd };
      calls.push(call);
      streamed.push(call);
      if (options.stream) return options.stream(args, opts, onOutput);
      for (const chunk of options.output ?? []) onOutput(chunk);
      return options.exitCode ?? 0;
    },
  };

  return { runner, calls, streamed };
}
