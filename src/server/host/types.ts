export type DiscoveredDir = { directory: string; composeFile: string };

export type ContainerSummary = {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  project: string | null;
  service: string | null;
  labels: Record<string, string>;
};

export type FileRead = { content: string; hash: string };

export type ComposeTarget = { directory: string; composeFile: string };

export type ComposeResult = { exitCode: number; stdout: string; stderr: string };

export type JobChunk = { text: string; stream: "stdout" | "stderr" };

export type LogOptions = {
  containerId: string;
  tail?: number;
  follow?: boolean;
  since?: number;
  signal?: AbortSignal;
};
export type LogLine = { text: string; stream: "stdout" | "stderr" };

export type ContainerInspect = {
  id: string;
  name: string;
  image: string;
  imageDigest: string | null;
  state: string;
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  restartPolicy: string;
  restartCount: number;
  tty: boolean;
  env: Array<{ key: string; masked: string }>;
  mounts: Array<{ source: string; destination: string; mode: string; type: string }>;
  ports: Array<{ container: number; host: number | null; protocol: string }>;
  networks: string[];
  health: {
    status: string;
    failingStreak: number;
    log: Array<{ exitCode: number; output: string; end: string }>;
  } | null;
};

export type ImageInspect = { id: string; repoDigests: string[] };

export type ComposeOptions = {
  /**
   * Defaults to 60s, which suits `config`. Lifecycle callers pass a much larger value:
   * `docker compose pull` on a large stack runs for minutes and must not be killed.
   */
  timeoutMs?: number;
};

export type JobHandle = {
  /** Bounded, drop-oldest. Ignoring it entirely does not slow or block the process. */
  output: AsyncIterable<JobChunk>;
  result: Promise<ComposeResult>;
  /** Idempotent. Sends SIGTERM; `result` still resolves, with a non-zero exit code. */
  cancel(): void;
};

export interface Host {
  readonly id: string;
  listAppDirectories(): Promise<DiscoveredDir[]>;
  readTextFile(rel: string): Promise<FileRead>;
  writeTextFile(
    rel: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }>;
  deleteFile(rel: string): Promise<void>;
  fileExists(rel: string): Promise<boolean>;
  listContainers(filters?: { project?: string }): Promise<ContainerSummary[]>;
  streamLogs(opts: LogOptions): AsyncIterable<LogLine>;
  inspectContainer(id: string): Promise<ContainerInspect>;
  inspectImage(ref: string): Promise<ImageInspect | null>;
  runCompose(target: ComposeTarget, args: string[], opts?: ComposeOptions): JobHandle;
}

export class HashMismatchError extends Error {
  constructor(
    readonly expected: string | null,
    readonly actual: string,
  ) {
    super("File changed on disk since it was read");
    this.name = "HashMismatchError";
  }
}
