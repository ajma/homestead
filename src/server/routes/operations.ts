import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/guard.js";
import { composeExec, composeLogs } from "../docker/compose.js";
import { type DockerRunner, dockerRunner } from "../docker/run.js";
import type { OperationKind, OperationRegistry } from "../ops/registry.js";
import { isValidSlug, scanProjects } from "../projects/store.js";

type Opts = {
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
  registry: OperationRegistry;
  /** Injected so route tests never need a Docker daemon. */
  docker?: DockerRunner;
};

/**
 * The lifecycle verbs a client may ask for.
 *
 * `stop` rather than `down`: stopping is not deleting. `down` destroys the
 * containers and the network, which is the right thing to do when a project
 * is being removed and a surprising thing to do when someone wanted it to
 * stop running. Removal belongs to `DELETE /api/projects/:slug`, which still
 * runs `down` on the way out — the only caller that should.
 */
const VERBS: Record<string, { kind: OperationKind; args: string[] }> = {
  up: { kind: "up", args: ["up", "-d"] },
  stop: { kind: "stop", args: ["stop"] },
  restart: { kind: "restart", args: ["restart"] },
  pull: { kind: "pull", args: ["pull"] },
};

/**
 * `String(Number(x))` sends docker the literal "NaN" for `?tail=abc`. Bound it
 * too: `--tail 10000000` on a chatty stack is a self-inflicted memory spike.
 */
const tailQuery = z.coerce.number().int().min(0).max(10_000).default(200);

/**
 * A compose service name, which can never begin with `-`. The argv reaches
 * `docker` without a shell, so this is not injection defence; it stops a
 * caller smuggling a flag into the `logs` sub-command's argument list.
 */
const serviceQuery = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .optional();

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
  const docker = opts.docker ?? dockerRunner;

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
          (emit) => composeExec(ctxFor(slug), verb.args, emit, docker),
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
      const op = await opts.registry.find(request.params.id);
      if (!op) return reply.status(404).send({ error: "not_found" });
      return op;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/stream",
    { preHandler: requirePermission({ project: ["read"] }) },
    async (request, reply) => {
      const { id } = request.params;
      openSse(reply);
      const unsubscribe = opts.registry.subscribe(
        id,
        (chunk) => reply.raw.write(encodeSseData({ chunk })),
        () => {
          // Resolved from the database when it is no longer in memory, so the
          // terminal event never says `operation: undefined`.
          void opts.registry
            .find(id)
            .then((op) => op ?? null)
            .catch(() => null)
            .then((operation) => {
              reply.raw.write(encodeSseData({ end: true, operation }));
              reply.raw.end();
            });
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
      const tail = tailQuery.safeParse(request.query.tail);
      if (!tail.success)
        return reply.status(400).send({ error: "invalid_tail" });
      const service = serviceQuery.safeParse(request.query.service);
      if (!service.success)
        return reply.status(400).send({ error: "invalid_service" });

      openSse(reply);
      // Aborting kills the child: without it, every closed browser tab leaks a
      // `docker compose logs -f`.
      const controller = new AbortController();
      request.raw.on("close", () => controller.abort());
      try {
        await composeLogs(
          ctxFor(slug),
          {
            service: service.data,
            tail: tail.data,
            signal: controller.signal,
          },
          (chunk) => reply.raw.write(encodeSseData({ chunk })),
          docker,
        );
      } catch (err) {
        request.log.error({ err }, "log stream failed");
      }
      reply.raw.write(encodeSseData({ end: true }));
      reply.raw.end();
      return reply;
    },
  );
};
