import { type HostCheck, SETUP_STEPS, type SetupState, type SetupStep } from "@shared/setup.js";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/context.js";
import { setupState, users } from "../db/schema.js";

/** The table has exactly one row, `id: 1`, always upserted rather than inserted fresh. */
const SETUP_STATE_ROW_ID = 1;

/**
 * `completed_steps` is a JSON column, and this is the table that decides whether a user
 * can reach the product at all. A hand-edited or otherwise corrupt value degrades to "no
 * steps completed" rather than throwing — that costs a user a step they already did, which
 * is recoverable, instead of a parse error with no route back in.
 */
function parseCompletedSteps(raw: string | null | undefined): SetupStep[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is SetupStep =>
      (SETUP_STEPS as readonly string[]).includes(value),
    );
  } catch {
    return [];
  }
}

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  const countUsers = async () => (await db.select({ id: users.id }).from(users)).length;

  /**
   * Selects `completed_steps` through a raw `sql` projection rather than the schema's
   * typed JSON column. Drizzle's `mode: "json"` parses on the way out of the column-typed
   * path — a corrupt value would throw INSIDE the query, before `parseCompletedSteps` ever
   * sees it, which is exactly the exception this whole function exists to avoid.
   */
  const readStoredSteps = async (): Promise<{ steps: SetupStep[]; completedAt: number | null }> => {
    const [row] = await db
      .select({
        completedStepsRaw: sql<string | null>`${setupState.completedSteps}`,
        completedAt: setupState.completedAt,
      })
      .from(setupState)
      .where(eq(setupState.id, SETUP_STATE_ROW_ID));
    return {
      steps: parseCompletedSteps(row?.completedStepsRaw),
      completedAt: row?.completedAt ?? null,
    };
  };

  /**
   * `admin` is derived from `countUsers() > 0`, never stored. Login.tsx has created the
   * first administrator since Phase 1A, long before this wizard existed, so a stored value
   * could say "not done" while an administrator already exists — and the existing
   * administrator is the fact that matters.
   */
  const readState = async (): Promise<SetupState> => {
    const [{ steps, completedAt }, hasAdmin] = await Promise.all([
      readStoredSteps(),
      countUsers().then((n) => n > 0),
    ]);
    const completed = new Set(steps);
    if (hasAdmin) completed.add("admin");
    return { completedSteps: SETUP_STEPS.filter((step) => completed.has(step)), completedAt };
  };

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

  app.get("/api/setup/state", async (request) => {
    // Admin-only, with one honest exception: before any administrator exists, nobody CAN
    // be authenticated, so `requireAdmin` would always throw here — and the wizard could
    // never render its own first step. `GET /api/setup/status` (src/server/routes/users.ts)
    // faces the identical problem and is fully unauthenticated for the same reason; this
    // route only relaxes as far as that one, and locks down the moment an admin exists.
    if ((await countUsers()) > 0) requireAdmin(request);
    return readState();
  });

  app.post<{ Params: { step: string } }>(
    "/api/setup/state/:step/complete",
    async (request, reply) => {
      requireAdmin(request);

      const { step } = request.params;
      if (!(SETUP_STEPS as readonly string[]).includes(step)) {
        // Rejected, not stored: a typo in a client must not put a value in `completed_steps`
        // that no reader understands.
        return reply.code(400).send({ error: "unknown_step" });
      }

      const { steps: current } = await readStoredSteps();
      const next = current.includes(step as SetupStep) ? current : [...current, step as SetupStep];

      await db
        .insert(setupState)
        .values({ id: SETUP_STATE_ROW_ID, completedSteps: next })
        .onConflictDoUpdate({
          target: setupState.id,
          set: { completedSteps: next, updatedAt: Math.floor(Date.now() / 1000) },
        });

      return readState();
    },
  );

  app.post("/api/setup/finish", async (request) => {
    requireAdmin(request);

    const attemptedAt = Math.floor(Date.now() / 1000);

    // One statement, not check-then-write: COALESCE keeps whichever `completed_at` landed
    // first, so calling this twice — or twice at once — can never move it. The wizard uses
    // this timestamp to refuse re-entry; a moving timestamp would make "was setup finished?"
    // a question with a shifting answer.
    await db
      .insert(setupState)
      .values({ id: SETUP_STATE_ROW_ID, completedAt: attemptedAt })
      .onConflictDoUpdate({
        target: setupState.id,
        set: {
          completedAt: sql`coalesce(${setupState.completedAt}, ${attemptedAt})`,
          updatedAt: attemptedAt,
        },
      });

    return readState();
  });
}
