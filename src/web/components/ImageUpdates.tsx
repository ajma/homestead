import type { ImageStatusRow } from "@shared/admin.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { imagesKey, useImages } from "@web/api/admin";
import { apiFetch } from "@web/api/client";
import { useState } from "react";

/** `null` means "not known" — either no check has run yet, or the last one couldn't tell. */
function formatDigest(digest: string | null): string {
  return digest ?? "Unknown";
}

/**
 * The image-updates panel: one row per compose service, with whether a newer image is
 * sitting in the registry, plus a manual "Check now" that re-runs the sweep for this
 * app alone.
 *
 * Reads `updateAvailable` straight off each row rather than recomputing it here from
 * `currentDigest`/`latestDigest`. `ImageUpdateChecker` (1B-ii, `image-updates.ts`) only
 * sets that flag when both digests are known AND resolved against the same repository —
 * a null `currentDigest` (Docker inspect failed, or no check has run) compared against a
 * known `latestDigest` with a plain `!==` would read as "different", so a naive
 * recomputation here would report an update the server never found and pulling could
 * never clear. That is the exact "badge that never clears" bug 1B-ii closed server-side;
 * this component's job is to trust that field, not reopen the bug by re-deriving it.
 *
 * "Check now" is the only thing that triggers a re-check — never on mount, never on an
 * interval. Two concurrent `POST /images/check` for one app both run the full sweep (a
 * known, accepted gap from 1B-ii — consistent in the end via `onConflictDoUpdate`, just
 * wasteful), so a component that fired one automatically every time it mounted would
 * make that gap worse rather than merely living with it.
 */
export function ImageUpdates({ appId }: { appId: string }) {
  const queryClient = useQueryClient();
  const { data: images, isPending, isError } = useImages(appId);
  const [checkError, setCheckError] = useState<string | null>(null);

  const checkMutation = useMutation({
    // `apiFetch`'s 30s default is too short here: the server checks every service's
    // image sequentially (`ImageUpdateChecker.check`), and each one can spend up to
    // `REQUEST_TIMEOUT_MS` (10s, registry.ts) three times over — a HEAD, a token
    // exchange, and a retried HEAD — before giving up on that one registry. A handful of
    // services can genuinely take minutes; 120s is a generous ceiling for a manual
    // "Check now" rather than a number picked to paper over a hang.
    mutationFn: () =>
      apiFetch<ImageStatusRow[]>(
        `/api/apps/${appId}/images/check`,
        { method: "POST" },
        { timeoutMs: 120_000 },
      ),
  });

  function handleCheck() {
    setCheckError(null);
    checkMutation.mutate(undefined, {
      onSuccess: (rows) => {
        // The check response already carries the fresh rows this app's sweep produced —
        // writing them straight into the cache shows the result immediately, rather than
        // discarding them and waiting on a second round trip `invalidateQueries` would cost.
        queryClient.setQueryData(imagesKey(appId), rows);
      },
      onError: () => {
        // Deliberately does not touch the cache. The last known state — whatever
        // `useImages` already has — stays exactly as it was; a failed check is not
        // evidence that the previous answer was wrong.
        setCheckError("Could not check for updates.");
      },
    });
  }

  if (isPending) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">Loading images…</p>;
  }

  if (isError || !images) {
    return <p className="text-sm text-rose-600 dark:text-rose-400">Could not load image status.</p>;
  }

  const updateCount = images.filter((image) => image.updateAvailable).length;

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Images</h2>
        <div className="flex items-center gap-2">
          {updateCount > 0 && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              {updateCount} update{updateCount === 1 ? "" : "s"}
            </span>
          )}
          <button
            type="button"
            disabled={checkMutation.isPending}
            onClick={handleCheck}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-800"
          >
            {checkMutation.isPending ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>

      {checkError && <p className="text-xs text-rose-600 dark:text-rose-400">{checkError}</p>}

      {images.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">No images checked yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {images.map((image) => (
            <li key={image.serviceName} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-medium text-slate-900 dark:text-slate-100">
                {image.serviceName}
              </span>
              <span className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
                {formatDigest(image.currentDigest)}
                {image.updateAvailable ? ` → ${formatDigest(image.latestDigest)}` : ""}
              </span>
              {image.updateAvailable && (
                <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                  Update
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
