import { SETUP_STEPS, type SetupState, type SetupStep } from "@shared/setup.js";
import { useCompleteStep, useSetupState } from "@web/api/setup";
import { useRef, useState } from "react";
import { StepCreateAdmin } from "./StepCreateAdmin";
import { StepImport } from "./StepImport";
import { StepVerifyHost } from "./StepVerifyHost";

const STEP_LABELS: Record<SetupStep, string> = {
  admin: "Create admin",
  host: "Verify host",
  import: "Import",
  users: "Invite users",
};

/** Spec §9: the only two steps a person is allowed to skip outright. Computed here
 * rather than hard-coded in each step, so `import`/`users` (and anything added later)
 * don't each need their own copy of this list — see `SetupStepProps.skippable`. */
const SKIPPABLE_STEPS: readonly SetupStep[] = ["import", "users"];

/**
 * The shape every real step substitutes into this slot (Tasks 4, 5, 6 and 8 each add
 * one `Step*.tsx` taking exactly this). `state` is the full server answer rather than a
 * narrower "is this step done" boolean, because a step needs it to render itself as
 * already-done chrome when reached via Back (`StepCreateAdmin`'s "renders as
 * already-done, with no form, when a user already exists" is the concrete case). A step
 * never records its own completion directly — it calls `onComplete` and lets
 * `SetupWizard` decide what "done" means for that particular step, which is what keeps
 * `admin` (derived, never posted) and the rest (posted to
 * `/api/setup/state/:step/complete`) behind one uniform interface.
 */
export type SetupStepProps = {
  state: SetupState;
  /** True while `onComplete` (for this step or any other) has been called and the
   * wizard's own completion request — `refetch()` for `admin`, `completeStep.mutate()`
   * for the rest — hasn't settled yet. A step uses this to disable its own advance
   * control while it saves. Distinct from any in-flight request a step makes for its
   * own purpose: `StepCreateAdmin`'s account-creation submit keeps its own separate
   * `submitting` guard, because that request and the wizard's completion request are
   * two different things that happen to usually follow one another. */
  pending: boolean;
  onComplete: () => void;
  /** Reports a failure to the wizard shell, for the case a step can't just render its
   * own inline error (the way `StepCreateAdmin`'s validation and `StepVerifyHost`'s
   * retry screen already do). Nothing currently calls this — it exists so a future step
   * has somewhere to put a failure instead of swallowing it or reinventing a channel. */
  onFail: (message: string) => void;
  /** True for a step spec §9 allows skipping (`import`, `users`) — told to the step
   * rather than left for each one to hard-code which category it's in. */
  skippable: boolean;
};

function StepPlaceholder({ step, skippable, onComplete }: SetupStepProps & { step: SetupStep }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{STEP_LABELS[step]}</h2>
        <p className="text-sm text-slate-500">Built in a later task.</p>
      </div>
      {skippable && (
        // Deliberately does not disable itself while `pending` — this is a stand-in for
        // a step Tasks 6/8 haven't built yet, not a model for one to copy. It's the
        // concrete case proving `SetupWizard`'s own double-call guard on `onComplete`
        // holds even when a step author forgets to wire up `pending` themselves.
        <button
          type="button"
          onClick={onComplete}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          Skip
        </button>
      )}
    </div>
  );
}

function FinishPlaceholder() {
  return (
    <div>
      <h2 className="text-lg font-semibold">Done</h2>
      <p className="text-sm text-slate-500">Built in a later task.</p>
    </div>
  );
}

type WizardStep = SetupStep | "finish";

/**
 * First step not yet in `completedSteps`, or `"finish"` once all four are. Computed
 * fresh from the server's own answer on every render — this is the resume point, and
 * the entire reason this phase exists is that it must never come from local navigation
 * state: a reload has to land here, not wherever the user last clicked.
 */
function resumeStep(state: SetupState): WizardStep {
  return SETUP_STEPS.find((step) => !state.completedSteps.includes(step)) ?? "finish";
}

function stepIndex(step: WizardStep): number {
  return step === "finish" ? SETUP_STEPS.length : SETUP_STEPS.indexOf(step);
}

export function SetupWizard() {
  const setup = useSetupState();
  const completeStep = useCompleteStep();
  // Local-only, and deliberately never reflected in the URL or any storage: a reload
  // must forget this and fall back to `resumeStep`. It exists solely so someone can
  // glance back at an earlier, already-completed step — reviewing it must not become
  // the new resume point just because the tab got closed mid-glance.
  const [reviewStep, setReviewStep] = useState<SetupStep | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  // Guards `markComplete` against a second call while one is already in flight — set
  // synchronously, before either `refetch()` or `completeStep.mutate()` is called, for
  // the same reason `StepCreateAdmin`'s own `submitting` state is: TanStack's
  // `notifyManager` defers the re-render that would reflect a mutation's/query's own
  // `isPending`/`isFetching` through `setTimeout(fn, 0)`, so deriving this guard from
  // either would leave a synchronous second call able to slip through first. Living
  // here, not inside each step, is what makes it hold even when a step forgets to
  // disable its own control while `pending` is true (see `StepPlaceholder`'s Skip
  // button).
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);

  // `App.tsx`'s `Routed` gates every route, including this one, on this same
  // `["setup-state"]` query before it ever mounts `<SetupWizard>` — by the time this
  // renders, that query has already succeeded there, and the shared cache means it has
  // succeeded here too. Its pending and error states are owned by `App.tsx`, not this
  // component; see `Routed`'s own `setup.isPending`/`setup.isError` handling. The check
  // below is pure type-narrowing (`setup.data` is typed `SetupState | undefined`, and
  // TypeScript can't see the guarantee `App.tsx` already provided) — it cannot actually
  // be reached while this component is mounted through the real route tree.
  if (!setup.data) return null;
  const state = setup.data;
  const current = resumeStep(state);
  const displayed: WizardStep = reviewStep ?? current;
  const displayedIndex = stepIndex(displayed);
  const skippable = displayed !== "finish" && SKIPPABLE_STEPS.includes(displayed);

  function goBack() {
    const previous = SETUP_STEPS[displayedIndex - 1];
    if (previous !== undefined) {
      setStepError(null);
      setReviewStep(previous);
    }
  }

  /** What "this step is done" means, decided here rather than inside the step itself —
   * `admin` is never posted (it's true exactly when a user exists; the step only needs
   * to trigger a fresh read), everything else records itself through the shared
   * `.../complete` endpoint. Also drops any review override, since finishing a step is
   * exactly the moment the resume point is allowed to move again.
   *
   * Guarded by `pendingRef` against a second call arriving before the first's request
   * has settled — see that ref's own comment for why this can't be derived from
   * `setup.isFetching`/`completeStep.isPending` instead. */
  function markComplete(step: SetupStep) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setReviewStep(null);
    setStepError(null);

    function settle() {
      pendingRef.current = false;
      setPending(false);
    }

    if (step === "admin") {
      setup.refetch().finally(settle);
    } else {
      completeStep.mutate(step, { onSettled: settle });
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
        {SETUP_STEPS.map((step) => {
          const done = state.completedSteps.includes(step);
          return (
            <li key={step} aria-current={step === displayed ? "step" : undefined}>
              {STEP_LABELS[step]}
              {done ? " (done)" : ""}
            </li>
          );
        })}
      </ol>

      {displayedIndex > 0 && (
        <button
          type="button"
          onClick={goBack}
          className="text-sm text-slate-500 underline underline-offset-2"
        >
          Back
        </button>
      )}

      {stepError && (
        <p role="alert" className="text-sm text-red-600">
          {stepError}
        </p>
      )}

      {displayed === "finish" ? (
        <FinishPlaceholder />
      ) : displayed === "admin" ? (
        <StepCreateAdmin
          state={state}
          pending={pending}
          onComplete={() => markComplete(displayed)}
          onFail={setStepError}
          skippable={skippable}
        />
      ) : displayed === "host" ? (
        <StepVerifyHost
          state={state}
          pending={pending}
          onComplete={() => markComplete(displayed)}
          onFail={setStepError}
          skippable={skippable}
        />
      ) : displayed === "import" ? (
        <StepImport
          state={state}
          pending={pending}
          onComplete={() => markComplete(displayed)}
          onFail={setStepError}
          skippable={skippable}
        />
      ) : (
        <StepPlaceholder
          step={displayed}
          state={state}
          pending={pending}
          onComplete={() => markComplete(displayed)}
          onFail={setStepError}
          skippable={skippable}
        />
      )}
    </div>
  );
}
