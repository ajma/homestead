import { autocompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import composeSchema from "@shared/schema/compose-spec.json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComposeFile, composeKey, useCompose } from "@web/api/admin";
import { ApiError, apiFetch } from "@web/api/client";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { completionsEnabled } from "@web/editor/desktop-only";
import { documentCompletion } from "@web/editor/document-completion";
import { envCompletion } from "@web/editor/env-completion";
import { schemaCompletion } from "@web/editor/schema-completion";
import { useServerValidate } from "@web/editor/use-server-validate";
import { YamlEditor } from "@web/editor/YamlEditor";
import { lintYaml } from "@web/editor/yaml-lint";
import type { EditAppContext } from "@web/routes/EditApp";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

/**
 * The masked `.env` endpoint's shape, trimmed to the one field this tab needs. A local
 * type rather than a shared one — like `ProbesPanel`'s `ProbeSuggestion` — because
 * nothing here infers a request body from it; it only ever lands where a `fetch`
 * response is read.
 */
type EnvKeysResponse = { entries: Array<{ key: string }> };

/** A save the server refused with 409: the file on disk no longer matches what this tab loaded. */
type Conflict = {
  message: string;
  /** `null` while the disk copy is still being fetched, or if that fetch itself failed. */
  disk: ComposeFile | null;
};

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | undefined;
    if (typeof body?.message === "string") return body.message;
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * The edit page's Compose tab: a YAML editor over `compose.yaml` itself, wired to both
 * lint layers (Task 5's instant schema walk and Task 9's debounced server round trip)
 * and, on a wide-enough pointer-driven screen, the three completion sources Tasks 7 and
 * 8 built.
 *
 * The one behaviour every other decision here serves is the 409: `PUT` carries the
 * SHA-256 hash this tab loaded the file with, and the server refuses the write when
 * that hash is stale — meaning somebody (over SSH, almost always) edited the file while
 * this tab sat open. Both obvious reflexes to that are wrong. Saving anyway would
 * silently erase their edit. Reloading the file to "fix" the mismatch would silently
 * erase the user's own typing, which they may have spent real time on. Neither happens
 * here automatically: a conflict fetches the disk copy alongside the user's own — still
 * sitting untouched in the editor — and only an explicit, confirmed choice replaces one
 * with the other. See the save mutation's `onError` and the conflict banner below.
 *
 * Reads the app via `useOutletContext`, the same pattern `OverviewTab`, `ContainersTab`
 * and `LogsTab` use — re-resolving `:slug` here would defeat the point of the tabs
 * sharing one lookup.
 */
export function ComposeTab() {
  const { app } = useOutletContext<EditAppContext>();
  const appId = app.id;
  const queryClient = useQueryClient();
  const composeQuery = useCompose(appId);

  // Seeded from the query exactly once. A background refetch of `composeQuery` (its
  // `staleTime` eventually elapsing, say) must never silently overwrite text the user
  // is mid-edit on — the exact mistake this whole component exists to avoid making
  // through a different door. Once loaded, this component's own state is the only
  // source of truth for what the editor shows; the query is not consulted again except
  // to seed it the first time.
  const loadedRef = useRef(false);
  const [text, setText] = useState("");
  const [baseline, setBaseline] = useState<string | null>(null);
  const [loadedHash, setLoadedHash] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loadedRef.current) return;
    if (!composeQuery.data) return;
    loadedRef.current = true;
    setText(composeQuery.data.content);
    setBaseline(composeQuery.data.content);
    setLoadedHash(composeQuery.data.hash);
    setLoaded(true);
  }, [composeQuery.data]);

  const dirty = baseline !== null && text !== baseline;

  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmingReload, setConfirmingReload] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (body: { content: string; expectedHash: string | null }) =>
      apiFetch<{ hash: string }>(`/api/apps/${appId}/compose`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
  });

  function handleSave() {
    setSaveError(null);
    const content = text;
    saveMutation.mutate(
      { content, expectedHash: loadedHash },
      {
        onSuccess: (result) => {
          setLoadedHash(result.hash);
          setBaseline(content);
          setConflict(null);
          queryClient.setQueryData(composeKey(appId), { content, hash: result.hash });
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            setConflict({
              message: messageFrom(error, "The file changed on disk since you loaded it."),
              disk: null,
            });
            // Best effort: if this fails, the banner still explains what happened, it
            // just can't offer the disk copy to compare against or load. The write
            // itself already failed safely either way — this is only fetching context
            // for the human, not anything the save's own correctness depends on.
            apiFetch<ComposeFile>(`/api/apps/${appId}/compose`).then(
              (disk) => setConflict((prev) => (prev ? { ...prev, disk } : prev)),
              () => {},
            );
            return;
          }
          setSaveError(messageFrom(error, "Could not save compose.yaml."));
        },
      },
    );
  }

  function handleLoadDiskVersion() {
    const disk = conflict?.disk;
    if (!disk) return;
    setText(disk.content);
    setBaseline(disk.content);
    setLoadedHash(disk.hash);
    setConflict(null);
    queryClient.setQueryData(composeKey(appId), disk);
  }

  // A ref, read from a `beforeunload` listener installed once on mount. Rebuilding the
  // listener on every keystroke (the naive `[dirty]` dependency) would work too, but
  // this way there is exactly one add/remove pair for the component's whole lifetime.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    function handler(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      // Chrome ignores `preventDefault` alone and still requires `returnValue` set to
      // something truthy to show its own confirmation prompt.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Computed once per mount, not re-read on resize — a popup that was absent when this
  // tab opened staying absent through a later resize is an acceptable simplification;
  // see `completionsEnabled`'s own doc comment for what it's protecting against.
  const [desktop] = useState(() => completionsEnabled(window));

  const envQuery = useQuery({
    queryKey: [...composeKey(appId), "env-keys"],
    // Fetching `.env` just to feed a completion popup that will never open is a round
    // trip a narrow-viewport visitor gets no benefit from.
    enabled: desktop,
    queryFn: () => apiFetch<EnvKeysResponse>(`/api/apps/${appId}/env`),
    staleTime: 15_000,
  });

  const envKeysRef = useRef<string[]>([]);
  envKeysRef.current = envQuery.data?.entries.map((entry) => entry.key) ?? [];
  // Stable across renders (empty dependency array), which is what lets `envCompletion`
  // be built once inside the `useMemo` below instead of being rebuilt whenever the
  // `.env` keys change — the source reads `envKeysRef.current` fresh on every
  // completion request instead. See `envCompletion`'s own doc comment.
  const getEnvKeys = useCallback(() => envKeysRef.current, []);

  // `extraExtensions` reconfigures `YamlEditor`'s CodeMirror compartment by identity,
  // not content (see that component's doc comment) — an unmemoised array here would
  // reconfigure the editor on every keystroke, since every keystroke re-renders this
  // component. `desktop` and `getEnvKeys` are both stable for the component's whole
  // lifetime, so this `useMemo` produces exactly one array, ever.
  const extraExtensions = useMemo<Extension[]>(() => {
    if (!desktop) return [];
    return [
      autocompletion({
        override: [
          schemaCompletion(composeSchema),
          envCompletion(getEnvKeys),
          documentCompletion(),
        ],
      }),
    ];
  }, [desktop, getEnvKeys]);

  const diagnostics = useMemo(() => lintYaml(text, composeSchema), [text]);

  // Layer one already knows the document is syntactically broken — `docker compose
  // config` would certainly fail too, at the cost of a real subprocess on the NAS, on
  // every debounce tick while someone is mid-edit. And validating text nobody has typed
  // yet (fresh off the initial load) buys nothing: it's a spawn spent confirming a file
  // that hasn't changed since the last time anyone (if ever) checked it. Both live here,
  // not in the hook, because both require knowing about layer one and about `dirty` —
  // the hook stays a dumb debounced fetcher that only does what it's told.
  const hasSyntaxError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const serverCheckEnabled = dirty && !hasSyntaxError;
  const { message: serverMessage } = useServerValidate(appId, text, serverCheckEnabled);

  if (!loaded) {
    if (composeQuery.isPending) {
      return (
        <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Loading compose.yaml…</p>
      );
    }
    return (
      <p className="p-4 text-sm text-rose-600 dark:text-rose-400">
        Could not read compose.yaml. It may be missing, or unreadable on disk — check its ownership
        and mode.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {conflict && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Someone changed this file since you loaded it.</p>
          <p className="mt-1">
            {conflict.message} Your edits in this tab have not been touched — the save that would
            have overwritten them was refused instead.
          </p>
          {conflict.disk && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium">
                Show the version currently on disk
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-white p-2 text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-200">
                {conflict.disk.content}
              </pre>
            </details>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setConflict(null)}
              className="rounded-lg border border-amber-400 px-2 py-1 text-xs font-medium dark:border-amber-700"
            >
              Keep editing my version
            </button>
            <button
              type="button"
              disabled={!conflict.disk}
              onClick={() => setConfirmingReload(true)}
              className="rounded-lg border border-amber-400 px-2 py-1 text-xs font-medium disabled:opacity-50 dark:border-amber-700"
            >
              Load the version on disk instead
            </button>
          </div>
        </div>
      )}

      {confirmingReload && conflict?.disk && (
        <ConfirmDialog
          title="Load the version on disk"
          message="This replaces the text in this tab with compose.yaml's current contents on disk. What you've typed here will be gone unless you've copied it out first."
          confirmLabel="Load it"
          destructive
          onConfirm={handleLoadDiskVersion}
          onClose={() => setConfirmingReload(false)}
        />
      )}

      {serverMessage && (
        <p className="rounded-2xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
          {serverMessage}
        </p>
      )}

      {/* The server round trip is skipped (not just pending) here — say so, so silence
          doesn't read as a passing check, and so a verdict still shown above is clearly
          not about the text on screen right now. */}
      {!serverCheckEnabled && (
        <p className="text-xs italic text-slate-500 dark:text-slate-400">
          {hasSyntaxError
            ? "Server check paused until the YAML syntax error is fixed. Any message above may be stale."
            : "Server check not running yet — it starts once you edit the file."}
        </p>
      )}

      {saveError && (
        <p className="text-sm text-rose-600 dark:text-rose-400" role="alert">
          {saveError}
        </p>
      )}

      <YamlEditor
        value={text}
        onChange={setText}
        diagnostics={diagnostics}
        extraExtensions={extraExtensions}
      />

      <div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saveMutation.isPending}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
