import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { buildApp } from "./app.js";
import { ComposeConfigCache } from "./apps/compose-config.js";
import { ImageUpdateChecker } from "./apps/image-updates.js";
import { JobRunner } from "./apps/job-runner.js";
import { createAuth } from "./auth/auth.js";
import { ensureLocalHost } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { SecretStore } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import { ChunkQueue } from "./host/chunk-queue.js";
import { COMPOSE_FILENAMES, hashContent } from "./host/local-host.js";
import type {
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
} from "./host/types.js";
import { HashMismatchError } from "./host/types.js";

export type TestApp = FastifyInstance & {
  deps: AppDeps & { host: FakeHost; registryDigests: Map<string, string> };
};

/**
 * Splits text into AT MOST `count` pieces at arbitrary offsets — deliberately not on line
 * boundaries. Code that assumes a chunk is a whole line is the bug this exists to catch.
 * Fewer pieces than asked for when the text is shorter than the count; the point is
 * "more than one, split anywhere", not an exact number.
 */
function splitIntoChunks(text: string, count: number): string[] {
  if (text === "") return [];
  const size = Math.max(1, Math.ceil(text.length / count));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

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
  logLines = new Map<string, LogLine[]>();
  logCalls: LogOptions[] = [];
  /** Scripted inspect data. NOTE the existing `inspected` field is a `string[]` call log —
   *  rename that to `inspectCalls` rather than replacing it, so nothing loses the log. */
  inspected = new Map<string, ContainerInspect>();
  inspectCalls: string[] = [];
  images = new Map<string, ImageInspect>();
  inspectImageErrors = new Map<string, Error>();
  /** Scripted per `args.join(" ")`, as before. */
  composeResults = new Map<string, ComposeResult>();
  composeCalls: Array<{ target: ComposeTarget; args: string[] }> = [];
  readTextFileErrors = new Map<string, Error>();
  deleteFileErrors = new Map<string, Error>();
  listContainersCalls = 0;
  /**
   * How many pieces to split scripted stdout into. Real output arrives in many chunks
   * split at arbitrary byte boundaries — never once, whole, and never on line boundaries.
   */
  composeChunkCount = 3;
  /** Set to have `runCompose` hang until `releaseCompose()` is called. */
  private composeGate: Promise<void> | null = null;
  private releaseComposeGate: (() => void) | null = null;

  gateCompose(): void {
    this.composeGate = new Promise((resolve) => {
      this.releaseComposeGate = resolve;
    });
  }

  releaseCompose(): void {
    this.releaseComposeGate?.();
    this.composeGate = null;
    this.releaseComposeGate = null;
  }

  async listAppDirectories(): Promise<DiscoveredDir[]> {
    const directories = new Set<string>();
    for (const path of this.files.keys()) {
      if (path.includes("/")) {
        directories.add(path.split("/")[0] ?? "");
      }
    }
    const found: DiscoveredDir[] = [];
    for (const directory of directories) {
      for (const candidate of COMPOSE_FILENAMES) {
        const path = `${directory}/${candidate}`;
        if (this.files.has(path)) {
          found.push({ directory, composeFile: candidate });
          break;
        }
      }
    }
    return found.sort((a, b) => a.directory.localeCompare(b.directory));
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

  async deleteFile(rel: string): Promise<void> {
    const error = this.deleteFileErrors.get(rel);
    if (error) throw error;
    this.files.delete(rel);
  }

  async fileExists(rel: string): Promise<boolean> {
    return this.files.has(rel);
  }

  async listContainers(filters?: { project?: string }): Promise<ContainerSummary[]> {
    this.listContainersCalls++;
    if (!filters?.project) return this.containers;
    return this.containers.filter((c) => c.project === filters.project);
  }

  async *streamLogs(opts: LogOptions): AsyncIterable<LogLine> {
    this.logCalls.push(opts);
    if (opts.signal?.aborted) return;
    const lines = this.logLines.get(opts.containerId) ?? [];
    for (const line of lines) {
      if (opts.signal?.aborted) return;
      yield line;
    }
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    this.inspectCalls.push(id);
    const found = this.inspected.get(id);
    if (!found) throw new Error(`no such container: ${id}`);
    return found;
  }

  async inspectImage(ref: string): Promise<ImageInspect | null> {
    const error = this.inspectImageErrors.get(ref);
    if (error) throw error;
    return this.images.get(ref) ?? null;
  }

  runCompose(target: ComposeTarget, args: string[]): JobHandle {
    this.composeCalls.push({ target, args });
    const scripted = this.composeResults.get(args.join(" ")) ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    const queue = new ChunkQueue();
    let cancelled = false;

    const result = (async (): Promise<ComposeResult> => {
      if (this.composeGate) await this.composeGate;
      if (cancelled) {
        queue.close();
        return { exitCode: 143, stdout: "", stderr: "cancelled" };
      }
      for (const piece of splitIntoChunks(scripted.stdout, this.composeChunkCount)) {
        queue.push({ text: piece, stream: "stdout" });
        // Yield to the event loop so streaming tests can attach mid-job.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (scripted.stderr !== "") queue.push({ text: scripted.stderr, stream: "stderr" });
      queue.close();
      return scripted;
    })();

    return {
      output: queue,
      result,
      cancel: () => {
        cancelled = true;
        this.releaseCompose();
      },
    };
  }
}

export async function buildTestApp(): Promise<TestApp> {
  const config = loadConfig({
    HOMESTEAD_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
    HOMESTEAD_BASE_URL: "http://localhost:3000",
    NODE_ENV: "test",
  });
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await ensureLocalHost(db, config);
  const secrets = new SecretStore(db, config.secretKey);
  const host = new FakeHost();
  const auth = createAuth(config, db);
  const composeConfig = new ComposeConfigCache(host);
  const jobs = new JobRunner({ db, host, composeConfig });
  const registryDigests = new Map<string, string>();
  const images = new ImageUpdateChecker({
    db,
    host,
    composeConfig,
    registry: { latestDigest: async (image) => registryDigests.get(image) ?? null },
  });
  const app = await buildApp({ config, db, host, secrets, auth, composeConfig, jobs, images });

  // Assign each app instance its own source address to avoid rate-limit bucket
  // collisions. Better-Auth's sign-in rate limiter is process-global and keyed by IP.
  const instanceIp = getUniqueTestIp();
  const originalInject = app.inject.bind(app);

  // Wrap inject to default remoteAddress to this instance's IP when not specified.
  // Preserve the method's type signature and allow tests that need a specific address
  // to override (X-Forwarded-For forgery test, rate-limit regression test, etc.).
  // biome-ignore lint/suspicious/noExplicitAny: Complex overloaded Fastify signature
  (app as any).inject = (opts?: any, cb?: any) => {
    if (typeof opts === "object" && opts && !("remoteAddress" in opts)) {
      return originalInject({ ...opts, remoteAddress: instanceIp }, cb);
    }
    return originalInject(opts, cb);
  };

  const testApp = app as TestApp;
  testApp.deps.registryDigests = registryDigests;
  return testApp;
}

const TEST_PASSWORD = "correct-horse-battery";

let ipCounter = 1;
/** Generate a unique test IP address. Better-Auth's rate limiter is process-global and
 * keyed by IP, so every test client needs its own address to avoid shared bucket exhaustion. */
function getUniqueTestIp(): string {
  return `198.18.${Math.floor(ipCounter / 256)}.${ipCounter++ % 256}`;
}

export async function signUpAdmin(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    payload: { email: "admin@example.com", password: TEST_PASSWORD, name: "Admin" },
  });
  const cookie = String(res.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { cookie },
  });
  return { cookie, id: me.json().id as string };
}

export async function createViewer(
  app: FastifyInstance,
  adminCookie: string,
  scope: { scopeAllApps: boolean; appIds?: string[] } = { scopeAllApps: true },
) {
  const email = `viewer-${Math.random().toString(36).slice(2)}@example.com`;
  const created = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie: adminCookie },
    payload: {
      email,
      password: TEST_PASSWORD,
      name: "Viewer",
      role: "viewer",
      scopeAllApps: scope.scopeAllApps,
      appIds: scope.appIds ?? [],
    },
  });
  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: TEST_PASSWORD },
  });
  return {
    id: created.json().id as string,
    cookie: String(signIn.headers["set-cookie"] ?? "").split(";")[0] ?? "",
  };
}
