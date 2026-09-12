import { SETUP_STEPS, type SetupState, type SetupStep } from "@shared/setup.js";
import { useCompleteStep, useSetupState } from "@web/api/setup";
import { useState } from "react";
import { StepCreateAdmin } from "./StepCreateAdmin";
import { StepVerifyHost } from "./StepVerifyHost";

const STEP_LABELS: Record<SetupStep, string> = {
  admin: "Create admin",
  host: "Verify host",
  import: "Import",
  users: "Invite users",
};

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
  onComplete: () => void;
};

function StepPlaceholder({ step }: SetupStepProps & { step: SetupStep }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{STEP_LABELS[step]}</h2>
      <p className="text-sm text-slate-500">Built in a later task.</p>
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

function SetupUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        <h1 className="text-lg font-semibold">Setup status unavailable</h1>
        <p className="text-sm text-slate-500">
          Homestead could not check how far setup has gotten. Nothing has been lost — try again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white"
        >
          Try again
        </button>
      </div>
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

  if (setup.isPending) {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  }

  // A failed fetch is the one case this route can't render past — it's the answer that
  // decides whether the visitor can use the product at all — so it gets its own screen
  // with a retry rather than an empty page or a thrown error.
  if (setup.isError) {
    return <SetupUnavailable onRetry={() => setup.refetch()} />;
  }

  const state = setup.data;
  const current = resumeStep(state);
  const displayed: WizardStep = reviewStep ?? current;
  const displayedIndex = stepIndex(displayed);

  function goBack() {
    const previous = SETUP_STEPS[displayedIndex - 1];
    if (previous !== undefined) setReviewStep(previous);
  }

  /** What "this step is done" means, decided here rather than inside the step itself —
   * `admin` is never posted (it's true exactly when a user exists; the step only needs
   * to trigger a fresh read), everything else records itself through the shared
   * `.../complete` endpoint. Also drops any review override, since finishing a step is
   * exactly the moment the resume point is allowed to move again. */
  function markComplete(step: SetupStep) {
    setReviewStep(null);
    if (step === "admin") {
      setup.refetch();
    } else {
      completeStep.mutate(step);
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

      {displayed === "finish" ? (
        <FinishPlaceholder />
      ) : displayed === "admin" ? (
        <StepCreateAdmin state={state} onComplete={() => markComplete(displayed)} />
      ) : displayed === "host" ? (
        <StepVerifyHost state={state} onComplete={() => markComplete(displayed)} />
      ) : (
        <StepPlaceholder
          step={displayed}
          state={state}
          onComplete={() => markComplete(displayed)}
        />
      )}
    </div>
  );
}
