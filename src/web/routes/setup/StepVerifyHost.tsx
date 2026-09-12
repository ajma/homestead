import { useHostCheck } from "@web/api/setup";
import type { SetupStepProps } from "./SetupWizard";

/**
 * Step 2 of onboarding: `GET /api/setup/host-check` proves the Docker socket works by
 * returning the daemon's own `docker version` response, and runs the mount round-trip
 * preflight (`src/server/host/preflight.ts`) so a wrong bind mount is caught here,
 * loudly, rather than later during a deploy — spec §10's failure mode for that is a
 * stack that starts successfully with none of the user's data, because Docker resolves
 * a host-invalid bind source by silently creating it as an empty directory.
 *
 * `staleTime`/`gcTime` 0 on `useHostCheck` (see `src/web/api/setup.ts`) means the
 * re-check button's `refetch()` always launches a genuinely fresh check — the route
 * itself serialises concurrent runs into one shared container rather than one each
 * (`runPreflightOnce` in `src/server/routes/setup.ts`), so a double-click here costs one
 * container, not two.
 *
 * Continuing past a failed preflight is a deliberate ruling, not an oversight: a wrong
 * bind mount is fixed outside Homestead, and a NAS admin mid-migration may already know
 * their setup is unconventional but correct. Trapping them here with no way past is
 * worse than warning loudly — so `Continue` is never disabled by the preflight result,
 * and the warning is rendered from the query's own data rather than any local
 * "dismissed" flag, so it cannot be cleared by the click that advances past it.
 */
export function StepVerifyHost({ onComplete }: SetupStepProps) {
  const hostCheck = useHostCheck();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Verify host</h2>
        <p className="text-sm text-slate-500">
          Homestead needs a working Docker socket and a compose root mounted at the same path inside
          the container as on the host.
        </p>
      </div>

      {hostCheck.isPending && <p className="text-sm text-slate-500">Checking…</p>}

      {hostCheck.isError && (
        <div className="space-y-2">
          <p className="text-sm text-red-600">Could not run the host check. Try again.</p>
          <button
            type="button"
            onClick={() => hostCheck.refetch()}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            Re-check
          </button>
        </div>
      )}

      {hostCheck.data && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Compose root</h3>
            <p className="text-sm text-slate-700">{hostCheck.data.composeRoot}</p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">Docker</h3>
            {hostCheck.data.docker.ok ? (
              <dl className="text-sm text-slate-700">
                <div className="flex gap-2">
                  <dt className="font-medium">Version</dt>
                  <dd>{hostCheck.data.docker.version}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium">API version</dt>
                  <dd>{hostCheck.data.docker.apiVersion}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium">OS</dt>
                  <dd>{hostCheck.data.docker.os}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium">Architecture</dt>
                  <dd>{hostCheck.data.docker.arch}</dd>
                </div>
              </dl>
            ) : (
              <p role="alert" className="text-sm text-red-600">
                {hostCheck.data.docker.message}
              </p>
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">Mount preflight</h3>
            {hostCheck.data.preflight.ok ? (
              <p className="text-sm text-slate-700">
                A file round-tripped through the compose root as seen by the Docker daemon.
              </p>
            ) : (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-red-600">
                  {hostCheck.data.preflight.reason}
                </p>
                <p className="text-sm text-slate-500">
                  The compose root must be bind-mounted at the same absolute path inside the
                  container as it has on the host. The Docker daemon resolves every stack's bind
                  mounts against the host filesystem, not the container's — a source path that is
                  invalid on the host is silently created there as an empty directory, so a stack
                  can start successfully with none of your data in it. Symlinks on the host are
                  fine; mounting the share at a different path inside the container is not.
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => hostCheck.refetch()}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              Re-check
            </button>
            <button
              type="button"
              onClick={onComplete}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white"
            >
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
