import { type HostCheck, SETUP_STEPS, type SetupState, type SetupStep } from "@shared/setup.js";
import { useQueryClient } from "@tanstack/react-query";
import { useAdminApps } from "@web/api/admin";
import { useCloudflareStatus } from "@web/api/cloudflare";
import { hostCheckKey, useCompleteStep, useFinishSetup, useSetupState } from "@web/api/setup";
import { useUsers } from "@web/api/users";
import { useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { StepCloudflare } from "./StepCloudflare";
import { StepCreateAdmin } from "./StepCreateAdmin";
import { StepImport } from "./StepImport";
import { StepInviteUsers } from "./StepInviteUsers";
import { StepVerifyHost } from "./StepVerifyHost";

const STEP_LABELS: Record<SetupStep, string> = {
  admin: "Create admin",
  host: "Verify host",
  import: "Import",
  cloudflare: "Cloudflare",
  users: "Invite users",
};

/** Spec §9: the steps a person is allowed to skip outright. Computed here rather than
 * hard-coded in each step, so `import`/`cloudflare`/`users` (and anything added later)
 * don't each need their own copy of this list — see `SetupStepProps.skippable`.
 * `cloudflare` (2F Task 5) belongs here for the same reason `StepCloudflare`'s own doc
 * comment gives: a wizard that could not finish without a Cloudflare account would block
 * every household that doesn't have one, and §6/§10 both promise it can be done later. */
const SKIPPABLE_STEPS: readonly SetupStep[] = ["import", "cloudflare", "users"];

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
   * retry screen already do). `StepCloudflare` is the first caller — a save that fails
   * verification has nowhere else in this shell to put the message. */
  onFail: (message: string) => void;
  /** True for a step spec §9 allows skipping (`import`, `cloudflare`, `users`) — told to
   * the step rather than left for each one to hard-code which category it's in. */
  skippable: boolean;
};

/**
 * Step 6, reached only once `resumeStep` returns `"finish"` — which only happens once
 * every entry in `SETUP_STEPS` is in `completedSteps` (see that function above). That is
 * the wizard's own gate on reachability: `POST /api/setup/finish` (`src/server/routes/setup.ts`)
 * itself is permissive — admin-only, but with no check on which steps are complete,
 * only a COALESCE that keeps it one-way — precisely because it was never meant to be the
 * thing standing between a click and a premature finish. This component, and the fact
 * that nothing else in this file can reach it early, is that gate.
 *
 * `useAdminApps`/`useUsers` are the same two lists `AdminApps` and `Settings` already
 * read — no new endpoint. Onboarding is the one moment their raw counts are exactly the
 * summary a person wants: nothing could have been adopted or invited before this wizard
 * ran, so "how many rows are in each list" and "what did I just do" are the same
 * question. `invitedCount` subtracts one for the administrator Step 1 always creates
 * before this screen is reachable — the founder wasn't "invited", they signed
 * themselves up, and the sentence below is about the household, not about them.
 *
 * `useCloudflareStatus` gates the Cloudflare sentence — 2F added a Cloudflare step
 * between this screen's writing and its own arrival, and the sentence used to say
 * unconditionally that Cloudflare "isn't set up yet" even for someone who just watched a
 * tunnel provision on the previous screen (Phase 2F whole-branch review, F6).
 */
function FinishScreen({ state }: { state: SetupState }) {
  const apps = useAdminApps();
  const users = useUsers();
  const cloudflareStatus = useCloudflareStatus();
  const finishSetup = useFinishSetup();
  const [error, setError] = useState<string | null>(null);
  // Set synchronously in the click handler, before `mutate` — the same reason every
  // other submit guard in this wizard (`StepCreateAdmin`'s `submitting`, `SetupWizard`'s
  // own `pendingRef`) is plain state rather than derived from the mutation's own
  // `isPending`: TanStack's `notifyManager` defers that through `setTimeout(fn, 0)`,
  // which would leave a synchronous second click able to fire a second `POST
  // /api/setup/finish` before the first one's `isPending` ever flipped true.
  const [finishing, setFinishing] = useState(false);

  // Reached once this mutation's own success writes a fresh `completedAt` into the
  // shared `["setup-state"]` cache `useSetupState` reads — or, on a reload that lands
  // straight here with setup already finished, without this screen's button ever having
  // been pressed in this session at all. Either way, this is the one-way door: once
  // `completedAt` is set, there is nothing left for this screen to do, and leaving one
  // rendered would let a second admin dismiss the summary and still be looking at the
  // wizard.
  if (state.completedAt != null) return <Navigate to="/" replace />;

  const appCount = apps.data?.length ?? 0;
  const invitedCount = Math.max((users.data?.length ?? 0) - 1, 0);

  function handleFinish() {
    if (finishing) return;
    setFinishing(true);
    setError(null);
    finishSetup.mutate(undefined, {
      onError: () => {
        setFinishing(false);
        setError("Could not finish setup. Try again.");
      },
      // No `onSuccess` reset of `finishing`: success moves `state.completedAt` off
      // `null`, which takes this component to the `<Navigate>` branch above on the very
      // next render — there is no "done, but still showing this button" state to unwind
      // back into.
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">You're set up</h2>
        <p className="text-sm text-slate-700">
          {appCount} {appCount === 1 ? "app" : "apps"} adopted, {invitedCount}{" "}
          {invitedCount === 1 ? "user" : "users"} invited.
        </p>
        <p className="text-sm text-slate-500">
          {cloudflareStatus.data?.configured === true
            ? "Cloudflare exposure is set up — apps can be exposed from their own Exposure tab."
            : "Cloudflare exposure isn't set up yet — that's fine, it can be turned on later from Settings."}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleFinish}
        disabled={finishing}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {finishing ? "Finishing…" : "Finish setup"}
      </button>
    </div>
  );
}

type WizardStep = SetupStep | "finish";

/**
 * First step not yet in `completedSteps`, or `"finish"` once all five are. Computed
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
  const queryClient = useQueryClient();
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
  // disable its own control while `pending` is true — `SetupWizard.test.tsx`'s "does
  // not double-fire" test proves this holds regardless of what a given step's own Skip
  // button does or doesn't guard against.
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
      // `StepVerifyHost`'s own `useHostCheck` query (`gcTime: 0`) is still active — and
      // its cached answer still in the shared query client — for as long as that step
      // stays mounted, which it is right up to the moment its own `onComplete` fires
      // this. Reading it here, rather than widening `SetupStepProps.onComplete` to carry
      // a payload every other step would have to ignore, tells the server exactly what
      // the user saw without re-running the (costly, container-spinning) preflight.
      const hostCheck =
        step === "host" ? queryClient.getQueryData<HostCheck>(hostCheckKey) : undefined;
      const preflightOverride =
        hostCheck && !hostCheck.preflight.ok ? { reason: hostCheck.preflight.reason } : undefined;
      completeStep.mutate({ step, preflightOverride }, { onSettled: settle });
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
        <FinishScreen state={state} />
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
      ) : displayed === "cloudflare" ? (
        <StepCloudflare
          state={state}
          pending={pending}
          onComplete={() => markComplete(displayed)}
          onFail={setStepError}
          skippable={skippable}
        />
      ) : (
        <StepInviteUsers
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
