import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  constructor(rel: string) {
    super(`Path escapes the compose root: ${rel}`);
    this.name = "PathEscapeError";
  }
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

export class PathGuard {
  private roots: string[] = [];

  constructor(private readonly configuredRoot: string) {}

  /** Resolves the configured root once. Both the configured and real paths are accepted. */
  async init(): Promise<void> {
    const configured = resolve(this.configuredRoot);
    const real = await realpath(configured);
    this.roots = configured === real ? [configured] : [configured, real];
  }

  /**
   * Returns the configured root, proving initialisation in the same step.
   * Returning the value rather than asserting a side condition is what lets callers
   * avoid both a non-null assertion (which Biome's noNonNullAssertion rejects) and a
   * redundant second undefined check.
   */
  private requireRoot(): string {
    const root = this.roots[0];
    if (!root) throw new Error("PathGuard.init() was not awaited");
    return root;
  }

  /** Rejects paths that address the root itself rather than something within it. */
  private assertAddressesChild(rel: string): void {
    const trimmed = rel.trim();
    if (trimmed === "" || trimmed === "." || trimmed === "./") throw new PathEscapeError(rel);
  }

  /** Resolves a path that must already exist, following symlinks before the check. */
  async resolveExisting(rel: string): Promise<string> {
    if (isAbsolute(rel)) throw new PathEscapeError(rel);
    this.assertAddressesChild(rel);
    const candidate = resolve(this.requireRoot(), rel);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new PathEscapeError(rel);
    }
    if (!this.roots.some((r) => isInside(real, r))) throw new PathEscapeError(rel);
    return real;
  }

  /**
   * Resolves a path that may not exist yet. Two separate checks are required:
   * the parent directory must resolve inside the root, AND if the target itself
   * already exists it must also resolve inside the root.
   */
  async resolveForWrite(rel: string): Promise<string> {
    if (isAbsolute(rel)) throw new PathEscapeError(rel);
    this.assertAddressesChild(rel);
    const candidate = resolve(this.requireRoot(), rel);

    // Check 1: the parent must exist and resolve inside the root. Stops
    // `escape -> /etc` being used to write `escape/newfile`.
    let realParent: string;
    try {
      realParent = await realpath(dirname(candidate));
    } catch {
      throw new PathEscapeError(rel);
    }
    if (!this.roots.some((r) => isInside(realParent, r))) throw new PathEscapeError(rel);

    // Check 2: if the target already exists, IT must resolve inside the root too.
    // A legitimate parent can still contain a symlink pointing anywhere — planting
    // `app/.env -> /etc/cron.d/x` passes check 1 and would otherwise be written through.
    // A target that does not exist yet is fine; that is the normal create case.
    try {
      const realTarget = await realpath(candidate);
      if (!this.roots.some((r) => isInside(realTarget, r))) throw new PathEscapeError(rel);
    } catch (error) {
      if (error instanceof PathEscapeError) throw error;
      // ENOENT: target does not exist yet. Proceed.
    }

    return resolve(realParent, basename(candidate));
  }
}
