import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { isRoleName, requirePermission } from "./guard.js";
import { roles } from "./permissions.js";
import type { SessionWithUser } from "./plugin.js";

function appWithSession(session: SessionWithUser | null): FastifyInstance {
  const app = Fastify();
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req) => {
    req.session = session;
  });
  app.get(
    "/guarded",
    { preHandler: requirePermission({ compose: ["write"] }) },
    async () => ({ ok: true }),
  );
  return app;
}

const asRole = (role: string): SessionWithUser => ({
  user: { id: "u1", email: "u@example.com", role },
});

describe("requirePermission", () => {
  it("returns 401 with no session", async () => {
    const res = await appWithSession(null).inject({
      method: "GET",
      url: "/guarded",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a viewer", async () => {
    const res = await appWithSession(asRole("viewer")).inject({
      method: "GET",
      url: "/guarded",
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows an admin", async () => {
    const res = await appWithSession(asRole("admin")).inject({
      method: "GET",
      url: "/guarded",
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 for an unknown role rather than failing open", async () => {
    const res = await appWithSession(asRole("wizard")).inject({
      method: "GET",
      url: "/guarded",
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts every role defined in roles object", () => {
    for (const roleName of Object.keys(roles)) {
      expect(isRoleName(roleName)).toBe(true);
    }
  });
});
