import type { AdminApp } from "@shared/dto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminAppKey, adminAppsKey } from "@web/api/admin";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { IconPicker } from "@web/components/IconPicker";
import {
  CARD_PADDING,
  FORM_CONTROL_MAX_WIDTH,
  FORM_LABEL,
  FORM_ROW,
  SECTION_GAP,
} from "@web/lib/density";
import type { EditAppContext } from "@web/routes/EditApp";
import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";

type FormState = {
  displayName: string;
  description: string;
  category: string;
  iconRef: string | null;
  showOnLauncher: boolean;
  self: boolean;
};

function toForm(app: AdminApp): FormState {
  return {
    displayName: app.displayName,
    description: app.description ?? "",
    category: app.category ?? "",
    iconRef: app.iconRef,
    showOnLauncher: app.showOnLauncher,
    self: app.systemKind === "self",
  };
}

/**
 * Only the fields that actually changed, diffed against `app` — the value this tab was
 * handed by `EditApp`, which is also what the last successful save (or the initial load)
 * left on the server. `PATCH /api/apps/:id` runs a `lastDeployAt` lookup on every write,
 * so a save that resends untouched fields pays for that lookup for nothing.
 */
function buildPatch(app: AdminApp, form: FormState): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (form.displayName !== app.displayName) patch.displayName = form.displayName;

  const description = form.description.trim() === "" ? null : form.description;
  if (description !== app.description) patch.description = description;

  const category = form.category.trim() === "" ? null : form.category;
  if (category !== app.category) patch.category = category;

  if (form.iconRef !== app.iconRef) patch.iconRef = form.iconRef;
  if (form.showOnLauncher !== app.showOnLauncher) patch.showOnLauncher = form.showOnLauncher;

  const currentlySelf = app.systemKind === "self";
  if (form.self !== currentlySelf) patch.systemKind = form.self ? "self" : null;

  return patch;
}

/**
 * `PATCH /api/apps/:id`'s two `systemKind`-specific 409s, worded for an admin rather than
 * echoing the wire code — see that route's own comment for why both exist: `self` is
 * detected automatically (`self-detect.ts`) but, per the Phase 2F whole-branch review
 * (F1), detection can go silently wrong, and until this checkbox existed there was no way
 * to correct it by hand at all.
 */
function systemKindErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const { error } = body as { error: unknown };
  if (error === "self_already_assigned") {
    return "Another app is already marked as Homestead itself. Clear that one first.";
  }
  if (error === "system_app") {
    return "This app is managed by Homestead's own Cloudflare tunnel and cannot be reassigned.";
  }
  return undefined;
}

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

/**
 * The edit page's identity tab: `displayName`, `description`, `category`, `iconRef` and
 * `showOnLauncher`, plus the read-only facts about how the app got here — directory,
 * compose file, project name, adoption date — that no form field changes, because moving
 * those out from under a running compose project is not something a PATCH can do safely.
 *
 * Reads the app `EditApp` already resolved, via `useOutletContext`'s `EditAppContext` —
 * re-resolving `:slug` here would defeat the point of the three tabs sharing one lookup.
 *
 * `form` is seeded once from `app` and never resynced from it afterwards. A background
 * refetch (this query has a 15s `staleTime`) or a failed save must never overwrite
 * whatever the admin is mid-typing; only a successful save's own `onSuccess` — which the
 * admin caused — advances what the "changed fields" diff is taken against, and it does
 * that by invalidating the query rather than by touching `form`.
 */
export function OverviewTab() {
  const { app } = useOutletContext<EditAppContext>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormState>(() => toForm(app));
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Plain component state, set synchronously in the click handlers below — not derived
  // from either mutation's own `isPending`. TanStack's `notifyManager` defers the
  // re-render that would reflect `isPending` through `setTimeout(fn, 0)`, so a second
  // click landing inside that window would see a still-enabled button and fire a second
  // request (a second PATCH, or worse, a second DELETE on an app the first call already
  // removed).
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Collapsed by default: the self-marking checkbox and the delete flow are both rare,
  // one-off actions rather than things edited on every visit to this tab, and the delete
  // button in particular is worth an extra click to reach so a stray tap doesn't land on
  // it as the page loads.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const patch = buildPatch(app, form);
  const dirty = Object.keys(patch).length > 0;

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<AdminApp>(`/api/apps/${app.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch<null>(`/api/apps/${app.id}`, { method: "DELETE" }),
  });

  function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);

    saveMutation.mutate(patch, {
      onSuccess: () => {
        setSaving(false);
        // Not the launcher's `["launcher"]` key: the launcher has its own SSE path, and
        // coupling the two would make an admin edit here trigger a Docker-touching
        // refetch (`/api/apps` recomputes container status) on every viewer's screen.
        //
        // Both `adminAppKey(app.id)` and `adminAppKey(app.slug)`: `EditApp` resolves
        // through `useAdminApp(slug)` (Important 3 of the 1E final-fix brief), so this
        // page's own header is cached under the slug, a different key from the id one
        // that prefix-matches the per-app subviews.
        queryClient.invalidateQueries({ queryKey: adminAppKey(app.id) });
        queryClient.invalidateQueries({ queryKey: adminAppKey(app.slug) });
        queryClient.invalidateQueries({ queryKey: adminAppsKey });
      },
      onError: (saveError) => {
        setSaving(false);
        if (saveError instanceof ApiTimeoutError) {
          setError("The server did not respond. It may still be working; check again in a moment.");
          return;
        }
        const systemKindMessage =
          saveError instanceof ApiError ? systemKindErrorMessage(saveError.body) : undefined;
        setError(
          systemKindMessage ?? "Could not save changes. Your edits are still here — try again.",
        );
      },
    });
  }

  function handleDeleteConfirmed() {
    setDeleting(true);
    setDeleteError(null);

    deleteMutation.mutate(undefined, {
      onSuccess: () => {
        setDeleting(false);
        queryClient.invalidateQueries({ queryKey: adminAppsKey });
        navigate("/apps");
      },
      onError: (deleteErr) => {
        setDeleting(false);
        setDeleteError(
          deleteErr instanceof ApiTimeoutError
            ? "The server did not respond. It may still be working; check again in a moment."
            : "Could not delete this app.",
        );
      },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <label className={FORM_ROW}>
          <span className={FORM_LABEL}>Display name</span>
          <input
            type="text"
            value={form.displayName}
            onChange={(event) => setForm((prev) => ({ ...prev, displayName: event.target.value }))}
            className={`${FORM_CONTROL_MAX_WIDTH} rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950`}
          />
        </label>

        <label className={FORM_ROW}>
          <span className={FORM_LABEL}>
            Description <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <textarea
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
            rows={2}
            className={`${FORM_CONTROL_MAX_WIDTH} rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950`}
          />
        </label>

        <label className={FORM_ROW}>
          <span className={FORM_LABEL}>
            Category <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <input
            type="text"
            value={form.category}
            onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
            className={`${FORM_CONTROL_MAX_WIDTH} rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950`}
          />
        </label>

        <div className={FORM_ROW}>
          <span className={FORM_LABEL}>Icon</span>
          <IconPicker
            value={form.iconRef}
            onChange={(slug) => setForm((prev) => ({ ...prev, iconRef: slug }))}
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.showOnLauncher}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, showOnLauncher: event.target.checked }))
            }
          />
          <span className="font-medium text-slate-900 dark:text-slate-100">Show on launcher</span>
        </label>

        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}

        <div>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Directory</dt>
          <dd className="text-slate-900 dark:text-slate-100">{app.directory}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Compose file</dt>
          <dd className="text-slate-900 dark:text-slate-100">{app.composeFile}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Project name</dt>
          <dd className="text-slate-900 dark:text-slate-100">{app.projectName}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Adopted</dt>
          <dd className="text-slate-900 dark:text-slate-100">
            {DATE_FORMATTER.format(new Date(app.adoptedAt * 1000))}
          </dd>
        </div>
      </dl>

      <div className="rounded-2xl border border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          aria-expanded={advancedOpen}
          className={`w-full text-left text-sm font-medium text-slate-900 dark:text-slate-100 ${CARD_PADDING}`}
        >
          Advanced
        </button>
        {advancedOpen && (
          <div
            className={`flex flex-col border-t border-slate-200 dark:border-slate-800 ${CARD_PADDING} ${SECTION_GAP}`}
          >
            {app.systemKind !== "cloudflared" && (
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.self}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, self: event.target.checked }))
                    }
                  />
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    This is Homestead itself
                  </span>
                </label>
                <p className="text-xs text-slate-500">
                  Homestead tries to detect this on its own when it adopts the directory it runs
                  from. Set it by hand if detection missed it, or clear it if it marked the wrong
                  app — only one app can be marked this way at a time.
                </p>
              </div>
            )}

            <div className="rounded-2xl border border-rose-200 p-4 dark:border-rose-900">
              <h2 className="text-sm font-semibold text-rose-700 dark:text-rose-400">
                Danger zone
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Forgetting an app removes it from Homestead only — its files and containers are
                untouched.
              </p>
              {deleteError && (
                <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{deleteError}</p>
              )}
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={deleting}
                className="mt-3 rounded-lg border border-rose-300 px-3 py-2 text-sm text-rose-700 disabled:opacity-50 dark:border-rose-800 dark:text-rose-400"
              >
                Delete app
              </button>
            </div>
          </div>
        )}
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete app"
          message={`Delete ${app.displayName}? This cannot be undone.`}
          confirmLabel="Delete"
          destructive
          onConfirm={handleDeleteConfirmed}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
