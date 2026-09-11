import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/context.js";

/**
 * A day, and deliberately **not** `immutable`.
 *
 * A slug is addressed by name, not by content: upstream can replace `jellyfin.svg` under
 * the same URL, and Homestead's own disk cache never expires either. With a year and
 * `immutable` there was no recovery lever at all — one wrong or truncated icon and every
 * viewer's browser holds it until they clear site data, which is not an instruction you
 * can give a housemate.
 *
 * A day is still one request per browser per icon per day for a file served off the LAN,
 * and it bounds the blast radius of a bad cache entry to something an admin can wait out.
 * Purging the server's disk cache is still manual — see the phase carry-forward.
 */
const CACHE_CONTROL = "public, max-age=86400";

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
        // The content-type above is hardcoded, never taken from upstream, so a sniffing
        // browser is the only way this body gets interpreted as anything else.
        .header("x-content-type-options", "nosniff")
        .send(body)
    );
  });
}
