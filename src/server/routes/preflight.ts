import type { PreflightResult } from "@shared/preflight.js";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../auth/guard.js";

type Opts = {
  preflight: PreflightResult[];
};

export const preflightRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  app.get(
    "/api/preflight",
    { preHandler: requirePermission({ settings: ["read"] }) },
    async () => {
      return { checks: opts.preflight };
    },
  );
};
