import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/guard.js";
import {
  type ContainerState,
  composeConfig,
  composePs,
} from "../docker/compose.js";
import { parseCanonical } from "../projects/model.js";
import {
  isValidSlug,
  listSnapshots,
  readProjectFile,
  scanProjects,
  writeProjectFile,
} from "../projects/store.js";

type Opts = { projectsDir: string; projectsHostDir: string; dataDir: string };

const fileParam = z.enum(["compose", "env"]);
const putBody = z.object({ content: z.string().max(1024 * 1024) });

export const projectRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const ctxFor = (slug: string) => ({ ...opts, slug });

  app.get(
    "/api/projects",
    { preHandler: requirePermission({ project: ["read"] }) },
    async () => {
      const entries = await scanProjects(opts.projectsDir);
      return { projects: entries };
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
          model = parseCanonical(await composeConfig(ctxFor(slug)));
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }
      }

      let states: ContainerState[] = [];
      let statesError: string | null = null;
      if (entry.hasCompose) {
        try {
          states = await composePs(ctxFor(slug));
        } catch (err) {
          statesError = err instanceof Error ? err.message : String(err);
        }
      }

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
        snapshots: await listSnapshots(opts.projectsDir, slug),
      };
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
      const content = await readProjectFile(
        opts.projectsDir,
        request.params.slug,
        name.data,
      );
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
          await composeConfig(ctxFor(request.params.slug)),
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
