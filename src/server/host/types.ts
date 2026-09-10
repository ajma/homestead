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

export type ComposeOptions = {
  /** Called as output arrives. Phase 1B-ii uses this for lifecycle job streaming. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Defaults to 60s. Lifecycle operations in 1B-ii will raise it. */
  timeoutMs?: number;
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
  inspectContainer(id: string): Promise<unknown>;
  runCompose(target: ComposeTarget, args: string[], opts?: ComposeOptions): Promise<ComposeResult>;
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
