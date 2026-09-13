import {
  describeCloudflareError,
  describeTunnelError,
  useCloudflareStatus,
  useCloudflareTunnel,
  useProvisionTunnel,
  useSaveCloudflareCredentials,
} from "@web/api/cloudflare";
import { JobOutput } from "@web/components/JobOutput";
import { type SyntheticEvent, useState } from "react";
import type { SetupStepProps } from "./SetupWizard";

/**
 * Step 4 of onboarding, spec §9's Cloudflare exposure step — the one Phase 1G explicitly
 * left out and 2A–2E built the server side for. `skippable` is `true` for this step (see
 * `SetupWizard`'s `SKIPPABLE_STEPS`), and it must stay that way: §6 and §10 both say
 * Cloudflare "can be completed later from settings", so a wizard that could not finish
 * without a Cloudflare account would block every household that doesn't have one.
 *
 * Reuses `CloudflarePanel`'s own hooks and error-describing helpers rather than
 * reimplementing credential saving or tunnel provisioning — this step offers a strict
 * subset of that panel (save credentials, optionally provision the tunnel) and defers the
 * monitor token and Access sign-in sections entirely to Settings, since neither is needed
 * to expose a single app later and both would just add more ways this one screen could
 * fail before a household ever gets past onboarding.
 *
 * `useSaveCloudflareCredentials` is a plain function, not `useMutation`, for the same
 * reason `CloudflarePanel` avoids it: the token passing through this component's own
 * `token` state must never land in the app-wide `QueryClient`'s `MutationCache`, which
 * survives five minutes past unmount on success AND failure alike.
 */
export function StepCloudflare({ onComplete, pending, onFail, skippable }: SetupStepProps) {
  const status = useCloudflareStatus();
  const tunnelStatus = useCloudflareTunnel();
  const saveCredentials = useSaveCloudflareCredentials();
  const provisionTunnel = useProvisionTunnel();

  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [watchedJobId, setWatchedJobId] = useState<string | null>(null);
  const [jobRunning, setJobRunning] = useState(false);

  const configured = status.data?.configured === true;
  // Guards the wizard's own advance controls, not just this step's own requests: a
  // provision job running server-side survives this step unmounting (2F Task 1 detached
  // the route from the sequence it kicks off), but a click on Skip or Continue while its
  // transcript is still the only record of an in-progress attempt would abandon that
  // record with nothing on screen pointing back at it.
  const busy = saving || starting || jobRunning;

  function handleSave(event: SyntheticEvent) {
    event.preventDefault();
    setSaveError(null);
    setSaving(true);
    saveCredentials({ token, accountId }).then(
      () => {
        setSaving(false);
        setToken("");
      },
      (error: unknown) => {
        setSaving(false);
        const message = describeCloudflareError(error, "Could not save these credentials.");
        setSaveError(message);
        onFail(message);
      },
    );
  }

  function handleProvision() {
    setProvisionError(null);
    setWatchedJobId(null);
    setStarting(true);
    provisionTunnel().then(
      (result) => {
        setStarting(false);
        setWatchedJobId(result.jobId);
        setJobRunning(true);
      },
      (error: unknown) => {
        setStarting(false);
        setProvisionError(describeTunnelError(error, "Could not start provisioning."));
      },
    );
  }

  async function handleJobDone() {
    await tunnelStatus.refetch();
    setJobRunning(false);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Cloudflare</h2>
        <p className="text-sm text-slate-500">
          Expose apps to the internet through a Cloudflare Tunnel, protected by Cloudflare Access.
          Optional — this can be set up later from Settings if you skip it now.
        </p>
      </div>

      {status.isPending && <p className="text-sm text-slate-500">Loading…</p>}
      {status.isError && (
        <p role="alert" className="text-sm text-red-600">
          Could not load Cloudflare status.
        </p>
      )}

      {status.data && !configured && (
        <form onSubmit={handleSave} className="max-w-sm space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900">Account ID</span>
            <input
              type="text"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              disabled={pending}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900">API token</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={pending}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </label>

          {saveError && (
            <p role="alert" className="text-sm text-red-600">
              {saveError}
            </p>
          )}

          <button
            type="submit"
            disabled={saving || pending}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save credentials"}
          </button>
        </form>
      )}

      {configured && (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">Cloudflare credentials are saved.</p>

          {tunnelStatus.isPending && (
            <p className="text-sm text-slate-500">Loading tunnel status…</p>
          )}

          {tunnelStatus.data?.provisioned ? (
            <p className="text-sm text-slate-700">
              Tunnel <span className="font-medium">{tunnelStatus.data.name}</span> is provisioned.
            </p>
          ) : (
            tunnelStatus.data && (
              <>
                <button
                  type="button"
                  onClick={handleProvision}
                  disabled={starting || jobRunning || pending}
                  className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  {starting || jobRunning ? "Provisioning…" : "Provision tunnel"}
                </button>
                {provisionError && (
                  <p role="alert" className="text-sm text-red-600">
                    {provisionError}
                  </p>
                )}
              </>
            )
          )}

          {watchedJobId !== null && <JobOutput jobId={watchedJobId} onDone={handleJobDone} />}
        </div>
      )}

      <div className="flex gap-2">
        {skippable && (
          <button
            type="button"
            onClick={onComplete}
            disabled={pending || busy}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
          >
            Skip
          </button>
        )}
        <button
          type="button"
          onClick={onComplete}
          disabled={pending || busy}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? "Continuing…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
