import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  claimAdminBootstrap,
  releaseAdminBootstrap,
} from "../auth/bootstrap.js";
import type { Auth } from "../auth/index.js";
import type { Db } from "../db/client.js";
import { user } from "../db/schema.js";

const bodySchema = z.object({
  email: z.email(),
  name: z.string().min(1),
  password: z.string().min(12).max(128),
});

export const onboardingRoutes: FastifyPluginAsync<{
  db: Db;
  auth: Auth;
}> = async (app, { db, auth }) => {
  app.post("/api/onboarding/admin", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "invalid_body", issues: parsed.error.issues });
    }

    if (!(await claimAdminBootstrap(db))) {
      return reply.status(409).send({ error: "already_initialised" });
    }

    let created: Awaited<ReturnType<typeof auth.api.signUpEmail>>;
    try {
      created = await auth.api.signUpEmail({ body: parsed.data });
    } catch (err) {
      await releaseAdminBootstrap(db);
      request.log.error({ err }, "admin bootstrap failed");
      return reply.status(400).send({ error: "signup_failed" });
    }

    try {
      await db
        .update(user)
        .set({ role: "admin" })
        .where(eq(user.id, created.user.id));
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err }, "role promotion failed");
      return reply.status(500).send({ error: "internal_error" });
    }
  });
};
