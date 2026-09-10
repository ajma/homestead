import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { ComposeConfigCache } from "./apps/compose-config.js";
import { createAuth } from "./auth/auth.js";
import { ensureLocalHost } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { SecretStore } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import { COMPOSE_FILENAMES, hashContent } from "./host/local-host.js";
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
  listContainersCalls = 0;

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

  async listContainers(filters?: { project?: string }): Promise<ContainerSummary[]> {
    this.listContainersCalls++;
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
  await ensureLocalHost(db, config);
  const secrets = new SecretStore(db, config.secretKey);
  const host = new FakeHost();
  const auth = createAuth(config, db);
  const composeConfig = new ComposeConfigCache(host);
  return buildApp({ config, db, host, secrets, auth, composeConfig });
}

const TEST_PASSWORD = "correct-horse-battery";

export async function signUpAdmin(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    payload: { email: "admin@example.com", password: TEST_PASSWORD, name: "Admin" },
  });
  const cookie = String(res.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
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
