import {
  describeCloudflareError,
  useCloudflareStatus,
  useCloudflareZones,
  useDeleteCloudflareCredentials,
  useSaveCloudflareCredentials,
} from "@web/api/cloudflare";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { type SyntheticEvent, useState } from "react";

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
 */
export function CloudflarePanel() {
  const status = useCloudflareStatus();
  const configured = status.data?.configured === true;
  const zones = useCloudflareZones(configured);
  const saveCredentials = useSaveCloudflareCredentials();
  const deleteMutation = useDeleteCloudflareCredentials();

  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Plain state, set synchronously before the save call — there is no double-request
  // hazard from a second click landing before the button disables here (unlike
  // `StepCreateAdmin`'s `notifyManager`-deferred guard), but consistent with every other
  // form in this codebase.
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

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
    </div>
  );
}
