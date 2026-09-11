/**
 * Whether `graceUntil` (unix seconds, as `apps.graceUntil` stores it) still protects a
 * stack from being read as failed.
 *
 * `job-runner.ts` writes it after a lifecycle action so a stack mid-`docker compose up`
 * reads as `starting` rather than `down` for the ~2 minutes containers take to come up.
 * Both `statusFor` (the live rollup `/api/apps` and the edit header show) and
 * `applyTransition` (the probe pipeline the launcher shows) need the identical answer to
 * the identical question, or the two disagree for the whole window — see the 1E
 * final-fix brief, Important 1, where they did exactly that: the same app, the same
 * instant, `down` from one and `starting` from the other.
 */
export function inGraceWindow(graceUntil: number | null, nowSeconds: number): boolean {
  return graceUntil !== null && graceUntil > nowSeconds;
}
