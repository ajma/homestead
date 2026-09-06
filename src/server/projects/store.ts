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

/** Compose's own precedence order. */
const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

export type ScanEntry = {
  slug: string;
  path: string;
  hasCompose: boolean;
  hasEnv: boolean;
  composeFile: string | null;
};

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
      path,
      hasCompose: composeFile !== null,
      hasEnv,
      composeFile,
    });
  }
  return entries.sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
}

export async function readProjectFile(
  projectsDir: string,
  slug: string,
  file: "compose" | "env",
): Promise<string | null> {
  const dir = projectPath(projectsDir, slug);
  const name = file === "env" ? ".env" : await findComposeFile(dir);
  if (name === null) return null;
  return readFile(join(dir, name), "utf8").catch(() => null);
}

export const SNAPSHOT_RETENTION = 10;

/** Sortable, filesystem-safe, and monotonic within a process. */
let snapshotCounter = 0;
function snapshotName(base: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = String(snapshotCounter++).padStart(4, "0");
  return `${stamp}-${seq}-${base}`;
}

export async function listSnapshots(
  projectsDir: string,
  slug: string,
): Promise<string[]> {
  const dir = join(projectPath(projectsDir, slug), ".snapshots");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.sort().reverse();
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
    const snaps = await listSnapshots(projectsDir, slug);
    for (const stale of snaps.slice(SNAPSHOT_RETENTION)) {
      await rm(join(snapDir, stale), { force: true });
    }
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
