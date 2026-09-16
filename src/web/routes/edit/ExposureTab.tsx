import type { DriftFinding } from "@shared/cloudflare.js";
import type { AdminApp } from "@shared/dto";
import {
  describeDeprovisionError,
  describeExposeError,
  type ExposeAppBody,
  useAppExposure,
  useCloudflareTunnel,
  useCloudflareZones,
  useComposeServices,
  useDeprovisionApp,
  useExposeApp,
  useReconcileExposures,
} from "@web/api/cloudflare";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { JobOutput } from "@web/components/JobOutput";
import { FORM_CONTROL_MAX_WIDTH } from "@web/lib/density";
import type { EditAppContext } from "@web/routes/EditApp";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";

type FormState = {
  subdomain: string;
  zoneId: string;
  port: string;
  teamDomain: string;
};

const EMPTY_FORM: FormState = {
  subdomain: "",
  zoneId: "",
  port: "",
  teamDomain: "",
};

/**
 * Combines the admin's subdomain with the SELECTED zone's own domain, rather than
 * sending whatever the admin typed as the final hostname unchanged. Measured defect: the
 * "Hostname" field and the "Zone" dropdown used to be two independent inputs with no
 * connection between them at all — an admin picking "example.com" from the zone dropdown
 * and typing "homestead" in the hostname field (a completely reasonable subdomain +
 * domain mental model) got exactly "homestead" sent to Cloudflare as the literal
 * hostname. `create-dns-record` (`expose.ts`) tolerated that silently, because
 * Cloudflare's DNS API is zone-scoped and accepts a bare relative name — but
 * `create-access-app` sends `domain` to an ACCOUNT-scoped endpoint with no zone context
 * at all, which correctly rejected "homestead" as not belonging to any zone. The failure
 * surfaced three steps deep, after a real (if pointless) DNS record had already been
 * created and rolled back.
 *
 * Trimmed input equal to the zone's own name, or already ending in `.${zoneName}`, is
 * used as-is rather than double-appended — an admin who already knows (or pastes) the
 * full hostname must not end up with "jellyfin.example.com.example.com". Blank input
 * composes to the zone's own root domain, for exposing at the apex rather than a
 * subdomain.
 */
export function composeHostname(subdomain: string, zoneName: string): string {
  const trimmed = subdomain.trim();
  if (trimmed === "") return zoneName;
  if (trimmed === zoneName || trimmed.endsWith(`.${zoneName}`)) return trimmed;
  return `${trimmed}.${zoneName}`;
}

/**
 * Keeps the subdomain box to characters a single DNS label can actually contain —
 * letters, digits and hyphens, lowercased. Applied on every keystroke (so an invalid
 * character never lands in the field at all, rather than being caught at submit time)
 * and once at mount to derive the prefill from the app's directory name, which may
 * itself contain characters (`.`, `_`) `POST /api/apps`'s own `DIRECTORY_PATTERN`
 * allows but a hostname label cannot. A dot is deliberately not in this set: the box is
 * only ever the single label in front of the zone, never the full hostname — the literal
 * "." rendered between the two fields is where that character belongs.
 */
function sanitizeHostnameLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/** One flattened row of the port picker: a published port paired with the ONE service
 * name that publishes it, sourced from `GET /api/apps/:id/expose/services`'s per-service
 * `publishedPorts` — flattened client-side, per the brief, rather than the endpoint
 * changing shape. */
type PortOption = { port: number; serviceName: string };

/** The port `<select>`'s own escape hatch — never written into `form.port` itself (see
 * `handlePortOptionChange`'s own comment on why), only compared against on change. */
const TYPE_PORT_OPTION = "__type_a_port__";

type ExposureApp = Pick<AdminApp, "id" | "displayName" | "systemKind" | "directory">;

/**
 * §6's drift findings (2F Task 6), rendered — never auto-corrected; there is no button
 * here that touches Cloudflare, only `ExposurePanel`'s own "Check for drift" above this.
 * `access_app_deleted` and `access_app_replaced` are pulled out and shown first, in their
 * own more strongly-styled banner: deletion means this hostname is routed and UNPROTECTED
 * right now, and a replacement means the recorded audience is stale and Access sign-in
 * checks against it will fail (Phase 2F whole-branch review, F3) — neither is merely
 * "recorded slightly wrong" the way the rest of this list is, and a flat bulleted list
 * would bury either as one row among several equally-weighted ones.
 */
function DriftBanner({ findings }: { findings: DriftFinding[] }) {
  const URGENT_KINDS: readonly DriftFinding["kind"][] = [
    "access_app_deleted",
    "access_app_replaced",
  ];
  const urgent = findings.filter((f) => URGENT_KINDS.includes(f.kind));
  const rest = findings.filter((f) => !URGENT_KINDS.includes(f.kind));

  return (
    <div className="space-y-2">
      {urgent.map((finding, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed snapshot from one reconcile run, never reordered or individually removed.
          key={index}
          role="alert"
          className="space-y-1 rounded-2xl border-2 border-rose-600 bg-rose-50 p-3 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-200"
        >
          <p className="font-semibold">
            {finding.kind === "access_app_deleted"
              ? "Not protected: the Access application is gone."
              : "The Access application was replaced: sign-in checks may now fail."}
          </p>
          <p>{finding.message}</p>
        </div>
      ))}
      {rest.length > 0 && (
        <div
          role="alert"
          className="space-y-1 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <p className="font-semibold">This exposure has drifted from what Cloudflare reports.</p>
          <ul className="list-disc space-y-1 pl-5">
            {rest.map((finding, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: same reasoning as above.
              <li key={index}>{finding.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

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
  // Same `enabled` gate as `zones` above — the picker this feeds only ever appears once a
  // tunnel exists, so there is nothing useful to resolve before then.
  const composeServices = useComposeServices(app.id, tunnelProvisioned);
  const exposeApp = useExposeApp(app.id);
  const deprovisionMutation = useDeprovisionApp(app.id);

  const isSelf = app.systemKind === "self";

  const [form, setForm] = useState<FormState>(() => ({
    ...EMPTY_FORM,
    subdomain: sanitizeHostnameLabel(app.directory),
  }));
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

  const reconcileExposures = useReconcileExposures();
  const [checkingDrift, setCheckingDrift] = useState(false);
  const [driftCheckError, setDriftCheckError] = useState<string | null>(null);

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

  // Every published port across every service, flattened client-side (the brief: the
  // endpoint keeps returning services with their own `publishedPorts`, only the picker
  // above it changes shape) rather than one dropdown per service. A service publishing no
  // ports contributes nothing here — that is exactly how an app entirely on the host
  // network (`network_mode: host`, no `ports:` at all — e.g. Homestead itself,
  // `systemKind: "self"`) ends up with an empty list and goes straight to manual entry
  // below, rather than a dropdown with nothing in it.
  const resolvedServices =
    composeServices.data?.valid === true ? composeServices.data.services : [];
  const portOptions: PortOption[] = resolvedServices.flatMap((service) =>
    service.publishedPorts.map((port) => ({ port, serviceName: service.name })),
  );
  const publishedPortNumbers = new Set(portOptions.map((option) => option.port));

  /** Forces manual entry — never merely "defaults to it" — the instant there is nothing to
   * list: an app with zero published ports (host networking, or a compose file that failed
   * to resolve at all) must never show an empty dropdown, whatever this flag last held from
   * before the data arrived. Otherwise this is the admin's own choice to type instead of
   * pick, made with "Type a port…" or "Choose from the list instead" below. */
  const [manualPortEntry, setManualPortEntry] = useState(false);
  const showManualPortInput = manualPortEntry || portOptions.length === 0;

  /** The common case is one click: with exactly one published port across every service,
   * it is preselected the moment the resolved compose file loads. Guarded on
   * `prev.port === ""` so this never overwrites a choice the admin already made. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the resolved service list only
  useEffect(() => {
    if (portOptions.length !== 1) return;
    const [only] = portOptions;
    if (!only) return;
    setForm((prev) => (prev.port !== "" ? prev : { ...prev, port: String(only.port) }));
  }, [composeServices.data]);

  /** The dropdown's own "choose or type" switch (over a second, always-visible text field:
   * see this component's own doc comment on why). `TYPE_PORT_OPTION` is a sentinel the
   * `<select>` briefly passes through `onChange` and NEVER becomes `form.port` itself — the
   * one and only field this form ever submits — so there is exactly one place "which port
   * is selected" can be read from, whichever way it was chosen. Switching either direction
   * clears `form.port`: a stale value from the other mode is exactly what would let the two
   * controls quietly disagree about the answer if either kept it. */
  function handlePortOptionChange(value: string) {
    if (value === TYPE_PORT_OPTION) {
      setManualPortEntry(true);
      setForm((prev) => ({ ...prev, port: "" }));
      return;
    }
    setForm((prev) => ({ ...prev, port: value }));
  }

  function handleBackToPortList() {
    setManualPortEntry(false);
    setForm((prev) => ({ ...prev, port: "" }));
  }

  const numericPort = Number(form.port);
  const portEntered = form.port.trim() !== "" && Number.isInteger(numericPort) && numericPort > 0;
  /** Task's own instruction, held as a note rather than a refusal: unsatisfiable for a
   * host-networked app (it publishes nothing, ever), and everywhere else a likely typo the
   * admin should still be free to submit — the server no longer blocks on this either (see
   * `cloudflare-expose.ts`'s own comment on `exposeBody`). */
  const portNotPublished = portEntered && !publishedPortNumbers.has(numericPort);

  function handleExposeSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setExposeError(null);

    if (form.zoneId === "") {
      setFormError("Choose a zone.");
      return;
    }
    const zone = zones.data?.find((z) => z.id === form.zoneId);
    if (!zone) {
      setFormError("Choose a zone.");
      return;
    }
    const hostname = composeHostname(form.subdomain, zone.name);
    if (!portEntered) {
      setFormError("Choose or enter the port to route to.");
      return;
    }
    const teamDomain = form.teamDomain.trim();
    if (isSelf && teamDomain === "") {
      setFormError("Enter this app's Cloudflare Zero Trust team domain.");
      return;
    }

    const body: ExposeAppBody = { hostname, zoneId: form.zoneId, port: numericPort };
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

  /**
   * §6: "a periodic reconcile ... flags drift ... rather than silently correcting it" —
   * this button is the on-demand version of that periodic check (2F Task 6 wires the
   * check and this trigger, not a background scheduler; see `reconcile.ts`'s own doc
   * comment). It never asks Cloudflare to fix anything, only to compare — `useReconcileExposures`
   * hits a route that only ever calls `CloudflareClient`'s read methods.
   *
   * Runs the SYSTEM-WIDE reconcile, not one scoped to this app alone (there is no
   * per-app route — see that hook's own doc comment on why one broad invalidation is
   * enough), then refetches this tab's own exposure status so a finding lands on screen
   * immediately rather than waiting for this query's ordinary staleness to expire.
   */
  function handleCheckDrift() {
    setDriftCheckError(null);
    setCheckingDrift(true);
    reconcileExposures().then(
      async () => {
        await exposureQuery.refetch();
        setCheckingDrift(false);
      },
      () => {
        setCheckingDrift(false);
        setDriftCheckError("Could not check for drift. Try again.");
      },
    );
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
  // Phase 2F whole-branch review, F2: `splice-ingress` inserts the `exposures` row as
  // `provisioning` at step 1 of 5, so `GET /api/apps/:id/expose` answers
  // `exposed: true, state: "provisioning"` for nearly the whole run. Branching on
  // `exposure.exposed` alone (as this used to) put the steady-state "here's your
  // hostname" view — a Remove button, no `JobOutput` — in front of a reload mid-expose,
  // and lost the "MANUAL CLEANUP REQUIRED" transcript on a failed run, since that only
  // ever renders inside `JobOutput`. Treating "still provisioning, or a job is running"
  // as its own condition, checked before the steady-state branch, routes both "not
  // exposed yet, job just started" and "exposed row exists, job still running" through
  // the identical in-progress UI below — `jobRunning` alone would miss the first render
  // after a reload, before the `knownRunningJobId` effect above has run.
  const jobInProgress = exposure.exposed
    ? exposure.state === "provisioning" || exposure.runningJobId !== null || jobRunning
    : jobRunning;

  if (exposure.exposed && !jobInProgress) {
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

        {exposure.state === "drifted" && <DriftBanner findings={exposure.driftFindings} />}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCheckDrift}
            disabled={checkingDrift}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-slate-700"
          >
            {checkingDrift ? "Checking…" : "Check for drift"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingRemove(true)}
            className="rounded-lg border border-rose-300 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:text-rose-400"
          >
            Remove exposure
          </button>
        </div>
        {driftCheckError && (
          <p role="alert" className="text-sm text-red-600">
            {driftCheckError}
          </p>
        )}

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

      {jobInProgress ? (
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
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={form.subdomain}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    subdomain: sanitizeHostnameLabel(event.target.value),
                  }))
                }
                placeholder="jellyfin"
                className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
              />
              <span className="text-slate-400 dark:text-slate-600">.</span>
              {zones.data && (
                <select
                  aria-label="Zone"
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
            </div>
          </label>
          {zones.isPending && <p className="text-sm text-slate-500">Loading zones…</p>}
          {zones.isError && (
            <p role="alert" className="text-sm text-red-600">
              Could not load zones.
            </p>
          )}

          <label htmlFor="expose-port" className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Port</span>
          </label>
          {composeServices.isPending && (
            <p className="text-sm text-slate-500">Loading published ports…</p>
          )}
          {composeServices.isError && (
            <p role="alert" className="text-sm text-red-600">
              Could not load this app's published ports.
            </p>
          )}
          {composeServices.data && !composeServices.data.valid && (
            <p role="alert" className="text-sm text-red-600">
              This app's compose file is invalid: {composeServices.data.message}
            </p>
          )}
          {/* Every published port across every service, one dropdown, each option labelled
              with the service publishing it — "8080 — web" — plus a "Type a port…" escape
              hatch, rather than a second field alongside this one: see this component's own
              doc comment on `handlePortOptionChange` for why only one control is ever live
              at a time. An app with nothing published (host networking — `network_mode:
              host` declares no `ports:` at all, Homestead's own case as `systemKind: "self"`)
              skips this and goes straight to the manual input below instead of showing a
              dropdown with nothing in it. */}
          {composeServices.data !== undefined && !showManualPortInput && portOptions.length > 0 && (
            <select
              id="expose-port"
              value={form.port}
              onChange={(event) => handlePortOptionChange(event.target.value)}
              className={`${FORM_CONTROL_MAX_WIDTH} rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950`}
            >
              <option value="">Choose a port…</option>
              {portOptions.map((option) => (
                <option key={`${option.serviceName}-${option.port}`} value={String(option.port)}>
                  {option.port} — {option.serviceName}
                </option>
              ))}
              <option value={TYPE_PORT_OPTION}>Type a port…</option>
            </select>
          )}
          {composeServices.data !== undefined && showManualPortInput && (
            <div className="flex flex-col gap-1">
              <input
                id="expose-port"
                type="number"
                min={1}
                value={form.port}
                onChange={(event) => setForm((prev) => ({ ...prev, port: event.target.value }))}
                placeholder="8080"
                className={`${FORM_CONTROL_MAX_WIDTH} rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950`}
              />
              {portOptions.length > 0 && (
                <button
                  type="button"
                  onClick={handleBackToPortList}
                  className="self-start text-xs text-slate-500 underline decoration-slate-400 underline-offset-2 dark:text-slate-400"
                >
                  Choose from the list instead
                </button>
              )}
            </div>
          )}
          {portNotPublished && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No service publishes port {numericPort} — expected for an app on the host network,
              otherwise check for a typo.
            </p>
          )}

          {/* The sentence that matters most in this form (§6's shared-policy scope,
              stated where the admin is making the decision, not only in a doc): the
              Access policy protecting every exposed app is the SAME one for all of them,
              regardless of what any one user can see inside Homestead itself. */}
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Exposing {app.displayName} grants sign-in access to every enabled Homestead user —
            including viewers scoped to entirely different apps — because every exposed app shares
            the same Access sign-in policy. Homestead's own per-app permissions do not carry through
            to who Cloudflare lets in.
          </p>

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
