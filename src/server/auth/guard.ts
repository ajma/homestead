import type { preHandlerHookHandler } from "fastify";
import { roles } from "./permissions.js";

type RoleName = keyof typeof roles;

const roleNames = Object.keys(roles) as RoleName[];

export function isRoleName(
  value: string | null | undefined,
): value is RoleName {
  return (
    value !== null &&
    value !== undefined &&
    roleNames.includes(value as RoleName)
  );
}

export function requirePermission(
  permission: Record<string, string[]>,
): preHandlerHookHandler {
  return async (request, reply) => {
    const session = request.session;
    if (!session) return reply.status(401).send({ error: "unauthenticated" });

    const roleName = session.user.role;
    if (!isRoleName(roleName))
      return reply.status(403).send({ error: "forbidden" });

    // biome-ignore lint/suspicious/noExplicitAny: statement shape is dynamic per call site
    const decision = roles[roleName].authorize(permission as any);
    if (!decision.success)
      return reply.status(403).send({ error: "forbidden" });
  };
}
