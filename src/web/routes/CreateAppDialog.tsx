import type { AdminApp } from "@shared/dto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminAppsKey } from "@web/api/admin";
import { ApiError, apiFetch } from "@web/api/client";
import { DialogShell } from "@web/components/DialogShell";
import { useState } from "react";

/**
 * The same rule `createBody` enforces in `src/server/routes/apps.ts` — checked here only
 * as a convenience so the field can complain before a round trip. This is not the
 * boundary: the server's zod schema, plus the host's `PathGuard`, stay the boundary.
 */
const DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Mirrors a display name into a directory suggestion: lowercase, runs of anything other
 * than a letter or digit collapsed to one hyphen, leading/trailing hyphens trimmed.
 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Maps `POST /api/apps`'s error slugs to sentences a user can act on. Anything
 * unrecognised still falls back to a generic line plus the slug itself, so a new server
 * error is diagnosable from the screen rather than silently swallowed.
 */
function errorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.body !== null &&
    typeof error.body === "object" &&
    "error" in error.body
  ) {
    const slug = String((error.body as { error: unknown }).error);
    if (slug === "directory_exists") return "A folder with that name already exists.";
    return `Something went wrong creating the app (${slug}).`;
  }
  return "Something went wrong creating the app.";
}

type CreatePayload = {
  displayName: string;
  directory: string;
  description?: string;
  category?: string;
};

/**
 * Spec §8's other way into the inventory, alongside adopting a stack already on disk:
 * write a starter compose file into a brand-new directory under the compose root via
 * `POST /api/apps`.
 *
 * The directory field mirrors a slugified display name only until the user edits it by
 * hand, tracked with `directoryTouched` rather than by comparing the field's current
 * value to the slug. Comparing values would un-arm the mirror the instant someone typed
 * the suggested slug on purpose, and then silently re-arm it — the next display-name
 * keystroke would overwrite a deliberate choice, which is the classic, infuriating
 * version of this bug because it only bites the careful user.
 *
 * The dialog shell (backdrop, header, focus capture/trap/restore) is `DialogShell`,
 * shared with `AdoptDialog` — both are nested `div`s rather than a native `<dialog>`
 * because jsdom 30 does not implement `HTMLDialogElement.showModal`.
 *
 * `submitting` is plain component state, set synchronously in the click handler before
 * `mutate` is called, for the same reason as `AdoptDialog`'s: TanStack's `notifyManager`
 * defers the re-render that would reflect the mutation's own `isPending` through
 * `setTimeout(fn, 0)`, so a `waitFor` whose first synchronous check lands in that window
 * would see the still-enabled button and report success before the request even started.
 */
export function CreateAppDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState("");
  const [directory, setDirectory] = useState("");
  const [directoryTouched, setDirectoryTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mutation = useMutation({
    mutationFn: (payload: CreatePayload) =>
      apiFetch<AdminApp>("/api/apps", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  });

  function handleDisplayNameChange(value: string) {
    setDisplayName(value);
    if (!directoryTouched) setDirectory(slugify(value));
  }

  function handleDirectoryChange(value: string) {
    setDirectoryTouched(true);
    setDirectory(value);
  }

  function handleCreate() {
    if (!DIRECTORY_PATTERN.test(directory)) {
      setError("Directory must be a single folder name.");
      return;
    }
    setError(null);
    setSubmitting(true);

    mutation.mutate(
      {
        displayName,
        directory,
        description: description.trim() === "" ? undefined : description,
        category: category.trim() === "" ? undefined : category,
      },
      {
        onSuccess: () => {
          setSubmitting(false);
          queryClient.invalidateQueries({ queryKey: adminAppsKey });
          onClose();
        },
        onError: (mutationError) => {
          setSubmitting(false);
          setError(errorMessage(mutationError));
        },
      },
    );
  }

  return (
    <DialogShell title="Create app" onClose={onClose}>
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(event) => handleDisplayNameChange(event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Directory</span>
            <input
              type="text"
              value={directory}
              onChange={(event) => handleDirectoryChange(event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Description <span className="font-normal text-slate-500">(optional)</span>
            </span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Category <span className="font-normal text-slate-500">(optional)</span>
            </span>
            <input
              type="text"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={submitting || displayName.trim() === ""}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {submitting ? "Creating…" : "Create"}
        </button>
      </div>
    </DialogShell>
  );
}
