import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCapability } from "../auth/context.js";
import { probes } from "../db/schema.js";
import { isValidStatusPattern } from "../monitoring/status-pattern.js";
import { loadApp } from "./apps.js";

/** The server fetches this URL. Anything but http(s) is an SSRF primitive. */
const targetSchema = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "target must be an http or https URL");

const createBody = z
  .object({
    kind: z.enum(["docker", "http_internal", "http_external"]),
    target: targetSchema.optional(),
    label: z.string().min(1).optional(),
    // Validated here, not just matched at runtime. The matcher fails closed, so `2x`
    // silently takes the app red with nothing saying the pattern is the problem.
    expectedStatusPattern: z
      .string()
      .refine(isValidStatusPattern, "not a status pattern")
      .optional(),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
    intervalSeconds: z.number().int().min(10).max(86_400).optional(),
    // Not accepted while it does nothing. Node's `fetch` has no per-request TLS option,
    // so the runner cannot honour this, and a switch that silently has no effect is worse
    // than an absent one: a user with a self-signed LAN certificate would turn it on,
    // watch the probe keep failing, and have no way to tell why.
    insecureTls: z.literal(false).optional(),
  })
  .refine((body) => body.kind === "docker" || body.target !== undefined, {
    message: "an http probe needs a target",
  });

/**
 * Configuration only — never the denormalised state columns.
 *
 * `lastStatus`, `statusSince`, `consecutiveFailures` and their siblings have exactly one
 * writer, `persistResult`, and that is the whole reason the launcher can read them with
 * one indexed query and no aggregation. A second writer here would desynchronise them
 * from `check_results` silently.
 */
const patchBody = z.object({
  label: z.string().min(1).nullable().optional(),
  target: targetSchema.optional(),
  expectedStatusPattern: z.string().refine(isValidStatusPattern, "not a status pattern").optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  intervalSeconds: z.number().int().min(10).max(86_400).optional(),
  insecureTls: z.literal(false).optional(),
  enabled: z.boolean().optional(),
});

export async function probeRoutes(app: FastifyInstance): Promise<void> {
  const { db, composeConfig } = app.deps;

  /** Loads a probe and checks the caller may see its app. 404 either way. */
  async function loadProbe(ctx: Parameters<typeof loadApp>[1], probeId: string) {
    const [probe] = await db.select().from(probes).where(eq(probes.id, probeId));
    if (!probe) return null;
    return (await loadApp(db, ctx, probe.appId)) ? probe : null;
  }

  app.get("/api/apps/:id/probes", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!(await loadApp(db, ctx, id))) return reply.code(404).send({ error: "not_found" });
    return db.select().from(probes).where(eq(probes.appId, id));
  });

  app.get("/api/apps/:id/probes/suggestions", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = await loadApp(db, ctx, id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    const resolved = await composeConfig.resolve({
      directory: row.directory,
      composeFile: row.composeFile,
    });
    if (!resolved.valid) return [];
    // Published ports are the only thing here that reliably names a reachable endpoint.
    return resolved.resolved.services.flatMap((service) =>
      service.publishedPorts.map((port) => ({
        service: service.name,
        target: `http://localhost:${port}`,
      })),
    );
  });

  app.post("/api/apps/:id/probes", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!(await loadApp(db, ctx, id))) return reply.code(404).send({ error: "not_found" });
    const body = createBody.parse(request.body);

    if (body.kind !== "http_internal") {
      // Exactly one docker probe per app, and exactly one external probe per exposure.
      const existing = await db
        .select()
        .from(probes)
        .where(and(eq(probes.appId, id), eq(probes.kind, body.kind)));
      if (existing.length > 0) {
        return reply.code(409).send({ error: "probe_exists" });
      }
    }

    const probeId = ulid();
    await db.insert(probes).values({ id: probeId, appId: id, ...body });
    const [created] = await db.select().from(probes).where(eq(probes.id, probeId));
    return reply.code(201).send(created);
  });

  app.patch("/api/probes/:probeId", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { probeId } = z.object({ probeId: z.string() }).parse(request.params);
    if (!(await loadProbe(ctx, probeId))) return reply.code(404).send({ error: "not_found" });
    const body = patchBody.parse(request.body);
    if (Object.keys(body).length === 0) return reply.code(400).send({ error: "no_fields" });

    await db.update(probes).set(body).where(eq(probes.id, probeId));
    const [updated] = await db.select().from(probes).where(eq(probes.id, probeId));
    return updated;
  });

  app.delete("/api/probes/:probeId", async (request, reply) => {
    const ctx = requireCapability(request, "app:config");
    const { probeId } = z.object({ probeId: z.string() }).parse(request.params);
    if (!(await loadProbe(ctx, probeId))) return reply.code(404).send({ error: "not_found" });
    await db.delete(probes).where(eq(probes.id, probeId));
    return reply.code(204).send();
  });
}
