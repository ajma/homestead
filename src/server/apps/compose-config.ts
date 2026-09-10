import type { ComposeTarget, Host } from "../host/types.js";

export type ResolvedService = {
  name: string;
  image: string | null;
  restart: string | null;
  publishedPorts: number[];
};

export type ResolvedCompose = { projectName: string; services: ResolvedService[] };

export type ComposeValidation =
  | { valid: true; resolved: ResolvedCompose }
  | { valid: false; message: string };

type RawService = {
  image?: string;
  restart?: string;
  ports?: Array<{ published?: string | number }>;
};

function parseResolved(stdout: string): ResolvedCompose {
  const raw = JSON.parse(stdout) as { name?: string; services?: Record<string, RawService> };
  const services = Object.entries(raw.services ?? {}).map(([name, service]) => ({
    name,
    image: service.image ?? null,
    restart: service.restart ?? null,
    publishedPorts: (service.ports ?? [])
      .map((p) => Number(p.published))
      .filter((p) => Number.isFinite(p) && p > 0),
  }));
  return { projectName: raw.name ?? "", services };
}

/**
 * Resolves `docker compose config` and caches the result against the compose file's
 * hash.
 *
 * The CLI is the only correct implementation of compose semantics — it resolves
 * `COMPOSE_PROJECT_NAME` from the sibling `.env`, applies override files and `extends`,
 * interpolates `${VAR}`, and omits services behind inactive profiles. All four were
 * measured. Hand-parsing the YAML would get every one of them wrong.
 *
 * Caching matters because this runs a subprocess: the status rollup consults it on
 * every read, and spawning a process per request would make the app list quadratic in
 * cost on a NAS.
 */
export class ComposeConfigCache {
  private readonly entries = new Map<string, { hash: string; resolved: ResolvedCompose }>();

  constructor(private readonly host: Host) {}

  private key(target: ComposeTarget): string {
    return `${target.directory}/${target.composeFile}`;
  }

  invalidate(target: ComposeTarget): void {
    this.entries.delete(this.key(target));
  }

  async resolve(target: ComposeTarget): Promise<ComposeValidation> {
    const key = this.key(target);
    const { hash } = await this.host.readTextFile(key);

    const cached = this.entries.get(key);
    if (cached && cached.hash === hash) return { valid: true, resolved: cached.resolved };

    const result = await this.host.runCompose(target, ["config", "--format", "json"]);

    if (result.exitCode !== 0) {
      // Deliberately not cached. A failure is a state the user is actively fixing, and
      // caching it would make the editor report a stale error after a correct save.
      this.entries.delete(key);
      return { valid: false, message: (result.stderr || result.stdout).trim() };
    }

    const resolved = parseResolved(result.stdout);
    this.entries.set(key, { hash, resolved });
    return { valid: true, resolved };
  }
}
