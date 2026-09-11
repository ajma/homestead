import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/context.js";

/** A year. The slug is content-addressed by name and upstream icons do not churn. */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function iconRoutes(app: FastifyInstance): Promise<void> {
  const { icons } = app.deps;

  app.get("/api/icons/search", async (request, reply) => {
    // `requireAuth`, not a capability: a viewer needs icons to render their launcher.
    requireAuth(request);
    const query = z
      .object({
        q: z.string().max(64).default(""),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });

    return { icons: icons.metadata.search(query.data.q, query.data.limit) };
  });

  app.get("/api/icons/:file", async (request, reply) => {
    requireAuth(request);
    const params = z.object({ file: z.string().max(80) }).parse(request.params);
    const query = z
      .object({ variant: z.enum(["light", "dark"]).optional() })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });

    const slug = params.file.endsWith(".svg") ? params.file.slice(0, -4) : params.file;
    const body = await icons.store.fetchIcon(slug, query.data.variant ?? null);
    if (!body) return reply.code(404).send({ error: "not_found" });

    return (
      reply
        .header("content-type", "image/svg+xml")
        .header("cache-control", CACHE_CONTROL)
        // The proxy exists partly so a viewer's browser never contacts a CDN. Do not let
        // an SVG's own content reach back out.
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .send(body)
    );
  });
}
