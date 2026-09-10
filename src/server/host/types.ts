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

export interface Host {
  readonly id: string;
  listAppDirectories(): Promise<DiscoveredDir[]>;
  readTextFile(rel: string): Promise<FileRead>;
  writeTextFile(
    rel: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }>;
  listContainers(filters?: { project?: string }): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<unknown>;
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
