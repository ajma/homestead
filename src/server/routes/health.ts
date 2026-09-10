import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    status: "ok",
    version: process.env.npm_package_version ?? "0.0.0",
  }));
}
