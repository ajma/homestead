import { fromNodeHeaders } from "better-auth/node";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { Auth } from "./index.js";

export type SessionWithUser = {
  user: { id: string; email: string; role: string | null | undefined };
};

declare module "fastify" {
  interface FastifyRequest {
    session: SessionWithUser | null;
  }
}

const plugin: FastifyPluginAsync<{ auth: Auth }> = async (app, { auth }) => {
  app.decorateRequest("session", null);

  app.addHook("onRequest", async (request) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      request.session = (session as SessionWithUser | null) ?? null;
    } catch (error) {
      request.log.error(error, "Failed to get session");
      request.session = null;
    }
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);

      // D1: Block self-registration over HTTP - admin-managed accounts only
      // This guard rejects sign-up requests arriving over HTTP with 403
      // while leaving server-side auth.api.signUpEmail() calls working
      if (url.pathname.startsWith("/api/auth/sign-up")) {
        return reply.status(403).send({ error: "Sign-up is disabled" });
      }
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);
      reply.status(response.status);
      for (const [key, value] of response.headers) {
        reply.header(key, value);
      }
      return reply.send(response.body ? await response.text() : null);
    },
  });
};

export const authPlugin = fp(plugin);
