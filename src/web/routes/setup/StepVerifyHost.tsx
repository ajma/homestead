import { HostCheckPanel } from "./HostCheckPanel";
import type { SetupStepProps } from "./SetupWizard";

/**
 * Step 2 of onboarding: `GET /api/setup/host-check` proves the Docker socket works by
 * returning the daemon's own `docker version` response, and runs the mount round-trip
 * preflight (`src/server/host/preflight.ts`) so a wrong bind mount is caught here,
 * loudly, rather than later during a deploy — spec §10's failure mode for that is a
 * stack that starts successfully with none of the user's data, because Docker resolves
 * a host-invalid bind source by silently creating it as an empty directory.
 *
 * The check itself — `useHostCheck`, the compose root/Docker/preflight display, and the
 * Re-check button — lives in `HostCheckPanel`, shared verbatim with `Settings`'
 * "later" host check (spec §9). This component supplies only what's specific to being a
 * wizard step: the intro copy and the Continue button, passed as `HostCheckPanel`'s
 * `footer`.
 *
 * Continuing past a failed preflight is a deliberate ruling, not an oversight: a wrong
 * bind mount is fixed outside Homestead, and a NAS admin mid-migration may already know
 * their setup is unconventional but correct. Trapping them here with no way past is
 * worse than warning loudly — so `Continue`'s disabled state below is never driven by
 * the preflight result, only by `pending` (`SetupWizard`'s own completion request, in
 * flight once this step has already called `onComplete`) — and the warning is rendered
 * from the query's own data rather than any local "dismissed" flag, so it cannot be
 * cleared by the click that advances past it.
 */
export function StepVerifyHost({ onComplete, pending }: SetupStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Verify host</h2>
        <p className="text-sm text-slate-500">
          Homestead needs a working Docker socket and a compose root mounted at the same path inside
          the container as on the host.
        </p>
      </div>

      <HostCheckPanel
        footer={() => (
          <button
            type="button"
            onClick={onComplete}
            disabled={pending}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {pending ? "Continuing…" : "Continue"}
          </button>
        )}
      />
    </div>
  );
}
