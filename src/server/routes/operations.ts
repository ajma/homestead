import { spawn } from "node:child_process";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { requirePermission } from "../auth/guard.js";
import { composeExec, ensureOverride } from "../docker/compose.js";
import type { OperationKind, OperationRegistry } from "../ops/registry.js";
import {
  findComposeFile,
  isValidSlug,
  projectPath,
  scanProjects,
} from "../projects/store.js";

type Opts = {
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
  registry: OperationRegistry;
};

const VERBS: Record<string, { kind: OperationKind; args: string[] }> = {
  up: { kind: "up", args: ["up", "-d"] },
  down: { kind: "down", args: ["down"] },
  restart: { kind: "restart", args: ["restart"] },
  pull: { kind: "pull", args: ["pull"] },
};

/** One SSE event. Newlines inside the payload are JSON-escaped, never emitted raw. */
export function encodeSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function openSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");
}

export const operationRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const ctxFor = (slug: string) => ({
    projectsDir: opts.projectsDir,
    projectsHostDir: opts.projectsHostDir,
    dataDir: opts.dataDir,
    slug,
  });

  const exists = async (slug: string) =>
    isValidSlug(slug) &&
    (await scanProjects(opts.projectsDir)).some((e) => e.slug === slug);

  app.post<{ Params: { slug: string; verb: string } }>(
    "/api/projects/:slug/:verb",
    { preHandler: requirePermission({ project: ["control"] }) },
    async (request, reply) => {
      const verb = VERBS[request.params.verb];
      if (!verb) return reply.callNotFound();
      const { slug } = request.params;
      if (!(await exists(slug)))
        return reply.status(404).send({ error: "not_found" });
      try {
        const op = await opts.registry.start(
          slug,
          verb.kind,
          request.session?.user.id ?? null,
          (emit) => composeExec(ctxFor(slug), verb.args, emit),
        );
        return reply.status(202).send({ operationId: op.id });
      } catch (err) {
        return reply.status(409).send({
          error: "operation_in_progress",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/operations/:id",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      const op = opts.registry.get(request.params.id);
      if (!op) return reply.status(404).send({ error: "not_found" });
      return op;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/stream",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      openSse(reply);
      const unsubscribe = opts.registry.subscribe(
        request.params.id,
        (chunk) => reply.raw.write(encodeSseData({ chunk })),
        () => {
          reply.raw.write(
            encodeSseData({
              end: true,
              operation: opts.registry.get(request.params.id),
            }),
          );
          reply.raw.end();
        },
      );
      request.raw.on("close", unsubscribe);
      return reply;
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/operations",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      if (!isValidSlug(request.params.slug))
        return reply.status(400).send({ error: "invalid_slug" });
      return {
        operations: await opts.registry.listForProject(request.params.slug),
      };
    },
  );

  app.get<{
    Params: { slug: string };
    Querystring: { service?: string; tail?: string };
  }>(
    "/api/projects/:slug/logs",
    { preHandler: requirePermission({ logs: ["read"] }) },
    async (request, reply) => {
      const { slug } = request.params;
      if (!(await exists(slug)))
        return reply.status(404).send({ error: "not_found" });

      const overridePath = await ensureOverride(ctxFor(slug));
      const dir = projectPath(opts.projectsDir, slug);
      const composeFile = (await findComposeFile(dir)) ?? "docker-compose.yml";
      const args = ["compose", "-f", `${dir}/${composeFile}`];
      if (overridePath) args.push("-f", overridePath);
      args.push(
        "logs",
        "--follow",
        "--tail",
        String(Number(request.query.tail ?? 200)),
      );
      if (request.query.service) args.push(request.query.service);

      openSse(reply);
      const child = spawn("docker", args, { cwd: dir });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const send = (chunk: string) => reply.raw.write(encodeSseData({ chunk }));
      child.stdout.on("data", send);
      child.stderr.on("data", send);
      child.on("close", () => {
        reply.raw.write(encodeSseData({ end: true }));
        reply.raw.end();
      });
      // Without this, every closed browser tab leaks a `docker compose logs -f`.
      request.raw.on("close", () => child.kill("SIGTERM"));
      return reply;
    },
  );
};
