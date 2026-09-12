/**
 * Step 2 of onboarding proves the Docker socket works by showing the daemon's own
 * `docker version` response verbatim, and runs the mount round-trip preflight so a wrong
 * bind mount is caught here — loudly, on screen — rather than surfacing later as a stack
 * that silently starts with empty volumes.
 */
export type HostCheck = {
  composeRoot: string;
  docker:
    | { ok: true; version: string; apiVersion: string; os: string; arch: string }
    | { ok: false; message: string };
  preflight: { ok: true } | { ok: false; reason: string };
};

/**
 * The wizard's own steps, in the order they're presented. `admin` is here even though
 * `POST /api/setup/admin` predates this wizard by four phases (Phase 1A's `Login.tsx`
 * creates the first administrator) — the wizard still needs to know whether that step is
 * done, it just never gets told directly. See `SetupState`.
 */
export const SETUP_STEPS = ["admin", "host", "import", "users"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * `completedSteps` never contains a duplicate and `admin` is derived at read time from
 * whether any user exists, not stored — storing it would let a hand-created admin (via
 * `Login.tsx`) disagree with a row that still says "not done". `completedAt` moves from
 * `null` to a timestamp exactly once; `POST /api/setup/finish` is one-way.
 */
export type SetupState = { completedSteps: SetupStep[]; completedAt: number | null };
