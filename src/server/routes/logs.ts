import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCapability } from "../auth/context.js";
import { sseResponse } from "../sse.js";
import { loadApp } from "./apps.js";

/** More than this and the browser is the bottleneck, not the server. */
const MAX_TAIL = 5000;

const query = z.object({
  tail: z.coerce.number().int().positive().max(MAX_TAIL).catch(MAX_TAIL).default(200),
  follow: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export async function logRoutes(app: FastifyInstance): Promise<void> {
  const { db, host } = app.deps;

  app.get("/api/apps/:id/containers/:containerId/logs", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id, containerId } = z
      .object({ id: z.string(), containerId: z.string() })
      .parse(request.params);
    const options = query.parse(request.query);

    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    // The container must belong to THIS app. Without this the id is a free handle to any
    // container on the host, including one from an app the caller is scoped out of.
    const containers = await host.listContainers({ project: row.projectName ?? "" });
    if (!containers.some((container) => container.id === containerId)) {
      return reply.code(404).send({ error: "not_found" });
    }

    const sse = sseResponse(request, reply);
    let disconnected = false;
    void sse.closed.then(() => {
      disconnected = true;
    });

    try {
      for await (const line of host.streamLogs({
        containerId,
        tail: options.tail,
        follow: options.follow,
      })) {
        if (disconnected) break;
        sse.send("line", line);
      }
    } catch (error) {
      // The stream can die mid-flight when the container is removed. Say so on the
      // stream rather than throwing, which at this point would produce a torn response
      // the error handler cannot turn into JSON.
      request.log.error({ err: error, containerId }, "log stream failed");
      sse.send("error", { message: error instanceof Error ? error.message : "log stream ended" });
    } finally {
      sse.send("done", {});
      sse.close();
    }
    // Hijacked — nothing to return.
  });
}
