import type { HostCheck } from "@shared/setup.js";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/context.js";

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/setup/host-check", async (request) => {
    requireAdmin(request);

    // Read `app.deps` fresh on every request rather than destructuring once at
    // registration: tests override `app.deps.preflight` wholesale (a plain function
    // property, unlike `host`, whose methods are mutated on the same shared object), and
    // a closure that captured the old function at startup would never see the override.
    const { config, host, preflight } = app.deps;

    // Both checks run, and neither can hide the other. A wrong bind mount usually breaks
    // both, and a user who fixes the socket needs to already know the path is wrong too —
    // discovering it one screen later is the failure this whole step exists to prevent.
    const [docker, preflightResult] = await Promise.all([
      host
        .dockerVersion()
        .then((v) => ({ ok: true as const, ...v }))
        .catch((error: unknown) => ({
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        })),
      preflight().catch((error: unknown) => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      })),
    ]);

    return {
      composeRoot: config.composeRoot,
      docker,
      preflight: preflightResult,
    } satisfies HostCheck;
  });
}
