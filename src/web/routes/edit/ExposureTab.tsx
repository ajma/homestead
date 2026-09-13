import type { AdminApp } from "@shared/dto";
import {
  describeDeprovisionError,
  describeExposeError,
  type ExposeAppBody,
  useAppExposure,
  useCloudflareTunnel,
  useCloudflareZones,
  useDeprovisionApp,
  useExposeApp,
} from "@web/api/cloudflare";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { JobOutput } from "@web/components/JobOutput";
import type { EditAppContext } from "@web/routes/EditApp";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";

/**
 * Client-side mirror of `cloudflare-expose.ts`'s `ingressServiceSchema` — same rule
 * (only `http:`/`https:` is fetchable) as `ProbesPanel`'s own `isHttpUrl`, duplicated
 * for the same reason that one is: this exists purely for immediate form feedback, and
 * the server's copy stays the one actually enforced.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

type FormState = {
  hostname: string;
  zoneId: string;
  ingressService: string;
  policyId: string;
  teamDomain: string;
};

const EMPTY_FORM: FormState = {
  hostname: "",
  zoneId: "",
  ingressService: "",
  policyId: "",
  teamDomain: "",
};

type ExposureApp = Pick<AdminApp, "id" | "displayName" | "systemKind">;

/**
 * The edit page's exposure tab (2F Task 3) — one of eleven Cloudflare routes this phase's
 * server side (2A-2E) built, and, until now, the tab that had no consumer at all. Follows
 * `CloudflarePanel`'s own shape for the same class of action (a step-job sequence that
 * creates real resources in the user's Cloudflare account, streamed through the same
 * `JobOutput` that panel and `ActionBar` already reuse) rather than inventing a second one.
 *
 * **No tunnel, no Expose button.** The same call 2C made for Provision: offering an
 * action that can only fail with a confusing Cloudflare error is worse than a sentence
 * saying why it isn't offered, with a link to go fix it.
 *
 * **Expose is a plain async function (`useExposeApp`), not `useMutation`** — `starting`
 * is this component's own synchronous state, set the instant the click handler runs, the
 * same reasoning `CloudflarePanel`'s `handleProvision` documents: TanStack's
 * `notifyManager` defers the re-render `isPending` would drive through a `setTimeout(0)`,
 * a window a second click can land inside of before the button visibly disables. Remove,
 * by contrast, goes through `ConfirmDialog`, which owns its own once-only guard
 * independent of any mutation's `isPending` — see `useDeprovisionApp`'s own doc comment.
 */
export function ExposurePanel({ app }: { app: ExposureApp }) {
  const exposureQuery = useAppExposure(app.id);
  const tunnelStatus = useCloudflareTunnel();
  const tunnelProvisioned = tunnelStatus.data?.provisioned === true;
  const zones = useCloudflareZones(tunnelProvisioned);
  const exposeApp = useExposeApp(app.id);
  const deprovisionMutation = useDeprovisionApp(app.id);

  const isSelf = app.systemKind === "self";

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [exposeError, setExposeError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Same split `CloudflarePanel` uses: `watchedJobId` outlives the run (so a failed
  // sequence's transcript — and, first within it, anything `undoFailures` could not roll
  // back — stays on screen), `jobRunning` is specifically "is a sequence in flight right
  // now" and drives whether the form is offered again.
  const [watchedJobId, setWatchedJobId] = useState<string | null>(null);
  const [jobRunning, setJobRunning] = useState(false);
  // Set only once a watched job finishes and the exposure refetch that follows confirms
  // it did NOT end up exposed — the sequence failed and rolled back.
  const [lastExposeFailed, setLastExposeFailed] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Picks up an expose job already running when this tab mounts — someone clicked Expose
  // and reloaded the page, or another admin's tab started one — via
  // `GET /api/apps/:id/expose`'s own `runningJobId`, the only way this tab can otherwise
  // learn that. `!jobRunning` guard: never stomps a job this tab itself just started.
  const knownRunningJobId = exposureQuery.data?.runningJobId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on knownRunningJobId only
  useEffect(() => {
    if (knownRunningJobId !== null && !jobRunning) {
      setWatchedJobId(knownRunningJobId);
      setJobRunning(true);
    }
  }, [knownRunningJobId]);

  function handleExposeSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setExposeError(null);

    const hostname = form.hostname.trim();
    if (hostname === "") {
      setFormError("Enter a hostname.");
      return;
    }
    if (form.zoneId === "") {
      setFormError("Choose a zone.");
      return;
    }
    const ingressService = form.ingressService.trim();
    if (!isHttpUrl(ingressService)) {
      setFormError("Enter a valid http:// or https:// URL for the internal service.");
      return;
    }
    const policyId = form.policyId.trim();
    if (policyId === "") {
      setFormError("Enter the Access policy id that should protect this hostname.");
      return;
    }
    const teamDomain = form.teamDomain.trim();
    if (isSelf && teamDomain === "") {
      setFormError("Enter this app's Cloudflare Zero Trust team domain.");
      return;
    }

    const body: ExposeAppBody = { hostname, zoneId: form.zoneId, ingressService, policyId };
    if (isSelf) body.teamDomain = teamDomain;

    // Drops the previous attempt's transcript, if any — a retry's own output should not
    // be read as a continuation of the last (failed) one.
    setLastExposeFailed(false);
    setWatchedJobId(null);
    setStarting(true);
    exposeApp(body).then(
      (result) => {
        setStarting(false);
        setWatchedJobId(result.jobId);
        setJobRunning(true);
      },
      (error: unknown) => {
        setStarting(false);
        setExposeError(describeExposeError(error, "Could not start exposing this app."));
      },
    );
  }

  /** Mirrors `CloudflarePanel.handleJobDone` exactly: `JobOutput`'s `onDone` carries no
   * terminal status, so the outcome is read the same way `GET /api/apps/:id/expose`
   * itself defines success — `exposed` after a fresh fetch. Awaited before flipping
   * `jobRunning` off, so there is no render where Expose is already offered again but
   * this tab is still showing stale, possibly still-exposed, pre-rollback data. */
  async function handleJobDone() {
    const result = await exposureQuery.refetch();
    setLastExposeFailed(result.data?.exposed !== true);
    setJobRunning(false);
  }

  async function handleRemoveConfirmed() {
    await deprovisionMutation.mutateAsync();
  }

  if (exposureQuery.isPending || tunnelStatus.isPending) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  if (exposureQuery.isError || tunnelStatus.isError) {
    return (
      <p className="text-sm text-rose-600 dark:text-rose-400">Could not load exposure status.</p>
    );
  }

  const exposure = exposureQuery.data;

  if (exposure.exposed) {
    return (
      <div className="flex flex-col gap-4">
        <dl className="text-sm text-slate-700 dark:text-slate-300">
          <div className="flex gap-2">
            <dt className="font-medium">Hostname</dt>
            <dd>
              <a
                href={`https://${exposure.hostname}`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-slate-400 underline-offset-2"
              >
                {exposure.hostname}
              </a>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Access application</dt>
            {/* Never the token or the secret — only identifiers, matching the write-only
                treatment every other Cloudflare secret in this codebase already gets. */}
            <dd>{exposure.accessAppAud ?? exposure.accessAppId ?? "Unknown"}</dd>
          </div>
        </dl>

        <div>
          <button
            type="button"
            onClick={() => setConfirmingRemove(true)}
            className="rounded-lg border border-rose-300 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:text-rose-400"
          >
            Remove exposure
          </button>
        </div>

        {confirmingRemove && (
          <ConfirmDialog
            title="Remove exposure"
            message={`Remove ${app.displayName}'s exposure at ${exposure.hostname}? This takes it off the internet.`}
            confirmLabel="Remove"
            destructive
            onConfirm={handleRemoveConfirmed}
            onClose={() => setConfirmingRemove(false)}
            // `describeDeprovisionError` — not a generic "could not remove" fallback —
            // is what puts `deprovision.ts`'s own refusal message (the actual reason, and
            // what to do about it) in front of the admin. `ConfirmDialog` stays open and
            // renders it in place rather than closing and losing it (its own doc comment).
            formatError={(err) => describeDeprovisionError(err, "Could not remove this exposure.")}
          />
        )}
      </div>
    );
  }

  if (!tunnelProvisioned) {
    // No tunnel, no form, no Expose button — see this component's own doc comment on why
    // offering one here would only ever fail with a confusing Cloudflare error.
    return (
      <p className="text-sm text-slate-500">
        No tunnel is provisioned yet.{" "}
        <Link to="/settings" className="underline decoration-slate-400 underline-offset-2">
          Provision one from Settings
        </Link>{" "}
        before exposing this app.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Styled apart from `exposeError` below (a plain red line used for "the request to
          START failed") — this instead names the risk a failed SEQUENCE leaves behind:
          real Cloudflare resources this run could not undo. Mirrors `CloudflarePanel`'s
          identical banner for a failed tunnel provision, verbatim in structure. */}
      {lastExposeFailed && (
        <div
          role="alert"
          className="space-y-1 rounded-2xl border-2 border-rose-600 bg-rose-50 p-3 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-200"
        >
          <p className="font-semibold">Exposing this app failed.</p>
          <p>
            Steps that could be undone were rolled back. Check the output below for a "MANUAL
            CLEANUP REQUIRED" section — anything listed there was NOT rolled back and may still
            exist in your Cloudflare account.
          </p>
        </div>
      )}

      {jobRunning ? (
        <button
          type="button"
          disabled
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          Exposing…
        </button>
      ) : (
        <form onSubmit={handleExposeSubmit} className="max-w-sm space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Hostname</span>
            <input
              type="text"
              value={form.hostname}
              onChange={(event) => setForm((prev) => ({ ...prev, hostname: event.target.value }))}
              placeholder="jellyfin.example.com"
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          <label htmlFor="expose-zone" className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Zone</span>
          </label>
          {zones.isPending && <p className="text-sm text-slate-500">Loading zones…</p>}
          {zones.isError && (
            <p role="alert" className="text-sm text-red-600">
              Could not load zones.
            </p>
          )}
          {zones.data && (
            <select
              id="expose-zone"
              value={form.zoneId}
              onChange={(event) => setForm((prev) => ({ ...prev, zoneId: event.target.value }))}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            >
              <option value="">Choose a zone…</option>
              {zones.data.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </select>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Internal service URL
            </span>
            <input
              type="text"
              value={form.ingressService}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, ingressService: event.target.value }))
              }
              placeholder="http://localhost:8096"
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Access policy id</span>
            <input
              type="text"
              value={form.policyId}
              onChange={(event) => setForm((prev) => ({ ...prev, policyId: event.target.value }))}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          {isSelf && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-900 dark:text-slate-100">
                Cloudflare Zero Trust team domain
              </span>
              <input
                type="text"
                value={form.teamDomain}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, teamDomain: event.target.value }))
                }
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
              />
            </label>
          )}

          {formError && <p className="text-sm text-rose-600 dark:text-rose-400">{formError}</p>}
          {exposeError && (
            <p role="alert" className="text-sm text-red-600">
              {exposeError}
            </p>
          )}

          <button
            type="submit"
            disabled={starting}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {starting ? "Exposing…" : "Expose"}
          </button>
        </form>
      )}

      {/* Reused, not reimplemented — see this component's own doc comment. */}
      {watchedJobId !== null && <JobOutput jobId={watchedJobId} onDone={handleJobDone} />}
    </div>
  );
}

/**
 * Adapter between `EditApp`'s `<Outlet context>` and `ExposurePanel`'s plain `app` prop —
 * the same split `ProbesPanel`/`ProbesTab` use, kept out of `ExposurePanel` itself so it
 * stays mountable in a test with nothing but a `QueryClientProvider`.
 */
export function ExposureTab() {
  const { app } = useOutletContext<EditAppContext>();
  return <ExposurePanel app={app} />;
}
