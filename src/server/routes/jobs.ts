import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { JOB_KINDS, JobBusyError, type JobKind } from "../apps/job-runner.js";
import { audit } from "../audit.js";
import { requireCapability } from "../auth/context.js";
import { jobs } from "../db/schema.js";
import { sseResponse } from "../sse.js";
import { loadApp } from "./apps.js";

const kindSchema = z.enum(JOB_KINDS);

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const { db, jobs: runner } = app.deps;

  app.post("/api/apps/:id/actions/:kind", async (request, reply) => {
    const ctx = requireCapability(request, "app:lifecycle");
    const params = z.object({ id: z.string(), kind: z.string() }).parse(request.params);

    // Parsed against a closed set before anything reaches the host. The action never
    // becomes an argument the caller chose — `ARGS` in the runner owns that mapping.
    const kind = kindSchema.safeParse(params.kind);
    if (!kind.success) {
      return reply
        .code(400)
        .send({ error: "unknown_action", message: `Unknown action: ${params.kind}` });
    }

    const row = await loadApp(db, ctx, params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    try {
      const job = await runner.start(row, kind.data as JobKind, ctx.userId);
      await audit(db, ctx, {
        action: `app.${kind.data}`,
        targetType: "app",
        targetId: row.id,
        ip: request.ip,
      });
      return reply.code(202).send({ jobId: job.id });
    } catch (error) {
      if (error instanceof JobBusyError) {
        return reply.code(409).send({
          error: "job_running",
          message: "Another job is already running for this app.",
          runningJobId: error.runningJobId,
        });
      }
      throw error;
    }
  });

  app.get("/api/jobs/:jobId", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job?.appId) return reply.code(404).send({ error: "not_found" });
    // Scope is a property of the app, so it is checked against the app, not the job row.
    if (!(await loadApp(db, ctx, job.appId))) return reply.code(404).send({ error: "not_found" });
    return job;
  });

  app.get("/api/apps/:id/jobs", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return db.select().from(jobs).where(eq(jobs.appId, id)).orderBy(desc(jobs.createdAt)).limit(20);
  });

  app.get("/api/jobs/:jobId/stream", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params);

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!job?.appId) return reply.code(404).send({ error: "not_found" });
    if (!(await loadApp(db, ctx, job.appId))) return reply.code(404).send({ error: "not_found" });

    const live = runner.live(jobId);
    const sse = sseResponse(request, reply);

    if (!live) {
      // Already finished. Send what was persisted and close, so the client does not have
      // to know whether it attached in time.
      sse.send("output", { text: job.output ?? "", stream: "stdout" });
      sse.send("done", { status: job.status, exitCode: job.exitCode });
      sse.close();
      return;
    }

    // `disconnected` is only consulted when a chunk arrives, so a client leaving during
    // a silent stretch of a ten-minute `pull` is not noticed until the next chunk or the
    // job's end. That holds one request object, a few KB, for the remainder — accepted
    // rather than racing the iteration against `sse.closed`, which needs a second promise
    // per chunk to save almost nothing.
    let disconnected = false;
    void sse.closed.then(() => {
      disconnected = true;
    });

    // Everything after the hijack goes in a try/finally. Fastify no longer owns the
    // reply, so a throw here reaches `setErrorHandler`, which calls `reply.send()` on a
    // socket whose headers have already gone out: it cannot report the error, and the
    // stream is never closed, leaving the heartbeat running forever.
    let finished: typeof jobs.$inferSelect | undefined;
    try {
      for await (const chunk of live.output) {
        if (disconnected) break;
        sse.send("output", chunk);
      }
      await live.done;
      [finished] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    } catch (error) {
      request.log.error({ err: error, jobId }, "job stream failed");
      sse.send("error", { message: error instanceof Error ? error.message : "job stream ended" });
    } finally {
      sse.send("done", {
        status: finished?.status ?? "failed",
        exitCode: finished?.exitCode ?? null,
      });
      sse.close();
    }
    // No `return reply`: the reply is hijacked, so returning it would ask Fastify to
    // send a second response over a socket we have already written to and closed.
  });
}
