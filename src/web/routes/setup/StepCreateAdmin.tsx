import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { type SyntheticEvent, useState } from "react";
import type { SetupStepProps } from "./SetupWizard";

/**
 * Mirrors `createUserSchema`'s `z.string().min(12)` in `src/server/routes/users.ts` —
 * checked here only so a weak password is refused before a round trip. The server's
 * zod schema stays the actual boundary.
 */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Maps `POST /api/setup/admin`'s error slugs to sentences, following the same shape as
 * `CreateAppDialog`'s `errorMessage`. `already_initialised` is the one slug this route
 * can realistically send here: the bootstrap route closes the instant a user exists, so
 * this fires if a second browser tab (or a stale reload of this very step) tries to
 * bootstrap after another tab already succeeded.
 */
function errorMessage(error: unknown): string {
  if (error instanceof ApiTimeoutError) {
    return "The server did not respond. It may still be working; check again in a moment.";
  }
  if (!(error instanceof ApiError)) {
    return "Could not reach the server. Check the network and try again.";
  }
  if (error.body !== null && typeof error.body === "object" && "error" in error.body) {
    const slug = String((error.body as { error: unknown }).error);
    if (slug === "already_initialised") {
      return "An administrator account already exists. Reload the page to continue.";
    }
    return `Could not create the administrator account (${slug}).`;
  }
  return "Could not create the administrator account.";
}

/**
 * Step 1 of onboarding. `POST /api/setup/admin` is not new here — `Login.tsx` has
 * called it since Phase 1A, to create the very first account when nobody else can log
 * in to invite one. This is a second caller of the same route: it signs the caller in
 * (the response carries the same `Set-Cookie` headers) and, the instant a user exists,
 * closes itself for good — `src/server/routes/users.ts` refuses a second bootstrap
 * with `already_initialised` regardless of which caller gets there first.
 *
 * `admin` is never recorded through `/api/setup/state/:step/complete` — it's derived
 * server-side from whether any user exists (`src/shared/setup.ts`) — so `onComplete`
 * here just tells `SetupWizard` to refetch, not to POST anything.
 *
 * `submitting` is plain state, set synchronously in the submit handler before `mutate`
 * is called, for the reason `CreateAppDialog` and `AdoptDialog` both call out: TanStack's
 * `notifyManager` defers the re-render that would reflect the mutation's own
 * `isPending` through `setTimeout(fn, 0)`, so deriving the disabled state from
 * `mutation.isPending` would leave a synchronous second submit able to slip through
 * before that timer ever fires.
 *
 * `pending` (from `SetupStepProps`) is a separate thing: it's true once this step has
 * called `onComplete` and the *wizard's* completion request is in flight, which for this
 * step is `SetupWizard`'s own `setup.refetch()`. `submitting` guards the POST that
 * creates the account; `pending` guards the moment after, so a stray double-click on
 * "Continue" in the already-done branch — or on this form's own submit button, in the
 * gap between `submitting` resetting to `false` and the step actually advancing —
 * can't fire `onComplete` twice. `SetupWizard` itself also refuses a second call, so
 * this is a courtesy disable, not the only thing standing between here and a double-fire.
 */
export function StepCreateAdmin({ state, onComplete, pending }: SetupStepProps) {
  const alreadyDone = state.completedSteps.includes("admin");
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/setup/admin", {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
      }),
  });

  function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setValidationError("Passwords do not match.");
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    mutation.mutate(undefined, {
      onSuccess: async () => {
        // The route just signed this browser in — matching `Login.tsx`'s own caller so
        // the rest of the app picks up the new session rather than still believing
        // nobody is logged in.
        await queryClient.invalidateQueries({ queryKey: ["me"] });
        setSubmitting(false);
        onComplete();
      },
      onError: () => {
        setSubmitting(false);
      },
    });
  }

  if (alreadyDone) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Create admin</h2>
          <p className="text-sm text-slate-500">An administrator account already exists.</p>
        </div>
        <button
          type="button"
          onClick={onComplete}
          disabled={pending}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? "Continuing…" : "Continue"}
        </button>
      </div>
    );
  }

  const displayedError =
    validationError ?? (mutation.isError ? errorMessage(mutation.error) : null);

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Create admin</h2>
        <p className="text-sm text-slate-500">
          This account becomes the administrator. Once it's created, the bootstrap route closes
          permanently — there is no way back to this step to create a second account.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-900">Name</span>
        <input
          className="rounded-lg border border-slate-300 px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-900">Email</span>
        <input
          className="rounded-lg border border-slate-300 px-3 py-2"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-900">Password</span>
        <input
          className="rounded-lg border border-slate-300 px-3 py-2"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-900">Confirm password</span>
        <input
          className="rounded-lg border border-slate-300 px-3 py-2"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>

      {displayedError && (
        <p role="alert" className="text-sm text-red-600">
          {displayedError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || pending}
        className="w-full rounded-lg bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
      >
        {submitting ? "Creating…" : pending ? "Continuing…" : "Create admin"}
      </button>
    </form>
  );
}
