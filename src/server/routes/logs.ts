import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentProjectName } from "../apps/status-for.js";
import { requireCapability } from "../auth/context.js";
import { sseResponse } from "../sse.js";
import { loadApp } from "./apps.js";

/** More than this and the browser is the bottleneck, not the server. */
const MAX_TAIL = 5000;

// `follow` defaults to true and nothing bounds the stream's duration: a tab left open
// overnight on a chatty container holds one request and one heartbeat until it closes.
// Accepted for now — the bound that matters is per-client, and the browser closing the
// EventSource is that bound. A server-side max duration would cut a user watching a
// deploy, which is the case the feature exists for.

const query = z.object({
  // Clamp what is merely too large; fall back to the DEFAULT for what is not a number.
  // `.max(MAX_TAIL).catch(MAX_TAIL)` conflated the two, so `?tail=abc` and `?tail=-5`
  // were served 5000 lines — garbage input getting the most expensive answer available.
  tail: z.coerce
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, MAX_TAIL))
    .catch(200)
    .default(200),
  follow: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export async function logRoutes(app: FastifyInstance): Promise<void> {
  const { db, host, composeConfig } = app.deps;

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
    //
    // A wedged Docker socket answers 503, not 500: the app list already degrades rather
    // than erroring for the same cause, and an opaque 500 on the logs pane tells the user
    // nothing about what to fix. It must NOT fall through to streaming — an empty
    // container list would make the ownership check vacuous.
    let containers: Awaited<ReturnType<typeof host.listContainers>>;
    try {
      const projectName = await currentProjectName({ host, composeConfig }, row);
      containers = await host.listContainers({ project: projectName });
    } catch (error) {
      request.log.error({ err: error, appId: id }, "listing containers failed");
      return reply.code(503).send({
        error: "docker_unreachable",
        message: "Docker is not reachable, so logs cannot be opened.",
      });
    }
    if (!containers.some((container) => container.id === containerId)) {
      return reply.code(404).send({ error: "not_found" });
    }

    const sse = sseResponse(request, reply);
    const abort = new AbortController();
    let disconnected = false;
    void sse.closed.then(() => {
      disconnected = true;
      abort.abort();
    });

    try {
      for await (const line of host.streamLogs({
        containerId,
        tail: options.tail,
        follow: options.follow,
        signal: abort.signal,
      })) {
        if (disconnected) break;
        sse.send("line", line);
      }
    } catch (error) {
      // The stream can die mid-flight when the container is removed. Say so on the
      // stream rather than throwing, which at this point would produce a torn response
      // the error handler cannot turn into JSON.
      request.log.error({ err: error, containerId }, "log stream failed");
      sse.send("error", { code: "stream_failed", message: "The stream ended unexpectedly." });
    } finally {
      sse.send("done", {});
      sse.close();
    }
    // Hijacked — nothing to return.
  });
}
