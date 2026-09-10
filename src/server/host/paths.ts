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

  private assertInitialised(): void {
    if (this.roots.length === 0) throw new Error("PathGuard.init() was not awaited");
  }

  /** Resolves a path that must already exist, following symlinks before the check. */
  async resolveExisting(rel: string): Promise<string> {
    this.assertInitialised();
    if (isAbsolute(rel)) throw new PathEscapeError(rel);
    const configuredRoot = this.roots[0];
    if (!configuredRoot) throw new Error("PathGuard.init() was not awaited");
    const candidate = resolve(configuredRoot, rel);
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
   * Resolves a path that may not exist yet. The parent directory must exist and
   * must itself resolve inside the root, so a symlinked parent cannot be used to
   * write outside.
   */
  async resolveForWrite(rel: string): Promise<string> {
    this.assertInitialised();
    if (isAbsolute(rel)) throw new PathEscapeError(rel);
    const configuredRoot = this.roots[0];
    if (!configuredRoot) throw new Error("PathGuard.init() was not awaited");
    const candidate = resolve(configuredRoot, rel);
    let realParent: string;
    try {
      realParent = await realpath(dirname(candidate));
    } catch {
      throw new PathEscapeError(rel);
    }
    if (!this.roots.some((r) => isInside(realParent, r))) throw new PathEscapeError(rel);
    return resolve(realParent, basename(candidate));
  }
}
