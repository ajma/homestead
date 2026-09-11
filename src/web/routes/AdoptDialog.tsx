import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminAppsKey, useScan } from "@web/api/admin";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { DialogShell } from "@web/components/DialogShell";
import { useMemo, useState } from "react";

/** One row of `POST /api/apps/adopt`'s `adopted` array. */
type AdoptedApp = { id: string; directory: string };

/**
 * One row of `POST /api/apps/adopt`'s `failed` array — matches what the live route
 * (`src/server/routes/apps.ts`) actually sends. An earlier draft of this file expected
 * `error`, which the route never sends; a `?? "unknown error"` fallback covered the
 * mismatch instead of surfacing it, so every row silently rendered "unknown error".
 */
type AdoptFailure = { directory: string; message: string };

type AdoptResponse = { adopted: AdoptedApp[]; failed: AdoptFailure[] };

/**
 * Spec §8's "adopt from disk": scan the compose root for directories Homestead does not
 * know about yet, and let the admin multi-select which to take over.
 *
 * The backdrop, header, and focus handling (capture, initial focus, Tab trap,
 * restore-on-close) live in `DialogShell`, shared with `CreateAppDialog` (Task 5) since
 * both must behave identically there.
 *
 * `submitting` is plain component state, set synchronously in the click handler before
 * `mutate` is even called — deliberately not derived from the mutation's own `isPending`.
 * TanStack's `notifyManager` defers the re-render that would reflect `isPending` through
 * `setTimeout(fn, 0)`, so a click handler that only flips local state via the mutation
 * object would leave the just-submitted checkboxes on screen for at least one macrotask.
 * A `waitFor` in the caller whose first (synchronous) check lands in that window would
 * see the stale, still-checked row and report done before the request even resolves.
 * Hiding the submitted rows through ordinary `useState` happens in the same React commit
 * as the click, so nothing async has to elapse before they disappear.
 */
export function AdoptDialog({ onClose }: { onClose: () => void }) {
  const { data, isPending: scanPending, isError: scanFailed } = useScan(true);
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<AdoptResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (directories: string[]) =>
      apiFetch<AdoptResponse>("/api/apps/adopt", {
        method: "POST",
        body: JSON.stringify({ directories }),
      }),
  });

  const resultDirectories = useMemo(
    () =>
      new Set([
        ...(result?.adopted.map((a) => a.directory) ?? []),
        ...(result?.failed.map((f) => f.directory) ?? []),
      ]),
    [result],
  );

  // Directories mid-request or already resolved (either way) drop out of the pending
  // list — resolved ones so a completed attempt is never shown twice (once as a
  // checkbox, once in the outcome it just produced), submitting ones so the trap
  // described above never gets a stale row to match against.
  const hidden = useMemo(
    () => new Set([...submitting, ...resultDirectories]),
    [submitting, resultDirectories],
  );

  const discovered = data?.discovered ?? [];
  const pending = discovered.filter((d) => !d.adopted && !hidden.has(d.directory));
  const alreadyAdopted = discovered.filter((d) => d.adopted);
  const orphans = data?.orphans ?? [];

  function toggle(directory: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
  }

  function handleAdopt() {
    const directories = [...selected];
    if (directories.length === 0) return;

    setSubmitting(new Set(directories));
    setSelected(new Set());
    setResult(null);
    setSubmitError(null);

    mutation.mutate(directories, {
      onSuccess: (response) => {
        setSubmitting(new Set());
        setResult(response);
        if (response.failed.length === 0) {
          queryClient.invalidateQueries({ queryKey: adminAppsKey });
          onClose();
        }
      },
      onError: (error) => {
        setSubmitting(new Set());
        // A totally-failed batch (every directory already adopted, or invalid) comes
        // back as a 409/422 rather than a 200 — `apiFetch` throws for that, but the body
        // carries the same `{ adopted, failed }` shape, so the per-directory reasons are
        // still worth showing rather than a bare "request failed".
        if (
          error instanceof ApiError &&
          error.body !== null &&
          typeof error.body === "object" &&
          "failed" in error.body
        ) {
          setResult(error.body as AdoptResponse);
          return;
        }
        // Neither a success nor a shaped failure — a timeout or a network error, neither
        // of which carries a per-directory breakdown. Previously silent: `result` stayed
        // `null` and nothing told the user anything happened at all.
        setSubmitError(
          error instanceof ApiTimeoutError
            ? "The server did not respond. It may still be working; check again in a moment."
            : "Could not adopt these directories. Try again.",
        );
      },
    });
  }

  return (
    <DialogShell title="Adopt from disk" onClose={onClose}>
      <div className="flex-1 overflow-y-auto">
        {scanPending && <p className="text-sm text-slate-500">Scanning the compose root…</p>}
        {scanFailed && (
          <p className="text-sm text-rose-600 dark:text-rose-400">
            Could not scan for stacks on disk.
          </p>
        )}

        {submitError && (
          <p className="mb-4 text-sm text-rose-600 dark:text-rose-400">{submitError}</p>
        )}

        {data && (
          <>
            {submitting.size > 0 && (
              <p className="mb-2 text-sm text-slate-500">
                Adopting {submitting.size} director{submitting.size === 1 ? "y" : "ies"}…
              </p>
            )}

            {result && result.failed.length > 0 && (
              <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm dark:border-rose-900 dark:bg-rose-950">
                <p className="mb-2 font-medium text-rose-700 dark:text-rose-300">
                  {result.failed.length} could not be adopted
                </p>
                <ul className="flex flex-col gap-1 text-rose-700 dark:text-rose-300">
                  {result.failed.map((failure) => (
                    <li key={failure.directory}>
                      {failure.directory}: {failure.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result && result.adopted.length > 0 && (
              <p className="mb-4 text-xs text-slate-500">
                Adopted: {result.adopted.map((a) => a.directory).join(", ")}
              </p>
            )}

            {pending.length === 0 && submitting.size === 0 && (
              <p className="text-sm text-slate-500">Nothing new to adopt.</p>
            )}

            <ul className="flex flex-col gap-2">
              {pending.map((dir) => (
                <li key={dir.directory}>
                  <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
                    <input
                      type="checkbox"
                      checked={selected.has(dir.directory)}
                      onChange={() => toggle(dir.directory)}
                    />
                    <span className="flex-1">
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {dir.directory}
                      </span>
                      <span className="ml-2 text-xs text-slate-500">
                        {dir.projectName ?? "no project name"} · {dir.containerCount} container
                        {dir.containerCount === 1 ? "" : "s"} ·{" "}
                        {dir.running ? "running" : "stopped"}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {alreadyAdopted.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Already adopted
                </h3>
                <ul className="mt-1 flex flex-col gap-1 text-sm text-slate-500">
                  {alreadyAdopted.map((dir) => (
                    <li key={dir.directory}>{dir.directory}</li>
                  ))}
                </ul>
              </div>
            )}

            {orphans.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Orphan stacks
                </h3>
                <p className="mt-1 mb-2 text-xs text-slate-500">
                  A running compose project with no directory Homestead can see — often the reason a
                  directory above looks unadopted.
                </p>
                <ul className="flex flex-col gap-1 text-sm text-slate-500">
                  {orphans.map((orphan) => (
                    <li key={orphan.projectName}>
                      {orphan.projectName} · {orphan.containerCount} container
                      {orphan.containerCount === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
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
          onClick={handleAdopt}
          disabled={selected.size === 0 || submitting.size > 0}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          Adopt {selected.size}
        </button>
      </div>
    </DialogShell>
  );
}
