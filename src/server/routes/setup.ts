import { type HostCheck, SETUP_STEPS, type SetupState, type SetupStep } from "@shared/setup.js";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAdmin } from "../auth/context.js";
import { setupState, users } from "../db/schema.js";

/** The table has exactly one row, `id: 1`, always upserted rather than inserted fresh. */
const SETUP_STATE_ROW_ID = 1;

/**
 * Optional, and only meaningful for `step === "host"`: the wizard's own `StepVerifyHost`
 * lets someone continue past a failed mount preflight on purpose (see that component's
 * doc comment), but nothing recorded that they did. The client sends exactly the
 * `HostCheck.preflight` failure it already showed on screen — this route doesn't
 * re-run the preflight itself, both because that would double the container cost of a
 * completion that already ran it once (via `GET /api/setup/host-check`) and because the
 * point is to record what the user actually SAW, not to re-derive a fresh answer that
 * might have changed under them.
 */
const completeStepBody = z
  .object({
    preflightOverride: z.object({ reason: z.string() }).optional(),
  })
  .optional();

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

  // Each preflight run starts a real container: image-ensure, create, attach, start,
  // wait, remove. The wizard's re-check button is exactly where a user clicks
  // repeatedly while fixing a bind mount, so concurrent requests share one in-flight
  // run rather than each launching their own container. Cleared once the run settles
  // (success or failure) so the NEXT request, after this one finishes, starts fresh.
  let inFlightPreflight: ReturnType<typeof app.deps.preflight> | null = null;
  const runPreflightOnce = (): ReturnType<typeof app.deps.preflight> => {
    if (!inFlightPreflight) {
      inFlightPreflight = app.deps.preflight().finally(() => {
        inFlightPreflight = null;
      });
    }
    return inFlightPreflight;
  };

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
    // `runPreflightOnce` reads `app.deps.preflight` itself, at call time, for the same
    // reason.
    const { config, host } = app.deps;

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
      runPreflightOnce().catch((error: unknown) => ({
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
      const ctx = requireAdmin(request);

      const { step } = request.params;
      if (!(SETUP_STEPS as readonly string[]).includes(step)) {
        // Rejected, not stored: a typo in a client must not put a value in `completed_steps`
        // that no reader understands.
        return reply.code(400).send({ error: "unknown_step" });
      }

      const body = completeStepBody.parse(request.body);
      if (step === "host" && body?.preflightOverride) {
        // A breadcrumb, not a gate — this must never block completing the step. The
        // failure this exists to catch (spec §10: a host-invalid bind source silently
        // created as an empty directory) can surface weeks later, long after the wizard
        // is gone; this is what points back at the warning someone clicked past.
        await audit(db, ctx, {
          action: "setup.host_preflight_overridden",
          detail: { reason: body.preflightOverride.reason },
        });
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
