import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projectIdentity } from "../db/schema.js";

/** How a project is presented. Every field optional; absent is the same as empty. */
export type ProjectIdentity = {
  displayName: string | null;
  description: string | null;
  iconSlug: string | null;
  iconUrl: string | null;
};

function toIdentity(row: typeof projectIdentity.$inferSelect): ProjectIdentity {
  return {
    displayName: row.displayName,
    description: row.description,
    iconSlug: row.iconSlug,
    iconUrl: row.iconUrl,
  };
}

export async function readIdentity(
  db: Db,
  slug: string,
): Promise<ProjectIdentity | null> {
  const [row] = await db
    .select()
    .from(projectIdentity)
    .where(eq(projectIdentity.slug, slug));
  return row ? toIdentity(row) : null;
}

/**
 * Identity for many projects at once, keyed by slug.
 *
 * The list view needs one lookup, not one per row: a directory of thirty
 * stacks would otherwise issue thirty queries to render a page.
 */
export async function readIdentities(
  db: Db,
  slugs: string[],
): Promise<Map<string, ProjectIdentity>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select()
    .from(projectIdentity)
    .where(inArray(projectIdentity.slug, slugs));
  return new Map(rows.map((r) => [r.slug, toIdentity(r)]));
}

export async function writeIdentity(
  db: Db,
  slug: string,
  patch: Partial<ProjectIdentity>,
  now = Date.now(),
): Promise<void> {
  const values = {
    slug,
    displayName: patch.displayName ?? null,
    description: patch.description ?? null,
    iconSlug: patch.iconSlug ?? null,
    iconUrl: patch.iconUrl ?? null,
    updatedAt: now,
  };
  await db
    .insert(projectIdentity)
    .values(values)
    .onConflictDoUpdate({ target: projectIdentity.slug, set: values });
}

/**
 * Called when a project directory is deleted.
 *
 * Without this, a directory recreated under the same slug inherits whatever
 * the previous one was called — a stranger's description on someone's new
 * project.
 */
export async function deleteIdentity(db: Db, slug: string): Promise<void> {
  await db.delete(projectIdentity).where(eq(projectIdentity.slug, slug));
}
