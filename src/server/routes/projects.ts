import { createReadStream } from "node:fs";
import { join } from "node:path";
import { isReservedSlug } from "@shared/projects.js";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadIconNames } from "../apps/icon-manifest.js";
import { searchIcons } from "../apps/icon-search.js";
import { resolveIcon } from "../apps/icons.js";
import { syncAppMonitors } from "../apps/sync.js";
import { requirePermission } from "../auth/guard.js";
import type { Db } from "../db/client.js";
import { exposures } from "../db/schema.js";
import {
  type ContainerState,
  composeConfig,
  composeExec,
  composePs,
} from "../docker/compose.js";
import { type DockerRunner, dockerRunner } from "../docker/run.js";
import type { OperationRegistry } from "../ops/registry.js";
import { hasHomesteadBlock } from "../projects/doc.js";
import {
  deleteIdentity,
  readIdentities,
  readIdentity,
  writeIdentity,
} from "../projects/identity.js";
import { parseCanonical } from "../projects/model.js";
import {
  createProject,
  deleteProjectDir,
  isValidSlug,
  listSnapshots,
  ProjectExistsError,
  readProjectFile,
  scanProjects,
  writeProjectFile,
} from "../projects/store.js";

type Opts = {
  db: Db;
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
  /** Shared with the lifecycle routes; delete takes the same per-slug lock. */
  registry: OperationRegistry;
  /** Injected so route tests never need a Docker daemon. */
  docker?: DockerRunner;
};

const fileParam = z.enum(["compose", "env"]);
const putBody = z.object({ content: z.string().max(1024 * 1024) });
const createBody = z.object({
  slug: z.string(),
  source: z.enum(["blank", "paste"]),
  content: z
    .string()
    .max(1024 * 1024)
    .optional(),
});

export const projectRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const docker = opts.docker ?? dockerRunner;
  const ctxFor = (slug: string) => ({
    projectsDir: opts.projectsDir,
    projectsHostDir: opts.projectsHostDir,
    dataDir: opts.dataDir,
    slug,
  });

  const buildSyncDeps = () => ({
    listProjects: async () => {
      const entries = await scanProjects(opts.projectsDir);
      return entries.map((e) => e.slug);
    },
    composeConfig: async (slug: string) =>
      composeConfig(ctxFor(slug), docker.run),
    hostnameFor: async (slug: string, hostPort: number) => {
      const [exposure] = await opts.db
        .select({ hostname: exposures.hostname })
        .from(exposures)
        .where(
          and(
            eq(exposures.projectSlug, slug),
            eq(exposures.hostPort, hostPort),
          ),
        );
      return exposure?.hostname ?? null;
    },
  });

  app.get(
    "/api/projects",
    { preHandler: requirePermission({ project: ["read"] }) },
    async () => {
      const entries = await scanProjects(opts.projectsDir);
      // One lookup for the whole page rather than one per row.
      const identities = await readIdentities(
        opts.db,
        entries.map((e) => e.slug),
      );
      return {
        projects: entries.map((e) => ({
          ...e,
          identity: identities.get(e.slug) ?? null,
        })),
      };
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      const { slug } = request.params;
      if (!isValidSlug(slug))
        return reply.status(400).send({ error: "invalid_slug" });
      const entries = await scanProjects(opts.projectsDir);
      const entry = entries.find((e) => e.slug === slug);
      if (!entry) return reply.status(404).send({ error: "not_found" });

      let model = null;
      let parseError: string | null = null;
      if (entry.hasCompose) {
        try {
          model = parseCanonical(await composeConfig(ctxFor(slug), docker.run));
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }
      }

      let states: ContainerState[] = [];
      let statesError: string | null = null;
      if (entry.hasCompose) {
        try {
          states = await composePs(ctxFor(slug), docker.run);
        } catch (err) {
          statesError = err instanceof Error ? err.message : String(err);
        }
      }

      // Read from the file on disk, not from the canonical config: `docker
      // compose config` is unavailable for a project that does not parse, and
      // an unparseable adopted directory is exactly the case where the delete
      // dialog most needs to know Homestead did not create it.
      const composeText = entry.hasCompose
        ? await readProjectFile(opts.projectsDir, slug, "compose")
        : null;

      // SAFETY: parseCanonical extracts a fixed field set (name, ports, labels,
      // app, image) and deliberately never includes `environment`, which is what
      // keeps .env secrets out of this viewer-accessible response. Adding
      // `environment` to ServiceModel would expose every stored password to viewers.
      return {
        ...entry,
        model,
        parseError,
        states,
        statesError,
        // Absence of the x-homestead block IS the provenance marker (§3.7).
        identity: await readIdentity(opts.db, slug),
        hasHomestead:
          composeText === null ? false : hasHomesteadBlock(composeText),
        snapshots: await listSnapshots(opts.projectsDir, slug),
      };
    },
  );

  app.post(
    "/api/projects",
    { preHandler: requirePermission({ project: ["create"] }) },
    async (request, reply) => {
      const body = createBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: "invalid_body" });
      const { slug, source, content } = body.data;
      if (!isValidSlug(slug))
        return reply.status(400).send({ error: "invalid_slug" });
      // Create-time only. The router shadows `/projects/new`, so a project
      // made there would be listed and then unopenable — but this is a rule
      // about names being minted, not about path safety, and applying it in
      // `isValidSlug` would also lock an *existing* directory of that name out
      // of GET and DELETE.
      if (isReservedSlug(slug))
        return reply.status(400).send({ error: "reserved_slug" });

      try {
        await createProject(
          opts.projectsDir,
          slug,
          source === "blank"
            ? { kind: "blank" }
            : { kind: "paste", content: content ?? "" },
        );
      } catch (err) {
        if (err instanceof ProjectExistsError)
          return reply.status(409).send({ error: "project_exists" });
        throw err;
      }

      // Sync app monitors for the newly created project
      await syncAppMonitors(opts.db, buildSyncDeps()).catch((err) => {
        request.log.error({ err }, "Failed to sync app monitors after create");
      });

      // Validated *after* writing, per §6.1: the file is kept either way and the
      // caller is told what it got, so an invalid paste lands in the editor
      // rather than being thrown away.
      try {
        parseCanonical(await composeConfig(ctxFor(slug), docker.run));
        return reply.status(201).send({ slug, valid: true });
      } catch (err) {
        return reply.status(201).send({
          slug,
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get<{ Querystring: { q?: string } }>(
    "/api/icons",
    { preHandler: requirePermission({ project: ["update"] }) },
    async (request) => {
      // Cached to $HOMESTEAD_DATA/icons and never fatal: an empty list means
      // the picker offers nothing, not that the form is broken.
      const names = await loadIconNames({
        cacheDir: join(opts.dataDir, "icons"),
      });
      return { icons: searchIcons(names, request.query.q ?? "") };
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/icons/:slug",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      // resolveIcon sanitises the slug to [a-z0-9-], builds the path inside
      // the cache directory, and refuses SVG outright — it executes script
      // when served same-origin. The path it returns is constrained by
      // construction, which is why it can be sent directly.
      const resolved = await resolveIcon({
        slug: request.params.slug,
        cacheDir: join(opts.dataDir, "icons"),
      });
      if (!resolved) {
        return reply.status(404).send({ error: "not_found" });
      }
      const ext = resolved.path.split(".").pop() ?? "png";
      const type =
        ext === "webp"
          ? "image/webp"
          : ext.startsWith("jp")
            ? "image/jpeg"
            : "image/png";
      return reply
        .type(type)
        .header("cache-control", "public, max-age=86400")
        .send(createReadStream(resolved.path));
    },
  );

  app.put<{ Params: { slug: string } }>(
    "/api/projects/:slug/identity",
    { preHandler: requirePermission({ project: ["update"] }) },
    async (request, reply) => {
      const { slug } = request.params;
      if (!isValidSlug(slug)) {
        return reply.status(400).send({
          error: "invalid_slug",
          detail: `Not a project slug: ${slug}`,
        });
      }

      const body = z
        .object({
          // Nullable as well as optional: clearing a field is a real edit, and
          // the form sends null for one it has emptied.
          displayName: z.string().max(120).nullish(),
          description: z.string().max(2000).nullish(),
          iconSlug: z
            .string()
            .regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes only")
            .max(80)
            .nullish(),
          iconUrl: z.string().url().max(2000).nullish(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "invalid_body",
          detail: body.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        });
      }

      // Identity is stored against the slug, so the directory has to exist —
      // otherwise a typo silently creates a row nothing will ever read.
      const entries = await scanProjects(opts.projectsDir);
      if (!entries.some((e) => e.slug === slug)) {
        return reply
          .status(404)
          .send({ error: "not_found", detail: `No project named ${slug}` });
      }

      await writeIdentity(opts.db, slug, body.data);
      return { ok: true };
    },
  );

  app.delete<{ Params: { slug: string } }>(
    "/api/projects/:slug",
    { preHandler: requirePermission({ project: ["delete"] }) },
    async (request, reply) => {
      const { slug } = request.params;
      if (!isValidSlug(slug))
        return reply.status(400).send({ error: "invalid_slug" });
      const entries = await scanProjects(opts.projectsDir);
      const entry = entries.find((e) => e.slug === slug);
      if (!entry) return reply.status(404).send({ error: "not_found" });

      // Held across the `down` *and* the `rm -rf`, not just the `down`. An
      // `up` started in another tab would otherwise finish in between and
      // recreate the containers, leaving them running and holding host ports
      // with the compose file already deleted — a state the UI says does not
      // exist and Homestead can no longer enumerate or stop.
      const release = opts.registry.acquire(slug);
      if (!release)
        return reply.status(409).send({
          error: "operation_in_progress",
          detail: `an operation is already running for project "${slug}"`,
        });
      try {
        // `down` only — never a volume flag. The wrapper's allow-list makes
        // that structurally impossible; named volumes are retained and
        // reported to the user by the delete dialog (§3.7, §8).
        if (entry.hasCompose) {
          try {
            await composeExec(ctxFor(slug), ["down"], () => {}, docker);
          } catch (err) {
            // The user asked for the directory to go. A stack that will not
            // come down — unreachable daemon, unparseable compose file — must
            // not strand them with a project they cannot remove.
            request.log.warn(
              { err, slug },
              "compose down failed before delete",
            );
          }
        }
        await deleteProjectDir(opts.projectsDir, slug);
        // Otherwise a directory recreated under this slug inherits its name.
        await deleteIdentity(opts.db, slug);
      } finally {
        release();
      }

      // Sync app monitors after project deletion
      await syncAppMonitors(opts.db, buildSyncDeps()).catch((err) => {
        request.log.error({ err }, "Failed to sync app monitors after delete");
      });

      return { ok: true };
    },
  );

  app.get<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/file/:name",
    { preHandler: requirePermission({ compose: ["read"] }) },
    async (request, reply) => {
      const name = fileParam.safeParse(request.params.name);
      if (!name.success)
        return reply.status(400).send({ error: "unknown_file" });
      if (!isValidSlug(request.params.slug))
        return reply.status(400).send({ error: "invalid_slug" });
      let content: string | null;
      try {
        content = await readProjectFile(
          opts.projectsDir,
          request.params.slug,
          name.data,
        );
      } catch (err) {
        // 404 is reserved for genuine absence. A share the container cannot
        // read is a different problem and must not look like a missing file.
        request.log.error({ err }, "project file read failed");
        return reply.status(500).send({
          error: "read_failed",
          code: (err as NodeJS.ErrnoException).code ?? null,
        });
      }
      if (content === null)
        return reply.status(404).send({ error: "not_found" });
      return { content };
    },
  );

  app.put<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/file/:name",
    { preHandler: requirePermission({ compose: ["write"] }) },
    async (request, reply) => {
      const name = fileParam.safeParse(request.params.name);
      if (!name.success)
        return reply.status(400).send({ error: "unknown_file" });
      if (!isValidSlug(request.params.slug))
        return reply.status(400).send({ error: "invalid_slug" });
      const body = putBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: "invalid_body" });
      const entries = await scanProjects(opts.projectsDir);
      if (!entries.some((e) => e.slug === request.params.slug)) {
        return reply.status(404).send({ error: "not_found" });
      }
      await writeProjectFile(
        opts.projectsDir,
        request.params.slug,
        name.data,
        body.data.content,
      );

      // Sync app monitors after compose file update
      if (name.data === "compose") {
        await syncAppMonitors(opts.db, buildSyncDeps()).catch((err) => {
          request.log.error({ err }, "Failed to sync app monitors after save");
        });
      }

      return { ok: true };
    },
  );

  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/validate",
    { preHandler: requirePermission({ compose: ["write"] }) },
    async (request, reply) => {
      if (!isValidSlug(request.params.slug))
        return reply.status(400).send({ error: "invalid_slug" });
      try {
        const model = parseCanonical(
          await composeConfig(ctxFor(request.params.slug), docker.run),
        );
        return { valid: true, model };
      } catch (err) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
};
