import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { scanForApps } from "../apps/adoption.js";
import { toAdminApp, toViewerApp } from "../apps/serialize.js";
import { rollUpStatus } from "../apps/status.js";
import { audit } from "../audit.js";
import { can, requireCapability, visibleAppsWhere } from "../auth/context.js";
import { LOCAL_HOST_ID } from "../bootstrap.js";
import { apps } from "../db/schema.js";
import type { ContainerSummary } from "../host/types.js";
import { HashMismatchError } from "../host/types.js";

const adoptBody = z.object({ directories: z.array(z.string().min(1)).min(1) });

const patchBody = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  iconRef: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  launchInternalUrl: z.string().nullable().optional(),
  showOnLauncher: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const composeWriteBody = z.object({
  content: z.string(),
  expectedHash: z.string().nullable(),
});

/** A URL-safe slug: lowercase, anything outside `[a-z0-9-]` dropped. */
function normaliseSlug(directory: string): string {
  return directory.toLowerCase().replace(/[^a-z0-9-]/g, "") || "app";
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  const { db, host, composeConfig } = app.deps;

  /**
   * Resolves candidate compose content without touching the app's real file.
   *
   * Compose only reads from a path, so the content goes to a scratch file beside the
   * real one — the same directory, so `.env` interpolation and the derived project name
   * resolve exactly as they will after the save.
   *
   * The name carries a ULID for two reasons. A fixed name races: the editor validates on
   * a debounce, so two calls for one app overlap routinely, and the first one's `finally`
   * deletes the file the second is mid-resolve on. And the cache is keyed by path, so a
   * fixed name would serve one keystroke's verdict for the next; a unique name plus the
   * `invalidate` below keeps the cache from growing by one permanent entry per keystroke.
   */
  async function validateContent(
    directory: string,
    content: string,
  ): Promise<{ valid: true } | { valid: false; message: string }> {
    const composeFile = `.homestead-validate-${ulid()}.yaml`;
    const target = { directory, composeFile };
    await host.writeTextFile(`${directory}/${composeFile}`, content, null);
    try {
      const check = await composeConfig.resolve(target);
      return check.valid ? { valid: true } : { valid: false, message: check.message };
    } finally {
      composeConfig.invalidate(target);
      // Cleanup is best effort, and a throw here would REPLACE whatever the try block was
      // reporting — including a real failure from `resolve`, which the user would then see
      // as an unrelated filesystem error. A dotfile compose ignores is a much smaller
      // problem than a masked diagnosis.
      try {
        await host.deleteFile(`${directory}/${composeFile}`);
      } catch {
        // Left behind. Accepted: see the note on abnormal termination below.
      }
    }
  }

  // A scratch file also survives an abnormal termination between the write and the
  // `finally` — SIGKILL, or the container being stopped mid-validation. Accepted rather
  // than swept at startup: it is a dotfile, `docker compose` does not pick it up, and a
  // sweep would need a list-files-in-a-directory primitive on `Host` that nothing else
  // wants yet. Carried forward instead.

  /**
   * Current status for one app.
   *
   * `containers` is passed in by the list route, which fetches once for every app.
   * Letting each row call `listContainers` itself meant one Docker API round trip per
   * app on a screen that shows all of them — thirty on this NAS, every page load.
   */
  async function statusFor(row: typeof apps.$inferSelect, containers?: ContainerSummary[]) {
    const target = { directory: row.directory, composeFile: row.composeFile };
    const resolved = await composeConfig.resolve(target);
    if (!resolved.valid) {
      // `resolved.message` is raw `docker compose config` stderr. It routinely carries
      // absolute paths and interpolated `.env` values, so it goes in `adminDetail` and
      // the viewer gets a description instead.
      return {
        status: "unknown" as const,
        detail: "compose configuration is invalid",
        adminDetail: resolved.message,
      };
    }
    const found = containers ?? (await host.listContainers({ project: row.projectName ?? "" }));
    return rollUpStatus(resolved.resolved.services, found);
  }

  /**
   * A slug no other app on this host holds.
   *
   * `apps_host_slug` is unique, and `normaliseSlug` is lossy — `My Media` and
   * `my-media` both become `mymedia`, as does any directory of pure punctuation via
   * the `'app'` fallback. Without this, adopting the second one raises a constraint
   * violation that surfaces as a 500 in the middle of a multi-directory adopt, losing
   * the successes alongside it.
   */
  async function uniqueSlug(directory: string): Promise<string> {
    const base = normaliseSlug(directory);
    const rows = await db
      .select({ slug: apps.slug })
      .from(apps)
      .where(eq(apps.hostId, LOCAL_HOST_ID));
    const taken = new Set(rows.map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    // A thousand collisions on one base is not a real filesystem; fall back to
    // something certainly unique rather than looping forever.
    return `${base}-${ulid().toLowerCase()}`;
  }

  app.get("/api/apps/scan", async (request) => {
    requireCapability(request, "app:config");
    return scanForApps({ db, host, hostId: LOCAL_HOST_ID });
  });

  app.post("/api/apps/adopt", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const body = adoptBody.parse(request.body);

    const adopted: unknown[] = [];
    const failed: Array<{ directory: string; message: string }> = [];
    let anyConflict = false;

    for (const directory of body.directories) {
      const existing = await db
        .select()
        .from(apps)
        .where(and(eq(apps.hostId, LOCAL_HOST_ID), eq(apps.directory, directory)));
      if (existing.length > 0) {
        anyConflict = true;
        failed.push({ directory, message: "already adopted" });
        continue;
      }

      const discovered = (await host.listAppDirectories()).find((d) => d.directory === directory);
      if (!discovered) {
        failed.push({ directory, message: "no compose file found" });
        continue;
      }

      const target = { directory, composeFile: discovered.composeFile };
      const resolved = await composeConfig.resolve(target);
      if (!resolved.valid) {
        failed.push({ directory, message: resolved.message });
        continue;
      }

      // An empty project name would match no container for the life of the app, so it
      // would read as permanently down. Better to refuse the adoption and say why.
      if (resolved.resolved.projectName === "") {
        failed.push({ directory, message: "compose reported no project name" });
        continue;
      }

      const { hash } = await host.readTextFile(`${directory}/${discovered.composeFile}`);
      const id = ulid();
      try {
        await db.insert(apps).values({
          id,
          hostId: LOCAL_HOST_ID,
          slug: await uniqueSlug(directory),
          displayName: directory,
          directory,
          composeFile: discovered.composeFile,
          // From `docker compose config`, which already honours COMPOSE_PROJECT_NAME in
          // the sibling .env. Deriving it from the directory name would be wrong.
          projectName: resolved.resolved.projectName,
          lastComposeHash: hash,
        });
      } catch (error) {
        // `apps_host_slug` and `apps_host_directory` are unique. A concurrent adopt can
        // still lose the race that `uniqueSlug` narrows, and an uncaught violation here
        // would 500 the whole request, discarding the directories that did succeed.
        failed.push({
          directory,
          message: error instanceof Error ? error.message : "insert failed",
        });
        continue;
      }

      const [row] = await db.select().from(apps).where(eq(apps.id, id));
      if (row) adopted.push(toAdminApp(row, await statusFor(row)));
      await audit(db, ctx, {
        action: "app.adopted",
        targetType: "app",
        targetId: id,
        ip: request.ip,
      });
    }

    if (adopted.length === 0) {
      return reply.code(anyConflict ? 409 : 422).send({ adopted, failed });
    }
    return reply.code(201).send({ adopted, failed });
  });

  app.get("/api/apps", async (request) => {
    const ctx = requireCapability(request, "app:read");
    const rows = await db.select().from(apps).where(visibleAppsWhere(ctx));
    const detailed = can(ctx, "app:config");

    // One Docker call for the whole page, partitioned by project. The per-row
    // alternative was a round trip per app on the screen that lists them all.
    const byProject = new Map<string, ContainerSummary[]>();
    for (const container of await host.listContainers()) {
      if (!container.project) continue;
      byProject.set(container.project, [...(byProject.get(container.project) ?? []), container]);
    }

    return Promise.all(
      rows.map(async (row) => {
        const status = await statusFor(row, byProject.get(row.projectName ?? "") ?? []);
        return detailed ? toAdminApp(row, status) : toViewerApp(row, status);
      }),
    );
  });

  app.get("/api/apps/:id", async (request, reply) => {
    const ctx = requireCapability(request, "app:read");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const [row] = await db
      .select()
      .from(apps)
      .where(and(eq(apps.id, id), visibleAppsWhere(ctx)));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const status = await statusFor(row);
    return can(ctx, "app:config") ? toAdminApp(row, status) : toViewerApp(row, status);
  });

  app.patch("/api/apps/:id", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = patchBody.parse(request.body);

    // Every field is optional, so `{}` parses cleanly — and Drizzle throws on an empty
    // `set()`, which would surface as a 500 for what is really a no-op request.
    if (Object.keys(body).length === 0) return reply.code(400).send({ error: "no_fields" });

    const updated = await db
      .update(apps)
      .set(body)
      .where(eq(apps.id, id))
      .returning({ id: apps.id });
    if (updated.length === 0) return reply.code(404).send({ error: "not_found" });

    await audit(db, ctx, {
      action: "app.updated",
      targetType: "app",
      targetId: id,
      detail: body,
      ip: request.ip,
    });
    const [row] = await db.select().from(apps).where(eq(apps.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    return toAdminApp(row, await statusFor(row));
  });

  app.delete("/api/apps/:id", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const [row] = await db.select().from(apps).where(eq(apps.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    // `isSystem` marks the managed cloudflared stack, which Phase 2 owns.
    if (row.isSystem) return reply.code(409).send({ error: "system_app" });

    // Forgetting an app never touches its files or containers.
    await db.delete(apps).where(eq(apps.id, id));
    await audit(db, ctx, {
      action: "app.forgotten",
      targetType: "app",
      targetId: id,
      ip: request.ip,
    });
    return reply.code(204).send();
  });

  app.get("/api/apps/:id/compose", async (request, reply) => {
    requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const [row] = await db.select().from(apps).where(eq(apps.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    return host.readTextFile(`${row.directory}/${row.composeFile}`);
  });

  app.put("/api/apps/:id/compose", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = composeWriteBody.parse(request.body);

    const [row] = await db.select().from(apps).where(eq(apps.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });

    const relative = `${row.directory}/${row.composeFile}`;
    const target = { directory: row.directory, composeFile: row.composeFile };

    // Validate BEFORE writing. An invalid compose file makes the app unmanageable, and
    // the editor is where the user should learn about it — not the next deploy.
    const check = await validateContent(row.directory, body.content);
    if (!check.valid) {
      return reply.code(422).send({ error: "invalid_compose", message: check.message });
    }

    try {
      const { hash } = await host.writeTextFile(relative, body.content, body.expectedHash);
      composeConfig.invalidate(target);
      await db.update(apps).set({ lastComposeHash: hash }).where(eq(apps.id, id));
      await audit(db, ctx, {
        action: "app.compose_written",
        targetType: "app",
        targetId: id,
        ip: request.ip,
      });
      return { hash };
    } catch (error) {
      if (error instanceof HashMismatchError) {
        return reply
          .code(409)
          .send({ error: "stale_hash", message: "The file changed on disk since it was loaded." });
      }
      throw error;
    }
  });

  app.post("/api/apps/:id/compose/validate", async (request, reply) => {
    requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ content: z.string() }).parse(request.body);

    const [row] = await db.select().from(apps).where(eq(apps.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });

    return validateContent(row.directory, body.content);
  });
}
