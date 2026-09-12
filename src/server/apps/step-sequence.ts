/**
 * Runs a fixed sequence of idempotent steps, and — on failure — rolls back everything
 * that already completed, in reverse order. Pure logic: no Cloudflare, no database, no
 * process spawning. Every later sub-phase's behaviour under failure runs through this.
 *
 * Two rules the signature does not show:
 *
 * 1. The failing step is never undone. Its `run` did not complete, so undoing it would
 *    undo something that never happened — for an idempotent create, that means deleting
 *    a resource someone else owns, not the one this sequence made.
 * 2. An `undo` that throws does not abort the rest of the rollback. Rollback continues
 *    through the failure and keeps going in reverse order, collecting it, because one
 *    cleanup failure must not strand every resource created before it.
 */
export type Step<C> = {
  name: string;
  run(ctx: C): Promise<void>;
  undo?(ctx: C): Promise<void>;
};

export type StepOutcome =
  | { ok: true; completed: string[] }
  | {
      ok: false;
      failed: string;
      error: unknown;
      undone: string[];
      undoFailures: Array<{ step: string; error: unknown }>;
    };

/**
 * Emitted for a step's `run`, and for its `undo` during rollback — start and end of each.
 *
 * The failing `end` carries `error`: a live consumer (the step job runner) sees only
 * these events as they happen, and `StepOutcome` — with its own `error` and
 * `undoFailures` — does not exist yet while rollback is still in progress. Without it
 * here, a real-time transcript could report *that* a step failed but not *why* until the
 * whole sequence (including every remaining undo) has finished.
 */
export type StepEvent =
  | { phase: "run" | "undo"; step: string; stage: "start" }
  | { phase: "run" | "undo"; step: string; stage: "end"; ok: true }
  | { phase: "run" | "undo"; step: string; stage: "end"; ok: false; error: unknown };

/**
 * Calls `onProgress` and swallows anything it throws. A progress callback is a reporting
 * side channel, not a step: `StepJobRunner`'s only consumer today just pushes onto an
 * array, but the one call it makes through `String()` inside `describeError` is not total
 * (a `Symbol`, or an object with a null prototype, throws). If that ever threw during
 * rollback, an unguarded call would escape `rollback` → `runSteps` → the caller's `try`,
 * skipping the terminal-row write the caller does immediately after — the job it was
 * reporting on would never get marked finished because reporting on it failed. A consumer
 * that wants to know it broke should catch its own errors; it must not be able to break
 * the sequence it is merely watching.
 */
function reportProgress(onProgress: (event: StepEvent) => void, event: StepEvent): void {
  try {
    onProgress(event);
  } catch {
    // Deliberately silent — see the function doc. There is nowhere safe to surface this
    // that would not itself risk throwing.
  }
}

export async function runSteps<C>(
  steps: Array<Step<C>>,
  ctx: C,
  opts?: { onProgress?: (event: StepEvent) => void },
): Promise<StepOutcome> {
  const onProgress = opts?.onProgress ?? (() => {});
  const completed: Array<Step<C>> = [];

  for (const step of steps) {
    reportProgress(onProgress, { phase: "run", step: step.name, stage: "start" });
    try {
      await step.run(ctx);
    } catch (error) {
      reportProgress(onProgress, { phase: "run", step: step.name, stage: "end", ok: false, error });
      const { undone, undoFailures } = await rollback(completed, ctx, onProgress);
      return { ok: false, failed: step.name, error, undone, undoFailures };
    }
    reportProgress(onProgress, { phase: "run", step: step.name, stage: "end", ok: true });
    completed.push(step);
  }

  return { ok: true, completed: completed.map((step) => step.name) };
}

/**
 * Undoes `completed` in reverse order. Steps without an `undo` are skipped — a read-only
 * step needs none — without stopping the walk, and a throwing `undo` is caught and
 * recorded rather than allowed to abort the steps still waiting to be undone.
 */
async function rollback<C>(
  completed: Array<Step<C>>,
  ctx: C,
  onProgress: (event: StepEvent) => void,
): Promise<{ undone: string[]; undoFailures: Array<{ step: string; error: unknown }> }> {
  const undone: string[] = [];
  const undoFailures: Array<{ step: string; error: unknown }> = [];

  for (let i = completed.length - 1; i >= 0; i--) {
    const step = completed[i];
    if (!step?.undo) continue;

    reportProgress(onProgress, { phase: "undo", step: step.name, stage: "start" });
    try {
      await step.undo(ctx);
      reportProgress(onProgress, { phase: "undo", step: step.name, stage: "end", ok: true });
      undone.push(step.name);
    } catch (error) {
      reportProgress(onProgress, {
        phase: "undo",
        step: step.name,
        stage: "end",
        ok: false,
        error,
      });
      undoFailures.push({ step: step.name, error });
    }
  }

  return { undone, undoFailures };
}
