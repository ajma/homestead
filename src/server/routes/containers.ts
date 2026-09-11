import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppRow, currentProjectName } from "../apps/status-for.js";
import { requireCapability } from "../auth/context.js";
import type { ContainerSummary } from "../host/types.js";
import { loadApp } from "./apps.js";

export async function containerRoutes(app: FastifyInstance): Promise<void> {
  const { db, host, composeConfig } = app.deps;

  /**
   * The app's containers, or a signal that Docker could not be asked.
   *
   * The two callers want different things from a failure, so the failure is returned
   * rather than swallowed. The list renders an empty set — a wedged socket must not take
   * out the screen, the same rule the app list follows. The detail endpoint cannot do
   * that: with an empty list its ownership check would answer 404, telling the user the
   * container does not exist when the truth is that we cannot tell.
   */
  async function containersFor(
    row: AppRow,
  ): Promise<{ ok: true; containers: ContainerSummary[] } | { ok: false }> {
    try {
      const projectName = await currentProjectName({ host, composeConfig }, row);
      return { ok: true, containers: await host.listContainers({ project: projectName }) };
    } catch {
      return { ok: false };
    }
  }

  const DOCKER_UNREACHABLE = {
    error: "docker_unreachable",
    message: "Docker is not reachable, so container details are unavailable.",
  } as const;

  app.get("/api/apps/:id/containers", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const found = await containersFor(row);
    // Still 200 either way — a wedged socket must not take out the screen — but
    // `dockerReachable` carries the distinction `found.ok` already drew, rather than
    // discarding it here. Collapsing this to a bare array made "Docker can't see your
    // stack" indistinguishable from "your stack has no containers", which sends an
    // admin to restart something that was never actually down.
    return { containers: found.ok ? found.containers : [], dockerReachable: found.ok };
  });

  app.get("/api/apps/:id/containers/:containerId", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id, containerId } = z
      .object({ id: z.string(), containerId: z.string() })
      .parse(request.params);

    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    // Ownership, not just existence. A raw container id would otherwise reach any
    // container on the host, including one from an app this caller cannot see.
    const found = await containersFor(row);
    // 503, not 404. Without the list the ownership question is unanswerable, and 404
    // would assert the container does not exist when we simply cannot see it. The log
    // route answers the same way for the same reason.
    if (!found.ok) return reply.code(503).send(DOCKER_UNREACHABLE);
    if (!found.containers.some((container) => container.id === containerId)) {
      return reply.code(404).send({ error: "not_found" });
    }

    try {
      return await host.inspectContainer(containerId);
    } catch (error) {
      // Discriminate: a genuine 404 stays 404 (container removed between list and inspect),
      // but anything else is 503. A socket that wedges between the two calls would otherwise
      // report "container not found" for a container that exists.
      if ((error as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({
          error: "not_found",
          message: error instanceof Error ? error.message : "container is gone",
        });
      }
      return reply.code(503).send(DOCKER_UNREACHABLE);
    }
  });
}
