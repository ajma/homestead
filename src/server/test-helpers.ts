import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SecretStore } from "./crypto/secrets.js";
import { createDb, runMigrations } from "./db/client.js";
import type { ContainerSummary, DiscoveredDir, FileRead, Host } from "./host/types.js";

export class FakeHost implements Host {
  readonly id = "test";
  files = new Map<string, string>();
  containers: ContainerSummary[] = [];

  async listAppDirectories(): Promise<DiscoveredDir[]> {
    return [];
  }
  async readTextFile(rel: string): Promise<FileRead> {
    const content = this.files.get(rel);
    if (content === undefined) throw new Error(`no such file: ${rel}`);
    const { hashContent } = await import("./host/local-host.js");
    return { content, hash: hashContent(content) };
  }
  async writeTextFile(rel: string, content: string): Promise<{ hash: string }> {
    this.files.set(rel, content);
    const { hashContent } = await import("./host/local-host.js");
    return { hash: hashContent(content) };
  }
  async listContainers(): Promise<ContainerSummary[]> {
    return this.containers;
  }
  async inspectContainer(): Promise<unknown> {
    return {};
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
  return buildApp({ config, db, host, secrets });
}
