import { buildApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { loadConfig } from "./config.js";
import { SecretStore } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import { hashContent } from "./host/local-host.js";
import type {
  ComposeOptions,
  ComposeResult,
  ComposeTarget,
  ContainerSummary,
  DiscoveredDir,
  FileRead,
  Host,
} from "./host/types.js";
import { HashMismatchError } from "./host/types.js";

/**
 * In-memory `Host` for tests.
 *
 * Every method takes the SAME parameters as the real interface, and
 * `writeTextFile` enforces the SAME hash guard as `LocalHost`. TypeScript's
 * parameter bivariance would happily accept a fake that quietly dropped
 * `expectedHash` — and then every test written against it would pass while the
 * real implementation rejected the identical call. A fake that is more permissive
 * than the thing it stands in for certifies behaviour that cannot happen.
 */
export class FakeHost implements Host {
  readonly id = "test";
  files = new Map<string, string>();
  containers: ContainerSummary[] = [];
  inspected: string[] = [];
  /** Scripted results, keyed by the joined args. Unmatched calls throw rather than
   *  returning a plausible empty success, which would let a test pass vacuously. */
  composeResults = new Map<string, ComposeResult>();
  composeCalls: Array<{ target: ComposeTarget; args: string[] }> = [];
  readTextFileErrors = new Map<string, Error>();

  async listAppDirectories(): Promise<DiscoveredDir[]> {
    return [...this.files.keys()]
      .filter((p) => p.includes("/"))
      .map((p) => ({ directory: p.split("/")[0] ?? "", composeFile: "compose.yaml" }));
  }

  async readTextFile(rel: string): Promise<FileRead> {
    const error = this.readTextFileErrors.get(rel);
    if (error) throw error;
    const content = this.files.get(rel);
    if (content === undefined) throw new Error(`no such file: ${rel}`);
    return { content, hash: hashContent(content) };
  }

  async writeTextFile(
    rel: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }> {
    const existing = this.files.get(rel);
    const currentHash = existing === undefined ? null : hashContent(existing);
    if (currentHash !== expectedHash) {
      throw new HashMismatchError(expectedHash, currentHash ?? "<absent>");
    }
    this.files.set(rel, content);
    return { hash: hashContent(content) };
  }

  async listContainers(filters?: { project?: string }): Promise<ContainerSummary[]> {
    if (!filters?.project) return this.containers;
    return this.containers.filter((c) => c.project === filters.project);
  }

  async inspectContainer(id: string): Promise<unknown> {
    this.inspected.push(id);
    return {};
  }

  async runCompose(
    target: ComposeTarget,
    args: string[],
    opts: ComposeOptions = {},
  ): Promise<ComposeResult> {
    this.composeCalls.push({ target, args });
    const result = this.composeResults.get(args.join(" "));
    if (!result) throw new Error(`FakeHost: no scripted compose result for: ${args.join(" ")}`);
    // Same swallow as LocalHost: a fake that propagates a callback throw would make
    // tests pass or fail differently from production.
    const emit = (text: string, stream: "stdout" | "stderr") => {
      try {
        opts.onOutput?.(text, stream);
      } catch {
        /* consumer's problem */
      }
    };
    if (result.stdout) emit(result.stdout, "stdout");
    if (result.stderr) emit(result.stderr, "stderr");
    return result;
  }
}

export async function buildTestApp() {
  const config = loadConfig({
    HOMESTEAD_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
    HOMESTEAD_BASE_URL: "http://localhost:3000",
    NODE_ENV: "test",
  });
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  const secrets = new SecretStore(db, config.secretKey);
  const host = new FakeHost();
  const auth = createAuth(config, db);
  return buildApp({ config, db, host, secrets, auth });
}
