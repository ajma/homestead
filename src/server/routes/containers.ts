import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCapability } from "../auth/context.js";
import type { ContainerSummary } from "../host/types.js";
import { loadApp } from "./apps.js";

export async function containerRoutes(app: FastifyInstance): Promise<void> {
  const { db, host } = app.deps;

  /** The app's containers, or an empty list. Never a 500: a wedged socket must not take
   *  out the screen, which is the same rule the app list follows. */
  async function containersFor(projectName: string | null): Promise<ContainerSummary[]> {
    try {
      return await host.listContainers({ project: projectName ?? "" });
    } catch {
      return [];
    }
  }

  app.get("/api/apps/:id/containers", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return containersFor(row.projectName);
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
    const containers = await containersFor(row.projectName);
    if (!containers.some((container) => container.id === containerId)) {
      return reply.code(404).send({ error: "not_found" });
    }

    try {
      return await host.inspectContainer(containerId);
    } catch (error) {
      // Removed between the list and the inspect. 404 is the honest answer.
      return reply.code(404).send({
        error: "not_found",
        message: error instanceof Error ? error.message : "container is gone",
      });
    }
  });
}
