import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function spaRoutes(app: FastifyInstance): Promise<void> {
  const root = resolve("dist/web");
  if (!existsSync(root)) {
    app.log.warn("dist/web not found; run `pnpm build:web` to serve the SPA");
    return;
  }

  await app.register(fastifyStatic, { root, wildcard: false });

  // History fallback: any non-API path renders the SPA shell.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found", path: request.url });
    }
    return reply.sendFile("index.html", join(root));
  });
}
