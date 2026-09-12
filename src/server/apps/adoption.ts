import type { DiscoveredApp, OrphanStack, ScanResult } from "@shared/admin.js";
import { parseEnv } from "@shared/env-file.js";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apps } from "../db/schema.js";
import type { Host } from "../host/types.js";

export type { DiscoveredApp, OrphanStack, ScanResult };

/**
 * Compose's own project-name normalisation: lowercased, and anything outside
 * `[a-z0-9_-]` dropped, with leading separators trimmed.
 *
 * `My Media` becomes `mymedia`. Comparing the raw directory name against a container
 * label therefore never matches for any directory with a capital or a space, and the
 * consequence is not a missing field — the stack reports `running: false` while its
 * containers appear separately as an orphan. One real directory produces two wrong
 * rows.
 */
export function normaliseProjectName(directory: string): string {
  return directory
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+/, "");
}
// Two names this cannot resolve, both left as they are on purpose:
//
// A name with nothing left after stripping — `Медиа`, `...` — normalises to `''`, which
// never matches, so the directory reads as stopped and its containers list as an orphan.
// That is the honest answer rather than a bug: compose refuses to derive a project name
// from such a directory at all, so whatever is running was started with an explicit name
// only the user knows. `byProject` never holds `''` because unlabelled containers are
// skipped, so the empty lookup is inert.
//
// Two directories can normalise to the same name — `my_media` and `MY_MEDIA` — and both
// then report the same containers. Measured, and faithful: compose treats them as one
// project, so `up` in either directory really does control the same stack. Flagging it
// would need a UI affordance that does not exist yet.

/**
 * The project name compose would use for a directory that Homestead has not adopted.
 *
 * `COMPOSE_PROJECT_NAME` in the sibling `.env` overrides the directory name outright,
 * and it is common in stacks copied from a tutorial. Missing it produces the same
 * two-wrong-rows failure as skipping normalisation. Reading one small file per
 * directory is the cheap way to be right; the alternative is a `docker compose config`
 * subprocess per directory, which on a NAS with thirty stacks is thirty processes for
 * a screen the user opens to look around.
 *
 * A missing or unreadable `.env` is the normal case and falls back to the directory.
 */
async function inferProjectName(host: Host, directory: string): Promise<string> {
  try {
    const { content } = await host.readTextFile(`${directory}/.env`);
    const entry = parseEnv(content).find(
      (e) => e.kind === "pair" && e.key === "COMPOSE_PROJECT_NAME",
    );
    if (entry?.kind === "pair" && entry.value !== "") return entry.value;
  } catch {
    // No `.env`, or one we cannot read. Neither is an error worth failing a scan over.
  }
  return normaliseProjectName(directory);
}

/**
 * Joins directories on disk to containers labelled with a compose project.
 *
 * The project name is never the raw directory name. Compose normalises it and a
 * `COMPOSE_PROJECT_NAME` in `.env` overrides it entirely, so a naive comparison
 * reports a healthy stack as stopped AND lists its containers as an orphan. An
 * already-adopted app uses its recorded name, which adoption resolved properly.
 */
export async function scanForApps(deps: {
  db: Db;
  host: Host;
  hostId: string;
}): Promise<ScanResult> {
  const [directories, containers, adoptedRows] = await Promise.all([
    deps.host.listAppDirectories(),
    deps.host.listContainers(),
    deps.db.select().from(apps).where(eq(apps.hostId, deps.hostId)),
  ]);

  const adoptedByDirectory = new Map(adoptedRows.map((row) => [row.directory, row]));
  const adoptedProjects = new Set(adoptedRows.map((row) => row.projectName));

  const byProject = new Map<string, typeof containers>();
  for (const c of containers) {
    if (!c.project) continue;
    const list = byProject.get(c.project) ?? [];
    list.push(c);
    byProject.set(c.project, list);
  }

  const claimedProjects = new Set<string>();

  const candidates = await Promise.all(
    directories.map(async (dir) => {
      const recorded = adoptedByDirectory.get(dir.directory)?.projectName;
      // An adopted app's recorded name wins: adoption resolved it through the CLI, so
      // it is authoritative even when `.env` has since changed underneath us.
      return recorded ?? (await inferProjectName(deps.host, dir.directory));
    }),
  );

  const discovered: DiscoveredApp[] = directories.map((dir, i) => {
    const adoptedRow = adoptedByDirectory.get(dir.directory);
    const candidate = candidates[i] ?? dir.directory;
    const matched = byProject.get(candidate);
    if (matched) claimedProjects.add(candidate);

    return {
      directory: dir.directory,
      composeFile: dir.composeFile,
      projectName: matched ? candidate : (adoptedRow?.projectName ?? null),
      containerCount: matched?.length ?? 0,
      running: (matched ?? []).some((c) => c.state === "running"),
      adopted: adoptedRow !== undefined,
    };
  });

  const orphans: OrphanStack[] = [...byProject.entries()]
    .filter(([project]) => !claimedProjects.has(project) && !adoptedProjects.has(project))
    .map(([projectName, list]) => ({ projectName, containerCount: list.length }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));

  return { discovered, orphans };
}
