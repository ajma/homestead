import type { HostCheck } from "@shared/setup.js";
import { useHostCheck } from "@web/api/setup";
import type { ReactNode } from "react";

/**
 * The read-only half of step 2's host check — compose root, Docker version, and mount
 * preflight — factored out of `StepVerifyHost` so `Settings` can offer the identical
 * check "later," per spec §9's promise that Cloudflare exposure (and, by the same
 * reasoning, the mount this whole check exists to catch) "can be completed later from
 * settings." Reuses `useHostCheck` as-is — same query key, same `staleTime`/`gcTime: 0`
 * (see `src/web/api/setup.ts`) — so Settings' own Re-check button is exactly as fresh as
 * the wizard's, and an admin who continued past a failing preflight during setup has
 * somewhere to confirm a fix without a hand-crafted API call.
 *
 * `footer`, when given, renders in the same row as Re-check — the slot `StepVerifyHost`'s
 * Continue button occupies. `Settings` passes nothing: there is no wizard step to
 * complete here, only a check to re-run.
 */
export function HostCheckPanel({ footer }: { footer?: (data: HostCheck) => ReactNode }) {
  const hostCheck = useHostCheck();

  return (
    <div className="space-y-4">
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
            {footer?.(hostCheck.data)}
          </div>
        </div>
      )}
    </div>
  );
}
