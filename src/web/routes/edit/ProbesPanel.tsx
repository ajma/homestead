import type { ProbeRow } from "@shared/admin.js";
import type { ProbeSnapshot } from "@shared/launcher";
import { rollUpProbes } from "@shared/status-phrase";
import type { ProbeKind } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { probesKey, useProbes } from "@web/api/admin";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { StatusChip } from "@web/components/StatusChip";
import type { EditAppContext } from "@web/routes/EditApp";
import { type FormEvent, useState } from "react";
import { useOutletContext } from "react-router-dom";

/**
 * One published port `GET /api/apps/:id/probes/suggestions` offers. A local copy rather
 * than a shared type — like `ContainersTab`'s `ContainerDetail` — because nothing on the
 * server infers a payload from this shape; it exists only where a `fetch` response lands.
 */
type ProbeSuggestion = { service: string; target: string };

const KIND_LABELS: Record<ProbeKind, string> = {
  docker: "Docker",
  http_internal: "HTTP (internal)",
  http_external: "HTTP (external)",
};

/** Every kind a probe can be created as, in the order the "Add probe" select offers them. */
const CREATABLE_KINDS: ProbeKind[] = ["http_internal", "http_external", "docker"];

/**
 * Client-side mirror of `probes.ts`'s `targetSchema` refinement — same rule (only
 * `http:`/`https:` is fetchable, everything else is an SSRF primitive dressed as a health
 * check target), duplicated rather than shared because it exists purely for immediate
 * form feedback. The server's copy stays the one that is actually enforced; this one only
 * decides whether to bother sending the request at all.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Reuses the exact function the launcher uses to turn one probe's raw state into a
 * sentence, rather than a second, drifting copy of `phraseFor`'s branching. A one-element
 * array has no siblings to roll up against, which is exactly right here: this line is
 * reporting what ONE probe currently says, not the app's overall status.
 */
function probeReason(probe: ProbeRow): string {
  const snapshot: ProbeSnapshot = {
    probeId: probe.id,
    kind: probe.kind,
    label: probe.label,
    status: probe.lastStatus,
    faultClass: probe.lastFaultClass,
    statusSince: probe.statusSince,
    lastCheckedAt: probe.lastCheckedAt,
  };
  return rollUpProbes([snapshot]).reason;
}

function slugFromError(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? body.error : null;
}

/**
 * Turns a create failure into a sentence, not a slug. `probe_exists` is the one a user
 * will actually hit through this form — the docker probe adoption already created, or an
 * external probe already configured — everything else falls back to the raw message
 * rather than inventing wording for errors this form cannot otherwise provoke.
 */
function describeCreateError(error: unknown, kind: ProbeKind): string {
  // Checked first: `error instanceof Error` below is also true for `ApiTimeoutError`, and
  // its own message is a developer string ("API request timed out after 30000ms") rather
  // than something a person can act on.
  if (error instanceof ApiTimeoutError) {
    return "The server did not respond. It may still be working; check again in a moment.";
  }
  const slug = slugFromError(error);
  if (slug === "probe_exists") {
    return kind === "docker"
      ? "This app already has a docker probe — only one is allowed."
      : "This app already has an external probe — only one is allowed.";
  }
  return error instanceof Error ? error.message : "Could not add this probe.";
}

type CreateProbeBody = { kind: ProbeKind; target?: string; label?: string };

/**
 * The edit page's Probes tab: lists every probe configured for an app, offers published
 * ports as suggested targets when adding an HTTP probe, and lets an admin toggle or
 * delete one.
 *
 * Takes `appId` directly rather than reading `EditAppContext` via `useOutletContext` the
 * way its sibling tabs do — this panel needs nothing else `AdminApp` carries, and a bare
 * `appId` lets it be rendered (and tested) without a router. `ProbesTab`, below, is the
 * thin adapter that reads the outlet context and supplies it when this is wired in as an
 * actual routed tab.
 *
 * Deleting and disabling both change what a tile shows — that is the entire reason Task
 * 11's server half exists (`probes.ts` now calls `EventBus.publishAppChanged` on create,
 * delete, and an enabled-changing PATCH) — so this panel does not need to push its own
 * update onto the launcher cache: `useEventStream`'s `app-changed` handler invalidates it
 * once the server's response confirms the write. Locally, invalidating `probesKey` after
 * each mutation keeps this tab itself in sync without waiting on a round trip through SSE.
 */
export function ProbesPanel({ appId }: { appId: string }) {
  const queryClient = useQueryClient();
  const { data: probes, isPending, isError } = useProbes(appId);

  const [addOpen, setAddOpen] = useState(false);
  const [kind, setKind] = useState<ProbeKind>("http_internal");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const key = probesKey(appId);

  const suggestionsQuery = useQuery({
    queryKey: [...key, "suggestions"],
    // Only fetched once the form asking for a target is actually open, and only for the
    // kind the suggestions are for — a published port suggests a LAN address, never the
    // public one an external probe needs.
    enabled: addOpen && kind === "http_internal",
    queryFn: () => apiFetch<ProbeSuggestion[]>(`/api/apps/${appId}/probes/suggestions`),
    staleTime: 15_000,
  });

  const createMutation = useMutation({
    mutationFn: (body: CreateProbeBody) =>
      apiFetch<ProbeRow>(`/api/apps/${appId}/probes`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ probeId, enabled }: { probeId: string; enabled: boolean }) =>
      apiFetch<ProbeRow>(`/api/probes/${probeId}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (probeId: string) => apiFetch<null>(`/api/probes/${probeId}`, { method: "DELETE" }),
  });

  function resetForm() {
    setKind("http_internal");
    setTarget("");
    setLabel("");
    setTargetError(null);
    setCreateError(null);
  }

  function handleAddSubmit(event: FormEvent) {
    event.preventDefault();
    setCreateError(null);
    setTargetError(null);

    const body: CreateProbeBody = { kind };
    if (kind !== "docker") {
      const trimmedTarget = target.trim();
      if (!isHttpUrl(trimmedTarget)) {
        setTargetError("Enter a valid http:// or https:// URL.");
        return;
      }
      body.target = trimmedTarget;
    }
    const trimmedLabel = label.trim();
    if (trimmedLabel !== "") body.label = trimmedLabel;

    createMutation.mutate(body, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: key });
        setAddOpen(false);
        resetForm();
      },
      onError: (error) => {
        setCreateError(describeCreateError(error, kind));
      },
    });
  }

  function handleToggle(probe: ProbeRow) {
    toggleMutation.mutate(
      { probeId: probe.id, enabled: !probe.enabled },
      { onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }) },
    );
  }

  if (isPending) {
    return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Loading probes…</p>;
  }

  if (isError || !probes) {
    return <p className="p-4 text-sm text-rose-600 dark:text-rose-400">Could not load probes.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
        {probes.map((probe) => {
          const togglePending =
            toggleMutation.isPending && toggleMutation.variables?.probeId === probe.id;
          return (
            <li
              key={probe.id}
              className="flex flex-col gap-2 border-t border-slate-200 px-3 py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {probe.label ?? KIND_LABELS[probe.kind]}
                </p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {KIND_LABELS[probe.kind]}
                  {probe.target ? ` · ${probe.target}` : ""}
                </p>
              </div>

              <StatusChip status={probe.lastStatus} reason={probeReason(probe)} since={null} />

              <label className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={probe.enabled}
                  disabled={togglePending}
                  onChange={() => handleToggle(probe)}
                />
                Enabled
              </label>

              <button
                type="button"
                onClick={() => setConfirmingDeleteId(probe.id)}
                className="rounded-lg border border-rose-300 px-2 py-1 text-xs text-rose-700 dark:border-rose-800 dark:text-rose-400"
              >
                Delete
              </button>
            </li>
          );
        })}
        {probes.length === 0 && (
          <li className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">
            No probes configured for this app yet.
          </li>
        )}
      </ul>

      {!addOpen && (
        <div>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white dark:bg-slate-100 dark:text-slate-900"
          >
            Add probe
          </button>
        </div>
      )}

      {addOpen && (
        <form
          onSubmit={handleAddSubmit}
          className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-800"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Kind</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as ProbeKind)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            >
              {CREATABLE_KINDS.map((option) => (
                <option key={option} value={option}>
                  {KIND_LABELS[option]}
                </option>
              ))}
            </select>
          </label>

          {kind !== "docker" && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-900 dark:text-slate-100">Target URL</span>
              <input
                type="text"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="http://localhost:8096"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
              />
              {targetError && (
                <span className="text-xs text-rose-600 dark:text-rose-400">{targetError}</span>
              )}
            </label>
          )}

          {kind === "http_internal" &&
            suggestionsQuery.data &&
            suggestionsQuery.data.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {suggestionsQuery.data.map((suggestion) => (
                  <button
                    key={suggestion.target}
                    type="button"
                    onClick={() => {
                      setTarget(suggestion.target);
                      setLabel((prev) => (prev === "" ? suggestion.service : prev));
                    }}
                    className="rounded-full border border-slate-200 px-2 py-1 text-xs text-slate-700 dark:border-slate-800 dark:text-slate-300"
                  >
                    {suggestion.service} · {suggestion.target}
                  </button>
                ))}
              </div>
            )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Label <span className="font-normal text-slate-500">(optional)</span>
            </span>
            <input
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          {createError && <p className="text-sm text-rose-600 dark:text-rose-400">{createError}</p>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
            >
              {createMutation.isPending ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                resetForm();
              }}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {confirmingDeleteId && (
        <ConfirmDialog
          title="Delete probe"
          message="Delete this probe? Homestead will stop checking it."
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await deleteMutation.mutateAsync(confirmingDeleteId);
            void queryClient.invalidateQueries({ queryKey: key });
          }}
          onClose={() => setConfirmingDeleteId(null)}
        />
      )}
    </div>
  );
}

/**
 * Adapter between `EditApp`'s `<Outlet context>` (Task 6) and `ProbesPanel`'s plain
 * `appId` prop — the same split the routed tab needs, kept out of `ProbesPanel` itself so
 * it stays mountable in a test with nothing but a `QueryClientProvider`.
 */
export function ProbesTab() {
  const { app } = useOutletContext<EditAppContext>();
  return <ProbesPanel appId={app.id} />;
}
