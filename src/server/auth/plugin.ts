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

/**
 * Narrows Better-Auth's `getSession()` result to the shape the guard relies on.
 *
 * The previous `as SessionWithUser` cast was unchecked: if a Better-Auth
 * upgrade re-nested the session, `session.user` would silently become
 * undefined and every guarded route would throw a 500 inside its preHandler.
 * Anything that does not carry a usable `user` is treated as no session, so a
 * malformed value denies access instead of propagating.
 *
 * `role` may legitimately be null or undefined (Better-Auth only assigns a role
 * on sign-up); such a session is still returned so `requirePermission` answers
 * 403 forbidden rather than 401 unauthenticated.
 */
export function toSessionWithUser(value: unknown): SessionWithUser | null {
  if (typeof value !== "object" || value === null) return null;
  const user = (value as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const { id, email, role } = user as Record<string, unknown>;
  if (typeof id !== "string" || typeof email !== "string") return null;
  if (role !== null && role !== undefined && typeof role !== "string") {
    return null;
  }
  return { user: { id, email, role } };
}

const plugin: FastifyPluginAsync<{ auth: Auth }> = async (app, { auth }) => {
  app.decorateRequest("session", null);

  app.addHook("onRequest", async (request) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      request.session = toSessionWithUser(session);
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
