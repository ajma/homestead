import type { AdminApp } from "@shared/dto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminAppsKey } from "@web/api/admin";
import { type CatalogueEntry, useCatalogue } from "@web/api/catalogue";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { DialogShell } from "@web/components/DialogShell";
import { IconPicker } from "@web/components/IconPicker";
import { useState } from "react";

/**
 * The same rule `createBody` enforces in `src/server/routes/apps.ts` — checked here only
 * as a convenience so the field can complain before a round trip. This is not the
 * boundary: the server's zod schema, plus the host's `PathGuard`, stay the boundary.
 */
const DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `createBody`'s `directory` cap in `src/server/routes/apps.ts` — that zod schema is the
 * source of truth, this is just a mirror so the client can complain (or, for a suggested
 * slug, quietly fit within it) before a round trip.
 */
const DIRECTORY_MAX_LENGTH = 64;

/**
 * Mirrors a display name into a directory suggestion: lowercase, runs of anything other
 * than a letter or digit collapsed to one hyphen, leading/trailing hyphens trimmed, then
 * truncated to `DIRECTORY_MAX_LENGTH`. Truncating here — rather than refusing the result —
 * is deliberate: the user did not type this string, so silently fitting it is kinder than
 * an error about text they never chose.
 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DIRECTORY_MAX_LENGTH);
}

/**
 * Maps `POST /api/apps`'s error slugs to sentences a user can act on. Anything
 * unrecognised still falls back to a generic line plus the slug itself, so a new server
 * error is diagnosable from the screen rather than silently swallowed.
 *
 * `ApiError` (thrown by `apiFetch` for any non-2xx response, per `src/web/api/client.ts`)
 * is the rejected-request case: the server was reachable and said no. Anything else
 * reaching the mutation's `onError` — a plain `fetch` rejection — means the request never
 * got a response at all, which on a NAS is usually the box going away. Those need
 * different words: one means "try again", the other means "change something".
 */
function errorMessage(error: unknown): string {
  // Distinct from both branches below: `apiFetch` gave up waiting rather than the server
  // answering no, so the create may have gone through anyway — "could not reach the
  // server" is the wrong words for that, and the raw `ApiTimeoutError` message is a
  // developer string with a millisecond literal in it.
  if (error instanceof ApiTimeoutError) {
    return "The server did not respond. It may still be working; check again in a moment.";
  }
  if (!(error instanceof ApiError)) {
    return "Could not reach the server. Check the network and try again.";
  }
  if (error.body !== null && typeof error.body === "object" && "error" in error.body) {
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
  iconRef?: string;
  compose?: string;
};

/**
 * Keyword search over the three fields a browsing admin actually reads: name,
 * description, categories. Client-side, deliberately — the task brief is explicit that
 * fifty entries is small enough to filter in the browser, and building a server-side
 * search endpoint for this would be a second thing to keep in sync with the catalogue's
 * own shape for no benefit anyone would notice.
 */
function matchesQuery(entry: CatalogueEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.description.toLowerCase().includes(needle) ||
    entry.categories.some((category) => category.toLowerCase().includes(needle))
  );
}

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
 *
 * Task 4 adds the other way in: browsing and keyword-searching the 50-entry app catalogue
 * (`GET /api/catalogue`, admin-only — see `src/server/routes/catalogue.ts`) and filling
 * this SAME form from a chosen entry, rather than opening a second dialog or a second
 * create path. `iconRef` and `compose` start `null` and stay `null` for the blank flow —
 * the fields they gate (`Icon`, `Compose file`) render only once something has actually
 * set them, so starting blank looks and behaves exactly as it did before this task. Once
 * an entry is chosen, both fields are ordinary controlled state: nothing about the choice
 * is re-read from the catalogue at submit time, so editing them afterward is not a special
 * case to preserve, it falls out of the same `useState`/`onChange` wiring every other
 * field already has.
 *
 * The catalogue itself is fetched only while the browse panel is open (`useCatalogue`'s
 * `enabled` flag) — never imported, so its 50 compose bodies never enter this bundle. See
 * `src/web/api/catalogue.ts` and `src/shared/catalogue/index.ts`'s own doc comment.
 */
export function CreateAppDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState("");
  const [directory, setDirectory] = useState("");
  const [directoryTouched, setDirectoryTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [iconRef, setIconRef] = useState<string | null>(null);
  const [compose, setCompose] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [browsing, setBrowsing] = useState(false);
  const [catalogueQuery, setCatalogueQuery] = useState("");
  const catalogue = useCatalogue(browsing);
  const filteredCatalogue = (catalogue.data ?? []).filter((entry) =>
    matchesQuery(entry, catalogueQuery),
  );

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

  /**
   * Fills all four fields the brief asks for from a chosen entry, then returns to the
   * form. `directory` only follows the entry's own slug when the user has not already
   * hand-edited it — the identical "do not clobber a deliberate choice" rule
   * `handleDirectoryChange` already enforces for the display-name mirror, extended to a
   * second source that can also set it.
   */
  function handleSelectCatalogueEntry(entry: CatalogueEntry) {
    setDisplayName(entry.name);
    setDescription(entry.description);
    setIconRef(entry.iconRef);
    setCompose(entry.compose);
    if (!directoryTouched) setDirectory(entry.slug);
    setBrowsing(false);
    setCatalogueQuery("");
  }

  /** Discards a catalogue choice's icon and compose — the two fields that only exist
   * once something has set them — without touching the rest of the form, which the user
   * may have already edited by hand. */
  function handleStartBlank() {
    setIconRef(null);
    setCompose(null);
  }

  function handleCreate() {
    if (directory.length > DIRECTORY_MAX_LENGTH) {
      setError(`Directory must be ${DIRECTORY_MAX_LENGTH} characters or fewer.`);
      return;
    }
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
        iconRef: iconRef ?? undefined,
        // Routed through this SAME `POST /api/apps` call, in this SAME field the server
        // already accepts (`src/server/routes/apps.ts`'s `createBody.compose`) — never a
        // second create path. `undefined` here is exactly the blank flow's existing
        // behaviour: the server scaffolds a starter file when `compose` is absent.
        compose: compose ?? undefined,
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
        {browsing ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-900 dark:text-slate-100">
                Search the catalogue
              </span>
              <input
                type="search"
                value={catalogueQuery}
                onChange={(event) => setCatalogueQuery(event.target.value)}
                placeholder="Search by name, description or category…"
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
              />
            </label>

            {catalogue.isPending && (
              <p className="text-sm text-slate-500">Loading the catalogue…</p>
            )}
            {catalogue.isError && (
              <p className="text-sm text-rose-600 dark:text-rose-400">
                Could not load the catalogue.
              </p>
            )}
            {/* A search that matches nothing says so — an empty `<ul>` reads as broken,
             * not as "no results", to anyone who did not just read this component's
             * source. */}
            {!catalogue.isPending && !catalogue.isError && filteredCatalogue.length === 0 && (
              <p className="text-sm text-slate-500">No apps match “{catalogueQuery.trim()}”.</p>
            )}

            <ul className="flex flex-col gap-2">
              {filteredCatalogue.map((entry) => (
                <li key={entry.slug}>
                  <button
                    type="button"
                    onClick={() => handleSelectCatalogueEntry(entry)}
                    className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm dark:border-slate-800"
                  >
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {entry.name}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {entry.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => setBrowsing(false)}
              className="self-start rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              Back
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setBrowsing(true)}
                className="text-left text-sm font-medium text-slate-600 underline dark:text-slate-300"
              >
                Browse the catalogue…
              </button>
              {compose !== null && (
                <button
                  type="button"
                  onClick={handleStartBlank}
                  className="text-sm text-slate-500 underline dark:text-slate-400"
                >
                  Start blank instead
                </button>
              )}
            </div>

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

            {/* Icon and Compose file only appear once a catalogue entry has set them —
             * the blank flow never renders either, so it looks and behaves exactly as it
             * did before this task. Both remain ordinary controlled fields afterward. */}
            {compose !== null && (
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-900 dark:text-slate-100">Icon</span>
                <IconPicker value={iconRef} onChange={setIconRef} />
              </div>
            )}

            {compose !== null && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-900 dark:text-slate-100">Compose file</span>
                <textarea
                  value={compose}
                  onChange={(event) => setCompose(event.target.value)}
                  rows={10}
                  spellCheck={false}
                  className="rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs dark:border-slate-800 dark:bg-slate-950"
                />
              </label>
            )}

            {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          </div>
        )}
      </div>

      {!browsing && (
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
      )}
    </DialogShell>
  );
}
