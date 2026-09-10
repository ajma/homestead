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

type ParseOutcome = { ok: true; resolved: ResolvedCompose } | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Parses `docker compose config --format json` defensively.
 *
 * Everything here is a guard against a measured failure, not hypothetical caution.
 * Against the previous version: malformed JSON and empty stdout threw `SyntaxError`,
 * a `null` service threw `TypeError`, and — worst — `"services": "nope"` returned
 * `valid: true` carrying four bogus services, because `Object.entries` on a string
 * enumerates its characters. This function returns a result; it never throws.
 *
 * A service entry that is not an object FAILS the parse rather than being filtered
 * out. Dropping it would shrink the expected service set, and Task 7 rolls container
 * states up against that set — so a silently missing service would report a degraded
 * stack as healthy. Failing closed is the only safe direction here.
 */
function parseResolved(stdout: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { ok: false, message: "docker compose config produced output that is not JSON" };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, message: "docker compose config produced JSON that is not an object" };
  }

  const rawServices = raw.services ?? {};
  if (!isPlainObject(rawServices)) {
    return { ok: false, message: "docker compose config reported `services` as a non-object" };
  }

  const services: ResolvedService[] = [];
  for (const [name, service] of Object.entries(rawServices)) {
    if (!isPlainObject(service)) {
      return {
        ok: false,
        message: `docker compose config reported service "${name}" as a non-object`,
      };
    }
    // Ports are advisory — they feed launch-URL suggestions, not correctness — so a
    // shape Number() cannot read is dropped rather than failing the whole resolve.
    // Measured: "8080-8090" and "127.0.0.1:9000" both yield NaN and are discarded.
    const rawPorts = Array.isArray(service.ports) ? service.ports : [];
    const publishedPorts = rawPorts
      .map((entry) => (isPlainObject(entry) ? Number(entry.published) : Number.NaN))
      .filter((port) => Number.isFinite(port) && port > 0);

    services.push({
      name,
      image: stringOrNull(service.image),
      restart: stringOrNull(service.restart),
      publishedPorts,
    });
  }

  return { ok: true, resolved: { projectName: stringOrNull(raw.name) ?? "", services } };
}

/**
 * Override filenames the compose CLI reads automatically, in fixed order for hash
 * stability. Iterating a directory read would produce a nondeterministic hash.
 */
const OVERRIDE_FILENAMES = [
  "compose.override.yaml",
  "compose.override.yml",
  "docker-compose.override.yaml",
  "docker-compose.override.yml",
];

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

  /**
   * Unambiguous key. Template concatenation collides across the path boundary —
   * measured: `{directory:'foo', composeFile:'bar/compose.yaml'}` and
   * `{directory:'foo/bar', composeFile:'compose.yaml'}` produced the same key, and the
   * second target received the first's cached config with `valid: true`.
   */
  private key(target: ComposeTarget): string {
    return JSON.stringify([target.directory, target.composeFile]);
  }

  invalidate(target: ComposeTarget): void {
    this.entries.delete(this.key(target));
  }

  /**
   * Hash of every file the CLI's output depends on.
   *
   * The compose file is not the only input: compose resolves `COMPOSE_PROJECT_NAME`
   * and `${VAR}` interpolation from the sibling `.env`, both measured, and reads
   * override files automatically. Hashing only `compose.yaml` would serve a stale
   * service set after an SSH edit to `.env` or an override — and out-of-band edits are
   * precisely the case content hashing exists to catch. Missing files are normal and
   * contribute a constant.
   *
   * An unreadable file must NOT hash the same as an absent one. A single `'absent'`
   * for every failure breaks the invariant the hash exists to hold — that distinct
   * input states produce distinct hashes — and the transition is reachable: resolve
   * once with no `.env` (cached as absent), then have one appear that Homestead cannot
   * read. The hashes match, the cache hits, and a stale `valid: true` is served for a
   * stack whose real resolve would now fail. The error's own text is the marker.
   *
   * The marker is coarser than it looks, because `PathGuard.resolveExisting` throws the
   * same `PathEscapeError` for a missing file and for one that resolves outside the
   * compose root. So a `.env` symlinked out of the root still reads as absent here,
   * while the compose CLI — which has no such guard — happily interpolates from it.
   * Narrowing that needs an explicit existence check on `Host`; it is not this task.
   */
  private async inputHash(target: ComposeTarget): Promise<string> {
    const compose = await this.host.readTextFile(`${target.directory}/${target.composeFile}`);
    const env = await this.host
      .readTextFile(`${target.directory}/.env`)
      .then((file) => file.hash)
      .catch(
        (error: unknown) => `unreadable:${error instanceof Error ? error.message : String(error)}`,
      );

    // Override filenames are iterated in fixed order, not discovered via directory read,
    // so the hash is stable across calls.
    const overrides: string[] = [];
    for (const filename of OVERRIDE_FILENAMES) {
      const hash = await this.host
        .readTextFile(`${target.directory}/${filename}`)
        .then((file) => file.hash)
        .catch((error: unknown) =>
          error instanceof Error ? `unreadable:${error.message}` : String(error),
        );
      overrides.push(hash);
    }

    return `${compose.hash}:${env}:${overrides.join(":")}`;
  }

  async resolve(target: ComposeTarget): Promise<ComposeValidation> {
    const key = this.key(target);
    const hash = await this.inputHash(target);

    const cached = this.entries.get(key);
    if (cached && cached.hash === hash) return { valid: true, resolved: cached.resolved };

    const result = await this.host.runCompose(target, ["config", "--format", "json"]).result;

    if (result.exitCode !== 0) {
      // Deliberately not cached. A failure is a state the user is actively fixing, and
      // caching it would make the editor report a stale error after a correct save.
      this.entries.delete(key);
      return { valid: false, message: (result.stderr || result.stdout).trim() };
    }

    const parsed = parseResolved(result.stdout);
    if (!parsed.ok) {
      // Same reasoning as an exit-code failure: not cached, and surfaced as a result
      // rather than thrown, because callers destructure a discriminated union.
      this.entries.delete(key);
      return { valid: false, message: parsed.message };
    }

    this.entries.set(key, { hash, resolved: parsed.resolved });
    return { valid: true, resolved: parsed.resolved };
  }
}
