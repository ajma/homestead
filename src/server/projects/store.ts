import type { Dirent } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ScanEntry } from "@shared/projects.js";

/** Compose's own precedence order. */
const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

/** Re-exported for the server's own callers; defined in the shared boundary. */
export type { ScanEntry };

export function isValidSlug(slug: string): boolean {
  return (
    /^[a-z0-9][a-z0-9._-]*$/i.test(slug) &&
    !slug.startsWith(".") &&
    !slug.includes("..")
  );
}

export function projectPath(projectsDir: string, slug: string): string {
  if (!isValidSlug(slug))
    throw new Error(`invalid project slug: ${JSON.stringify(slug)}`);
  const path = resolve(projectsDir, slug);
  if (path !== join(projectsDir, slug))
    throw new Error(`slug escapes the projects root: ${slug}`);
  return path;
}

export async function findComposeFile(dir: string): Promise<string | null> {
  for (const name of COMPOSE_FILENAMES) {
    try {
      await stat(join(dir, name));
      return name;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export async function scanProjects(projectsDir: string): Promise<ScanEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: ScanEntry[] = [];
  for (const dirent of dirents) {
    // Accept a directory or a symlink that resolves to a directory
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        const stats = await stat(join(projectsDir, dirent.name));
        isDir = stats.isDirectory();
      } catch {
        // broken symlink, skip it
      }
    }
    if (!isDir) continue;

    if (dirent.name.startsWith(".")) continue;
    const path = join(projectsDir, dirent.name);
    const composeFile = await findComposeFile(path);
    const hasEnv = await stat(join(path, ".env")).then(
      () => true,
      () => false,
    );
    entries.push({
      slug: dirent.name,
      hasCompose: composeFile !== null,
      hasEnv,
      composeFile,
    });
  }
  return entries.sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
}

/**
 * `null` means the file genuinely is not there. Anything else — EACCES on an
 * ACL'd NAS share, EISDIR, EIO — is thrown, because reporting a permissions
 * problem as "not found" sends the operator looking for the wrong bug.
 */
export async function readProjectFile(
  projectsDir: string,
  slug: string,
  file: "compose" | "env",
): Promise<string | null> {
  const dir = projectPath(projectsDir, slug);
  const name = file === "env" ? ".env" : await findComposeFile(dir);
  if (name === null) return null;
  try {
    return await readFile(join(dir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Per base filename, not across all of them — see {@link pruneSnapshots}. */
export const SNAPSHOT_RETENTION = 10;

/** Sortable, filesystem-safe, and monotonic within a process. */
let snapshotCounter = 0;
function snapshotName(base: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = String(snapshotCounter++).padStart(4, "0");
  return `${stamp}-${seq}-${base}`;
}

/** `<iso-stamp>-<seq>-<base>` → `<base>`, or null for a name we did not write. */
const SNAPSHOT_NAME =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{4,}-(.+)$/;

export function snapshotBase(name: string): string | null {
  return SNAPSHOT_NAME.exec(name)?.[1] ?? null;
}

export async function listSnapshots(
  projectsDir: string,
  slug: string,
): Promise<string[]> {
  const dir = join(projectPath(projectsDir, slug), ".snapshots");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.sort().reverse();
}

/**
 * Retains the newest {@link SNAPSHOT_RETENTION} snapshots *per base filename*.
 *
 * A combined cap silently destroys the thing snapshots exist for: ten edits to
 * `.env` would evict every compose snapshot, so the undo for a wrong edit to a
 * stack holding family photos disappears because someone retyped a password.
 * Names we did not generate are left alone rather than counted or deleted.
 */
async function pruneSnapshots(snapDir: string, names: string[]): Promise<void> {
  const byBase = new Map<string, string[]>();
  for (const name of names) {
    const base = snapshotBase(name);
    if (base === null) continue;
    const group = byBase.get(base);
    if (group) group.push(name);
    else byBase.set(base, [name]);
  }
  for (const group of byBase.values()) {
    // `names` arrives newest-first from listSnapshots, so the group is too.
    for (const stale of group.slice(SNAPSHOT_RETENTION)) {
      await rm(join(snapDir, stale), { force: true });
    }
  }
}

export async function writeProjectFile(
  projectsDir: string,
  slug: string,
  file: "compose" | "env",
  content: string,
): Promise<void> {
  const dir = projectPath(projectsDir, slug);
  const name =
    file === "env"
      ? ".env"
      : ((await findComposeFile(dir)) ?? "docker-compose.yml");
  const target = join(dir, name);

  const existed = await stat(target).then(
    () => true,
    () => false,
  );
  if (existed) {
    const snapDir = join(dir, ".snapshots");
    await mkdir(snapDir, { recursive: true });
    await copyFile(target, join(snapDir, snapshotName(name)));
    await pruneSnapshots(snapDir, await listSnapshots(projectsDir, slug));
  }

  const tmp = `${target}.tmp-${process.pid}-${snapshotCounter++}`;
  try {
    await writeFile(tmp, content, "utf8");
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
