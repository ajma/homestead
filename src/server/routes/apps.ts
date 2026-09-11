import type { AdminApp, ViewerApp } from "@shared/dto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { scanForApps } from "../apps/adoption.js";
import { maskEnv, parseEnv } from "../apps/env-file.js";
import { toAdminApp, toViewerApp } from "../apps/serialize.js";
import { currentProjectName, statusFor } from "../apps/status-for.js";
import { audit } from "../audit.js";
import type { AuthContext } from "../auth/context.js";
import { can, requireCapability, visibleAppsWhere } from "../auth/context.js";
import { LOCAL_HOST_ID } from "../bootstrap.js";
import type { Db } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { apps, probes } from "../db/schema.js";
import type { ContainerSummary } from "../host/types.js";
import { HashMismatchError } from "../host/types.js";
import type { IconMetadata } from "../icons/metadata.js";

const adoptBody = z.object({ directories: z.array(z.string().min(1)).min(1) });

const launchUrlSchema = z
  .union([
    z.null(),
    z.literal(""),
    z.string().refine(
      (val) => {
        // Only http: and https: are safe for an href. `javascript:`, `data:` and
        // scheme-relative `//host` are all stored XSS vectors, and this value reaches
        // the viewer DTO, so an admin could otherwise plant one for a housemate.
        //
        // Parse first and read `protocol`, rather than matching a prefix. Schemes are
        // case-insensitive per RFC 3986, so a prefix check rejected `HTTPS://nas.local`
        // — which every browser accepts — while `new URL` normalises it for us.
        try {
          const parsed = new URL(val);
          return parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "URL must use http: or https: scheme" },
    ),
  ])
  .optional();

const patchBody = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  iconRef: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  launchInternalUrl: launchUrlSchema,
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

/**
 * Spec §8: on adoption, the directory name is matched against slugs and aliases to
 * pre-fill an icon suggestion. Never fails adoption: an empty or unreachable index
 * simply yields no suggestion, via `IconMetadata.matchDirectory`'s own null return.
 */
function suggestIconRef(metadata: IconMetadata, directory: string): string | null {
  return metadata.matchDirectory(directory);
}

/**
 * The single way any route loads an app by id. Composing `visibleAppsWhere` here rather
 * than at each call site is the point: a route that forgets it cannot be spotted by
 * reading that route, only by reading all of them and noticing one differs. Out of scope
 * is 404, not 403, so the answer does not confirm an app the caller may not see exists.
 */
export async function loadApp(db: Db, ctx: AuthContext, id: string) {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.id, id), visibleAppsWhere(ctx)));
  return row;
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  const { db, host, composeConfig, icons } = app.deps;

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

  /**
   * Reads `.env`, distinguishing "there isn't one" from "there is one I cannot read".
   *
   * Collapsing those two was a data-loss path, and on the file holding the user's
   * database passwords. `.env` files are routinely `chmod 600`, and if Homestead runs as
   * a different uid the read fails — so the UI would report no `.env`, the user would
   * write one with `expectedHash: null`, and `writeTextFile`'s own read would fail the
   * same way, take `currentHash` as null, match, and replace the original.
   *
   * `fileExists` is what separates them: present-but-unreadable becomes an error the
   * write refuses to act on, rather than an absence it happily fills.
   */
  type EnvFile =
    | { state: "present"; content: string; hash: string }
    | { state: "absent"; content: ""; hash: null }
    | { state: "unreadable"; content: ""; hash: null };

  async function readEnv(directory: string): Promise<EnvFile> {
    const relative = `${directory}/.env`;
    try {
      const file = await host.readTextFile(relative);
      return { state: "present", content: file.content, hash: file.hash };
    } catch {
      return (await host.fileExists(relative))
        ? { state: "unreadable", content: "", hash: null }
        : { state: "absent", content: "", hash: null };
    }
  }

  // A scratch file also survives an abnormal termination between the write and the
  // `finally` — SIGKILL, or the container being stopped mid-validation. Accepted rather
  // than swept at startup: it is a dotfile, `docker compose` does not pick it up, and a
  // sweep would need a list-files-in-a-directory primitive on `Host` that nothing else
  // wants yet. Carried forward instead.

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

    // Hoist listAppDirectories outside the loop - calling it once per directory was N round trips.
    const allDiscovered = await host.listAppDirectories();

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

      const discovered = allDiscovered.find((d) => d.directory === directory);
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
      // Resolved before the transaction opens, not inside it: `uniqueSlug` reads through
      // the plain `db` handle rather than `tx`, and a plain read issued while a
      // transaction is open on the same connection is rejected outright against the
      // in-memory database the test suite runs on (see scheduler.ts's `serialise`).
      const slug = await uniqueSlug(directory);
      // Never fails adoption: an empty or unreachable index simply yields no suggestion.
      const iconRef = suggestIconRef(icons.metadata, directory);
      try {
        // The app row and its docker probe are inserted together. An adopted app with no
        // probe is invisible to monitoring until someone notices and adds one by hand, so
        // the probe insert cannot be allowed to fail silently after the app exists — and
        // it cannot be allowed to leave a probeless app behind either. Wrapping both in one
        // transaction means a probe-insert failure rolls the app insert back with it, so
        // this directory lands in `failed` honestly instead of in `adopted` missing a
        // probe, or in `failed` while the row sits in the database regardless.
        // The scheduler can open its own transaction (`persistResult`) the same instant
        // this one starts — see `db/retry.ts`. Without the retry that race is a lost
        // adoption and a 500, not merely a delayed one.
        await retryOnBusy(() =>
          db.transaction(async (tx) => {
            await tx.insert(apps).values({
              id,
              hostId: LOCAL_HOST_ID,
              slug,
              displayName: directory,
              directory,
              composeFile: discovered.composeFile,
              // From `docker compose config`, which already honours
              // COMPOSE_PROJECT_NAME in the sibling .env. Deriving it from the
              // directory name would be wrong.
              projectName: resolved.resolved.projectName,
              lastComposeHash: hash,
              iconRef,
            });
            await tx.insert(probes).values({ id: ulid(), appId: id, kind: "docker" });
          }),
        );
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

      // Deliberately not `loadApp`: this reads back the row just inserted under an id
      // generated here. Composing the scope predicate would return nothing for a scoped
      // principal, so a successful adoption would report an empty `adopted` list.
      const [row] = await db.select().from(apps).where(eq(apps.id, id));
      if (row) adopted.push(toAdminApp(row, await statusFor({ host, composeConfig }, row)));
      await audit(db, ctx, {
        action: "app.adopted",
        targetType: "app",
        targetId: id,
        ip: request.ip,
      });
    }

    if (adopted.length === 0) {
      return reply.code(anyConflict ? 409 : 422).send({ error: "adopt_failed", adopted, failed });
    }
    return reply.code(201).send({ adopted, failed });
  });

  app.get("/api/apps", async (request) => {
    const ctx = requireCapability(request, "app:read");
    const rows = await db.select().from(apps).where(visibleAppsWhere(ctx));
    const detailed = can(ctx, "app:config");

    // One Docker call for the whole page, partitioned by project. The per-row
    // alternative was a round trip per app on the screen that lists them all.
    let dockerReachable = true;
    const byProject = new Map<string, ContainerSummary[]>();
    try {
      for (const container of await host.listContainers()) {
        if (!container.project) continue;
        byProject.set(container.project, [...(byProject.get(container.project) ?? []), container]);
      }
    } catch {
      // Docker is unreachable. Do NOT fall back to an empty container list — that would
      // make `rollUpStatus` report `down` with "N missing", painting every app red and
      // telling the user their whole NAS is broken. `unknown` is the truth: we do not know.
      dockerReachable = false;
    }

    // Bound concurrency to 4. Each cache miss spawns `docker compose config`, and on a
    // cold cache that's one Go binary per app simultaneously — thirty on this NAS. The
    // irony: we collapsed thirty Docker API calls into one above, then fan out thirty
    // processes beside it.
    const CONCURRENCY_LIMIT = 4;
    const results: Array<ViewerApp | AdminApp> = [];

    for (let i = 0; i < rows.length; i += CONCURRENCY_LIMIT) {
      const chunk = rows.slice(i, i + CONCURRENCY_LIMIT);
      const chunkResults = await Promise.all(
        chunk.map(async (row) => {
          if (!dockerReachable) {
            const status = { status: "unknown" as const, detail: "Docker is unreachable" };
            return detailed ? toAdminApp(row, status) : toViewerApp(row, status);
          }
          const project = await currentProjectName({ host, composeConfig }, row);
          const status = await statusFor(
            { host, composeConfig },
            row,
            byProject.get(project) ?? [],
          );
          return detailed ? toAdminApp(row, status) : toViewerApp(row, status);
        }),
      );
      results.push(...chunkResults);
    }

    return results;
  });

  app.get("/api/apps/:id", async (request, reply) => {
    const ctx = requireCapability(request, "app:read");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const status = await statusFor({ host, composeConfig }, row);
    return can(ctx, "app:config") ? toAdminApp(row, status) : toViewerApp(row, status);
  });

  app.patch("/api/apps/:id", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const body = patchBody.parse(request.body);

    // Every field is optional, so `{}` parses cleanly — and Drizzle throws on an empty
    // `set()`, which would surface as a 500 for what is really a no-op request.
    if (Object.keys(body).length === 0) return reply.code(400).send({ error: "no_fields" });

    // Check scope before the update.
    if (!(await loadApp(db, ctx, id))) return reply.code(404).send({ error: "not_found" });

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
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return toAdminApp(row, await statusFor({ host, composeConfig }, row));
  });

  app.delete("/api/apps/:id", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const row = await loadApp(db, ctx, id);
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
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return host.readTextFile(`${row.directory}/${row.composeFile}`);
  });

  app.put("/api/apps/:id/compose", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = composeWriteBody.parse(request.body);

    const row = await loadApp(db, ctx, id);
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

      // Re-resolve to pick up a changed project name. The resolve is already warm-cached
      // against the new content. Do not fail the write if this fails.
      try {
        const resolved = await composeConfig.resolve(target);
        if (resolved.valid && resolved.resolved.projectName !== row.projectName) {
          await db
            .update(apps)
            .set({ projectName: resolved.resolved.projectName })
            .where(eq(apps.id, id));
        }
      } catch {
        // Best effort. See the .env route for the rationale.
      }

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
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ content: z.string() }).parse(request.body);

    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    return validateContent(row.directory, body.content);
  });

  const UNREADABLE = {
    error: "env_unreadable",
    message: "A .env file exists but Homestead cannot read it. Check its ownership and mode.",
  } as const;

  app.get("/api/apps/:id/env", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    const file = await readEnv(row.directory);
    if (file.state === "unreadable") return reply.code(409).send(UNREADABLE);
    // Masked, always. The reveal endpoint is the only way to see values.
    return { entries: maskEnv(parseEnv(file.content)), exists: file.state === "present" };
  });

  app.post("/api/apps/:id/env/reveal", async (request, reply) => {
    const ctx = requireCapability(request, "app:secrets");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    const file = await readEnv(row.directory);
    if (file.state === "unreadable") return reply.code(409).send(UNREADABLE);
    // A separate endpoint rather than a query flag, so revealing is always deliberate
    // and always leaves a trace. Audited only once the read succeeded — an audit line
    // saying a secret was revealed when it was not is worse than none.
    await audit(db, ctx, {
      action: "app.env_revealed",
      targetType: "app",
      targetId: id,
      ip: request.ip,
    });
    return { content: file.content, hash: file.hash, exists: file.state === "present" };
  });

  app.put("/api/apps/:id/env", async (request, reply) => {
    const ctx = requireCapability(request, "app:secrets");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = composeWriteBody.parse(request.body);

    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    // Refuse rather than overwrite. `writeTextFile` cannot tell an unreadable file from
    // an absent one either, so a `null` expectedHash would sail straight through its
    // guard and replace a `.env` full of passwords.
    if ((await readEnv(row.directory)).state === "unreadable") {
      return reply.code(409).send(UNREADABLE);
    }

    try {
      const { hash } = await host.writeTextFile(
        `${row.directory}/.env`,
        body.content,
        body.expectedHash,
      );
      // `.env` feeds ${VAR} interpolation and COMPOSE_PROJECT_NAME, so the resolved
      // config is now stale even though compose.yaml has not changed.
      const target = { directory: row.directory, composeFile: row.composeFile };
      composeConfig.invalidate(target);

      // Re-resolve to pick up COMPOSE_PROJECT_NAME from the new .env. The resolve is
      // already warm-cached against the new content. Do not fail the write if this
      // fails — the user's file is already saved.
      try {
        const resolved = await composeConfig.resolve(target);
        if (resolved.valid && resolved.resolved.projectName !== row.projectName) {
          await db
            .update(apps)
            .set({ projectName: resolved.resolved.projectName })
            .where(eq(apps.id, id));
        }
      } catch {
        // Best effort. A name that will be corrected on the next successful resolve is a
        // smaller problem than a save reported as failed after it succeeded.
      }

      await audit(db, ctx, {
        action: "app.env_written",
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
}
