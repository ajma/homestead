import {
  describeCloudflareError,
  describeTunnelError,
  useCloudflareStatus,
  useCloudflareTunnel,
  useCloudflareZones,
  useDeleteCloudflareCredentials,
  useProvisionTunnel,
  useSaveCloudflareCredentials,
} from "@web/api/cloudflare";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { JobOutput } from "@web/components/JobOutput";
import { type SyntheticEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

const VERIFIED_AT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Task 3 of Phase 2A: the panel that lets an admin actually use the credential store and
 * routes Task 1 and 2 built. Composed the same way `HostCheckPanel` is — a self-contained
 * section `Settings` mounts directly, owning its own query and its own loading/error
 * states rather than expecting a parent to orchestrate them.
 *
 * **The token is write-only.** `GET /api/cloudflare/credentials` (`CloudflareStatus`) never
 * carries it — only `tokenHint`, its last four characters — so there is nothing for this
 * component to read back even if it wanted to. The only place the full token ever exists
 * in the browser is this component's own `token` state between being typed and the PUT
 * either succeeding (state is cleared) or failing (state is kept, so a 40-character token
 * doesn't need retyping because the account id next to it had one wrong character).
 * `useSaveCloudflareCredentials` deliberately does not go through `useMutation` — see its
 * doc comment in `src/web/api/cloudflare.ts` — specifically because `useMutation` would
 * keep this token as `state.variables` in the app-wide `QueryClient`'s `MutationCache`
 * for five minutes after this component unmounts, on success and on failure alike. That
 * was Phase 1F's `.env`-in-the-query-cache defect recurring one layer down, in the
 * mutation cache; a plain `apiFetch` call has no such cache to land in.
 *
 * Configured and not-configured render two disjoint things, not one form with a
 * conditionally-filled token field: once configured, there is no token input on screen at
 * all, only the account id and the hint. Getting a new token onto the account goes through
 * `Remove credentials` (via `ConfirmDialog`, not a bespoke confirmation) and back through
 * the same not-configured form — one path, not a second "update" flow that could grow its
 * own way to leak or pre-fill a token.
 *
 * **Phase 2C Task 4 adds the Tunnel section below**, independent of the credentials
 * branch above (it renders in both the configured and not-configured cases) because a
 * tunnel's existence and the credentials' presence are separate facts: a tunnel can
 * outlive the credentials that provisioned it, and "no credentials" is itself one of the
 * tunnel section's own states, not a reason to hide it entirely.
 */
export function CloudflarePanel() {
  const status = useCloudflareStatus();
  const configured = status.data?.configured === true;
  const zones = useCloudflareZones(configured);
  const saveCredentials = useSaveCloudflareCredentials();
  const deleteMutation = useDeleteCloudflareCredentials();

  const tunnelStatus = useCloudflareTunnel();
  const provisionTunnel = useProvisionTunnel();

  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Plain state, set synchronously before the save call — there is no double-request
  // hazard from a second click landing before the button disables here (unlike
  // `StepCreateAdmin`'s `notifyManager`-deferred guard), but consistent with every other
  // form in this codebase.
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // The job whose output this panel is showing (or last showed) for the provision
  // sequence — set either by `handleProvision` the moment this tab's own POST resolves,
  // or adopted below from a sequence someone else (another tab, or this same tab before
  // a reload) already started. Kept set after the job finishes, deliberately: `JobOutput`
  // stays mounted showing the frozen final transcript rather than disappearing the moment
  // `jobRunning` (below) goes false, because a failed run's `undoFailures` — the one
  // thing a user must read before doing anything else — live only in that transcript.
  const [watchedJobId, setWatchedJobId] = useState<string | null>(null);
  // Separate from `watchedJobId` being set: this is specifically "is a sequence in flight
  // right now", which drives whether Provision is offered again and whether the disabled
  // "Provisioning…" button is shown in its place. A finished job keeps `watchedJobId` (for
  // the transcript) while this goes back to `false`.
  const [jobRunning, setJobRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  // Set only once a watched job finishes and the tunnel status refetch that follows
  // confirms it did NOT end up provisioned — i.e. the sequence failed and rolled back.
  // Never inferred from `provisionError` (that is a failure to even START a job) or from
  // `JobOutput`'s own state (it exposes no terminal status — see `useSseText`'s `done`
  // boolean, which is deliberately silent on success vs failure).
  const [lastProvisionFailed, setLastProvisionFailed] = useState(false);

  // Picks up a job already running when this panel mounts — someone clicked Provision
  // and reloaded the page (the sequence keeps running server-side regardless of what the
  // browser does: `POST /api/cloudflare/tunnel` answers as soon as the job row exists and
  // lets the sequence run on in the background — 2F Task 1 — so a reload only orphans the
  // browser's knowledge of it, not the sequence itself), or another admin's tab started
  // one. `!jobRunning` guard: never stomps a job this panel itself just started or is
  // already watching. Keyed on the id alone, matching `useAppActions`' own version of this
  // effect (`runningJobId`/`activeJobId`).
  const knownRunningJobId = tunnelStatus.data?.runningJobId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on knownRunningJobId only
  useEffect(() => {
    if (knownRunningJobId !== null && !jobRunning) {
      setWatchedJobId(knownRunningJobId);
      setJobRunning(true);
    }
  }, [knownRunningJobId]);

  function handleSave(event: SyntheticEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    saveCredentials({ token, accountId }).then(
      () => {
        setSaving(false);
        // The one place the token is deliberately forgotten: the save succeeded, the
        // server verified and stored it, and this component has no further reason to
        // hold it in memory for the rest of the tab's lifetime. Load-bearing beyond just
        // this render: `data.configured` can flip back to `false` later (another tab
        // removing credentials, a failed background refetch) and re-show this form, and
        // when it does, `token` must already be empty rather than still holding what was
        // just saved.
        setToken("");
      },
      (mutationError: unknown) => {
        setSaving(false);
        setError(describeCloudflareError(mutationError, "Could not save these credentials."));
        // `accountId` and `token` are deliberately left exactly as typed here.
      },
    );
  }

  async function handleRemoveConfirmed() {
    await deleteMutation.mutateAsync();
    setAccountId("");
    setToken("");
  }

  function handleProvision() {
    setProvisionError(null);
    setLastProvisionFailed(false);
    // Drops the previous attempt's transcript, if any — a retry's own output should not
    // be read as a continuation of the last (failed) one.
    setWatchedJobId(null);
    setStarting(true);
    provisionTunnel().then(
      (result) => {
        setStarting(false);
        setWatchedJobId(result.jobId);
        setJobRunning(true);
      },
      (provisionErr: unknown) => {
        setStarting(false);
        setProvisionError(describeTunnelError(provisionErr, "Could not start provisioning."));
      },
    );
  }

  /**
   * `JobOutput`'s `onDone` carries no terminal status (`useSseText`'s `done` is a plain
   * boolean — see its own doc on why: the two SSE routes it serves send at most one of
   * `done`/`error`, and `JobOutput` never parsed the `done` event's `{status, exitCode}`
   * payload out to a caller). Rather than teach that shared surface a second output shape
   * for this one caller, the outcome is read the same way `GET /api/cloudflare/tunnel`
   * itself defines success: `provisioned` after a fresh fetch. Awaited before flipping
   * `jobRunning` off, not after, so there is no render in between where Provision is
   * already offered again but the tunnel section is still showing stale (possibly
   * still-provisioned, pre-rollback) data. `watchedJobId` is left set — see its own doc
   * comment on why the transcript outlives the run.
   */
  async function handleJobDone() {
    const result = await tunnelStatus.refetch();
    setLastProvisionFailed(result.data?.provisioned !== true);
    setJobRunning(false);
  }

  if (status.isPending) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  if (status.isError) {
    return <p className="text-sm text-red-600">Could not load Cloudflare status.</p>;
  }

  const data = status.data;

  return (
    <div className="space-y-4">
      {data.configured ? (
        <div className="space-y-4">
          <dl className="text-sm text-slate-700 dark:text-slate-300">
            <div className="flex gap-2">
              <dt className="font-medium">Account ID</dt>
              <dd>{data.accountId}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium">Token</dt>
              <dd>•••• {data.tokenHint}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium">Verified</dt>
              <dd>
                {data.verifiedAt === null
                  ? "Never"
                  : VERIFIED_AT_FORMATTER.format(new Date(data.verifiedAt * 1000))}
              </dd>
            </div>
          </dl>

          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Zones</h3>
            {zones.isPending && <p className="text-sm text-slate-500">Loading zones…</p>}
            {zones.isError && (
              <p role="alert" className="text-sm text-red-600">
                Could not load zones.
              </p>
            )}
            {zones.data && zones.data.length === 0 && (
              <p className="text-sm text-slate-500">No zones are visible to this token.</p>
            )}
            {zones.data && zones.data.length > 0 && (
              <ul className="text-sm text-slate-700 dark:text-slate-300">
                {zones.data.map((zone) => (
                  <li key={zone.id}>{zone.name}</li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="button"
            onClick={() => setConfirmingRemove(true)}
            className="rounded-lg border border-rose-200 px-3 py-2 text-sm text-rose-600 dark:border-rose-900 dark:text-rose-400"
          >
            Remove credentials
          </button>
        </div>
      ) : (
        <form onSubmit={handleSave} className="max-w-sm space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Account ID</span>
            <input
              type="text"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              required
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">API token</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              required
            />
          </label>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      {confirmingRemove && (
        <ConfirmDialog
          title="Remove Cloudflare credentials"
          message="Remove the stored Cloudflare account id and token? Once a tunnel has been provisioned against them, removing them here would strand it. This cannot be undone."
          confirmLabel="Remove"
          destructive
          onConfirm={handleRemoveConfirmed}
          onClose={() => setConfirmingRemove(false)}
          formatError={(err) => describeCloudflareError(err, "Could not remove these credentials.")}
        />
      )}

      <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Tunnel</h3>

        {tunnelStatus.isPending && <p className="text-sm text-slate-500">Loading…</p>}
        {tunnelStatus.isError && (
          <p role="alert" className="text-sm text-red-600">
            Could not load tunnel status.
          </p>
        )}

        {tunnelStatus.data && (
          <>
            {/* A failed provision's most important line, shown first and styled apart from
                everything else in this section — not appended after the job output, and
                not folded into `provisionError` (a plain red line used everywhere else in
                this panel for "the request failed"). `runSteps`' rollback can itself fail
                partway, in which case the real Cloudflare tunnel it created is still out
                there with nothing local pointing at it; `undoFailures` in the job output
                below names exactly which step that was, but a user has to be told to look
                for it before they will. */}
            {lastProvisionFailed && (
              <div
                role="alert"
                className="space-y-1 rounded-2xl border-2 border-rose-600 bg-rose-50 p-3 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-200"
              >
                <p className="font-semibold">Provisioning failed.</p>
                <p>
                  Steps that could be undone were rolled back. Check the output below for a "MANUAL
                  CLEANUP REQUIRED" section — anything listed there was NOT rolled back and may
                  still exist in your Cloudflare account.
                </p>
              </div>
            )}

            {jobRunning ? (
              <button
                type="button"
                disabled
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
              >
                Provisioning…
              </button>
            ) : tunnelStatus.data.provisioned ? (
              <p className="text-sm text-slate-700 dark:text-slate-300">
                Tunnel <span className="font-medium">{tunnelStatus.data.name}</span> is provisioned.
                {tunnelStatus.data.appId !== null && (
                  <>
                    {" "}
                    <Link
                      to={`/apps/${tunnelStatus.data.appId}`}
                      className="underline decoration-slate-400 underline-offset-2"
                    >
                      View the cloudflared app
                    </Link>
                    .
                  </>
                )}
              </p>
            ) : configured ? (
              <>
                <button
                  type="button"
                  onClick={handleProvision}
                  disabled={starting}
                  className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                >
                  {starting ? "Provisioning…" : "Provision tunnel"}
                </button>
                {provisionError && (
                  <p role="alert" className="text-sm text-red-600">
                    {provisionError}
                  </p>
                )}
              </>
            ) : (
              // No credentials, no tunnel, and — deliberately — no Provision button:
              // provisioning without a token cannot succeed, it can only fail with a
              // confusing Cloudflare auth error instead of this plain sentence. Hidden
              // entirely rather than shown disabled, so there is nothing here that could
              // ever be clicked into that failure.
              <p className="text-sm text-slate-500">
                Add Cloudflare credentials above before provisioning a tunnel.
              </p>
            )}

            {/* Reused, not reimplemented — see the class doc on `JobOutput`. The provision
                sequence is a recorded job with a real job id, so this is the same surface
                `ActionBar` and `AdminApps` already stream a compose job's output through.
                Rendered whenever there is a job to show, independent of `jobRunning`: it
                stays mounted after the sequence finishes so a failed run's transcript —
                and, first within it, anything `undoFailures` could not roll back — remains
                on screen underneath the banner above, not just during the run itself. */}
            {watchedJobId !== null && <JobOutput jobId={watchedJobId} onDone={handleJobDone} />}
          </>
        )}
      </div>
    </div>
  );
}
