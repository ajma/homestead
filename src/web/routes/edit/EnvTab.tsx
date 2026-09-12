import { maskEnv, parseEnv, serialiseEnv, upsertEnv } from "@shared/env-file";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { envKey, useEnv } from "@web/api/admin";
import { ApiError, apiFetch } from "@web/api/client";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import type { EditAppContext } from "@web/routes/EditApp";
import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

/** `POST /api/apps/:id/env/reveal` with a `key`: one row, and nothing else. */
type RevealOne = { key: string; value: string };

/** `POST /api/apps/:id/env/reveal` with no `key`: the whole file, for raw mode and for save. */
type RevealAll = { content: string; hash: string | null; exists: boolean };

/**
 * A save the server refused with 409: the file on disk no longer matches the hash this
 * tab last saw. `mine` is the exact content this tab tried to write — captured at the
 * moment of conflict rather than recomputed later, so "keep mine" resends precisely what
 * was refused rather than something reconstructed after the fact from state that may have
 * moved on. `disk` is `null` while that copy is still being fetched, or if the fetch
 * itself failed — same shape `ComposeTab`'s own `Conflict` uses, for the same reason.
 */
type Conflict = { message: string; disk: RevealAll | null; mine: string };

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | undefined;
    if (typeof body?.message === "string") return body.message;
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Turns a failure to even load `GET .../env` into a sentence.
 *
 * A 403 here is deliberately not shown as the server phrases it ("Missing capability:
 * app:config") — the row list only needs `app:config`, but nothing on this tab is worth
 * doing without `app:secrets` too (reveal and save both require it), so this names the
 * capability that actually matters to a person deciding what to do next. A 409
 * `env_unreadable` is shown as the server phrases it instead: that message already says
 * exactly what is wrong (`.env` exists, Homestead cannot read it) and why, and repeating
 * it here rather than paraphrasing keeps the one useful piece of detail — "check its
 * ownership and mode" — intact.
 */
function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return "You don't have permission to manage this app's secrets — that needs the app:secrets capability.";
  }
  return messageFrom(error, "Could not load this app's environment variables.");
}

/**
 * The edit page's `.env` tab: a masked key/value table with reveal-per-row, plus a raw
 * mode for bulk paste.
 *
 * The rule that shapes everything below: this table edits *entries*, not text. `.env`
 * files are hand-maintained over SSH and their comments carry real information —
 * `upsertEnv`'s own docstring records the measured reason it exists, that rebuilding a
 * file from key/value pairs "would make editing one variable destroy the note explaining
 * why it is set". So a save here never rebuilds the file: it fetches the file's current
 * full content, applies each changed key with `upsertEnv`, and `PUT`s the result with the
 * hash *that fetch* returned — every untouched line survives byte-identical, the same
 * guarantee `ComposeTab`'s hash dance gives compose.yaml.
 *
 * Secrets are handled the way Task 2's server half was built for: a row's value is never
 * fetched until its own "Reveal" is clicked, and each reveal names its key in the
 * request — never a whole-file fetch filtered client-side, which would put every secret
 * in the browser to display one. Raw mode is the one deliberate exception: bulk paste
 * needs the real text, so switching to it fetches the whole file once, through the same
 * `app:secrets`-gated endpoint.
 *
 * `PUT .../env` carries the same hash guard `ComposeTab` uses and can answer the same
 * 409 — and `.env` is the file that holds secrets, so an SSH edit clobbered here is worse
 * than one in compose. Table edits get the gentler of two responses: since they only ever
 * change specific keys via `upsertEnv`, a 409 there is handled by refetching the file and
 * reapplying those same key edits onto whatever is on disk now, merging both changes
 * without asking — nothing is lost either way, the same guarantee `upsertEnv` already
 * gives untouched lines within a single save. A raw-mode edit cannot be merged like that
 * — it is arbitrary free-form text, not a set of named key changes — so it gets exactly
 * `ComposeTab`'s explicit, two-choice conflict UI instead: load the disk version, or keep
 * mine and overwrite it deliberately. See `handleSave`, `handleUseDiskVersion` and
 * `handleKeepMineOverwrite`.
 */
export function EnvTab() {
  const { app } = useOutletContext<EditAppContext>();
  const appId = app.id;
  const queryClient = useQueryClient();
  const envQuery = useEnv(appId);

  const [mode, setMode] = useState<"table" | "raw">("table");

  // Table edits, keyed by KEY rather than by row: `upsertEnv` only ever rewrites the
  // LAST occurrence of a duplicated key (the one compose actually reads), so that is the
  // one edit any row sharing that name can produce, regardless of which row's input the
  // user typed into.
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Revealed values, keyed by row INDEX rather than key: two rows can share a key (see
  // the "shadowed" note below), and each reveals independently even though both would
  // return the same value.
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [revealErrors, setRevealErrors] = useState<Record<number, string>>({});

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmingUseDisk, setConfirmingUseDisk] = useState(false);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);

  // Raw mode's own copy of the file, seeded exactly once from `rawQuery` — the same
  // "seed once, then this state is the only truth" pattern `ComposeTab` uses for its
  // editor, so a background refetch never overwrites text someone is mid-edit on. Kept
  // disabled once loaded (see `enabled` below) for a reason specific to this endpoint:
  // unlike compose.yaml, re-fetching this is another whole-file secret reveal, audited
  // every time — nothing here should trigger that just because a `staleTime` elapsed.
  const rawLoadedRef = useRef(false);
  const [rawText, setRawText] = useState("");
  const [rawBaseline, setRawBaseline] = useState<string | null>(null);
  const [rawHash, setRawHash] = useState<string | null>(null);
  const [rawLoaded, setRawLoaded] = useState(false);

  const rawQuery = useQuery({
    queryKey: [...envKey(appId), "raw"],
    enabled: mode === "raw" && !rawLoaded,
    queryFn: () =>
      apiFetch<RevealAll>(`/api/apps/${appId}/env/reveal`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    retry: false,
  });

  useEffect(() => {
    if (rawLoadedRef.current) return;
    if (!rawQuery.data) return;
    rawLoadedRef.current = true;
    setRawText(rawQuery.data.content);
    setRawBaseline(rawQuery.data.content);
    setRawHash(rawQuery.data.hash);
    setRawLoaded(true);
  }, [rawQuery.data]);

  const rawDirty = rawBaseline !== null && rawText !== rawBaseline;
  const dirty = Object.keys(edits).length > 0 || rawDirty;

  // A `Set` of in-flight row indices, not a single `useMutation` shared across every row.
  // `useMutation` keeps its per-call `onSuccess`/`onError` on one field of the shared
  // observer, so a second `mutate()` fired before the first settles overwrites it — the
  // first row's own reveal would silently resolve into the SECOND row's callback instead
  // of its own. Measured here: revealing two rows back to back left one row stuck masked
  // and the other showing the right value under the wrong key. Plain `apiFetch` calls,
  // each with its own closure over `index`/`key`, have no shared field to clobber.
  const [revealingIndices, setRevealingIndices] = useState<ReadonlySet<number>>(new Set());

  async function handleReveal(index: number, key: string) {
    setRevealErrors((prev) => {
      if (!(index in prev)) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setRevealingIndices((prev) => new Set(prev).add(index));
    try {
      const data = await apiFetch<RevealOne>(`/api/apps/${appId}/env/reveal`, {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      setRevealed((prev) => ({ ...prev, [index]: data.value }));
    } catch (error) {
      setRevealErrors((prev) => ({
        ...prev,
        [index]: messageFrom(error, "Could not reveal this value."),
      }));
    } finally {
      setRevealingIndices((prev) => {
        if (!prev.has(index)) return prev;
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  }

  function applyEdits(baseContent: string): string {
    let entries = parseEnv(baseContent);
    for (const [key, value] of Object.entries(edits)) {
      entries = upsertEnv(entries, key, value);
    }
    return serialiseEnv(entries);
  }

  function fetchWhole(): Promise<RevealAll> {
    return apiFetch<RevealAll>(`/api/apps/${appId}/env/reveal`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  function putEnv(content: string, expectedHash: string | null): Promise<{ hash: string }> {
    return apiFetch<{ hash: string }>(`/api/apps/${appId}/env`, {
      method: "PUT",
      body: JSON.stringify({ content, expectedHash }),
    });
  }

  function onSaveSuccess(content: string, hash: string) {
    setEdits({});
    setRevealed({});
    setRevealErrors({});
    rawLoadedRef.current = true;
    setRawText(content);
    setRawBaseline(content);
    setRawHash(hash);
    setRawLoaded(true);
    setConflict(null);
    void queryClient.invalidateQueries({ queryKey: envKey(appId) });
  }

  // Fetches the disk copy to show alongside the conflict, best-effort exactly like
  // `ComposeTab`'s own conflict handler: if this fails, the banner still explains what
  // happened, it just can't offer the disk text to compare against or load. The write
  // itself already failed safely either way.
  async function openConflict(error: unknown, mine: string) {
    setConflict({
      message: messageFrom(error, "The file changed on disk since you loaded it."),
      disk: null,
      mine,
    });
    try {
      const disk = await fetchWhole();
      setConflict((prev) => (prev ? { ...prev, disk } : prev));
    } catch {
      // Best effort — see the comment above.
    }
  }

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      // Raw, once loaded, is the base — it holds whatever the user typed there, or just
      // the file as fetched if they never touched it. Table edits apply on top of it
      // exactly as they would on top of a fresh fetch, so a raw-mode edit is never
      // silently dropped by a save triggered after switching back to the table view.
      let base: { content: string; hash: string | null };
      if (rawLoaded) {
        base = { content: rawText, hash: rawHash };
      } else {
        const whole = await fetchWhole();
        base = { content: whole.content, hash: whole.hash };
      }
      const content = applyEdits(base.content);

      try {
        const result = await putEnv(content, base.hash);
        onSaveSuccess(content, result.hash);
        return;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) {
          setSaveError(messageFrom(error, "Could not save the .env file."));
          return;
        }

        if (rawDirty) {
          // `rawText` is the user's own free-form edit — there is no way to merge it
          // onto whatever the disk holds now without a diff, so (per the brief) this
          // needs the same explicit, two-choice conflict `ComposeTab` uses for its own
          // whole-file edits.
          await openConflict(error, content);
          return;
        }

        // Nothing free-form is at risk here: `base.content` is exactly what this tab
        // last fetched (the raw snapshot, untouched, or a fetch made moments ago), so
        // refetching and reapplying `edits` on top of the fresh copy merges the user's
        // changed keys onto whatever is on disk now instead of clobbering it — the same
        // guarantee `upsertEnv` already gives untouched lines within one save.
        // Declared outside the `try` so the `catch` below can still reach whichever
        // value was last assigned — a plain `const` inside `try` would fall out of
        // scope at the closing brace before the `catch` ever ran.
        let retryContent = content;
        try {
          const fresh = await fetchWhole();
          retryContent = applyEdits(fresh.content);
          const result = await putEnv(retryContent, fresh.hash);
          onSaveSuccess(retryContent, result.hash);
        } catch (retryError) {
          if (retryError instanceof ApiError && retryError.status === 409) {
            // A second concurrent edit landed between the retry's own fetch and its
            // PUT — rare, but the merge-and-retry trick can't be repeated forever.
            // Falls back to the same explicit choice raw edits get. `retryContent`
            // (the edits merged onto the fresher of the two disk copies seen so far)
            // is a better "mine" here than the original `content` would be.
            await openConflict(retryError, retryContent);
          } else {
            setSaveError(messageFrom(retryError, "Could not save the .env file."));
          }
        }
      }
    } finally {
      setSaving(false);
    }
  }

  function handleUseDiskVersion() {
    const disk = conflict?.disk;
    if (!disk) return;
    rawLoadedRef.current = true;
    setRawText(disk.content);
    setRawBaseline(disk.content);
    setRawHash(disk.hash);
    setRawLoaded(true);
    setConflict(null);
    void queryClient.invalidateQueries({ queryKey: envKey(appId) });
  }

  // The conflict's other resolution: resend exactly what this tab tried to save —
  // `conflict.mine`, captured at the moment of the 409 — guarded by the fresh hash the
  // conflict fetched, so it overwrites the disk's newer content deliberately rather than
  // bouncing off the same stale hash again.
  async function handleKeepMineOverwrite() {
    const disk = conflict?.disk;
    if (!disk) return;
    setSaveError(null);
    setSaving(true);
    try {
      const result = await putEnv(conflict.mine, disk.hash);
      onSaveSuccess(conflict.mine, result.hash);
    } catch (error) {
      setSaveError(messageFrom(error, "Could not save the .env file."));
    } finally {
      setSaving(false);
    }
  }

  if (envQuery.isPending) {
    return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Loading .env…</p>;
  }

  if (envQuery.isError) {
    return (
      <p className="p-4 text-sm text-rose-600 dark:text-rose-400">
        {loadErrorMessage(envQuery.error)}
      </p>
    );
  }

  const { exists } = envQuery.data;
  // Once raw has been loaded, it — not the original `GET` response — is the source of
  // truth for what this tab would save (see `handleSave`'s own comment on why), so the
  // table has to read from the same place or a raw-mode edit stays invisible here until
  // saved: added, removed, and renamed keys just wouldn't appear. Values still come out
  // masked regardless — `maskEnv` never lets a value it computes carry the real secret,
  // it only decides whether a row is masked or empty, so switching back from raw does not
  // hand the table anything it wasn't already showing.
  const entries = rawLoaded ? maskEnv(parseEnv(rawText)) : envQuery.data.entries;

  // A row is shadowed when a LATER row in this same list repeats its key. `maskEnv`
  // does not deduplicate, so a `.env` with a key twice produces two rows for it — and
  // both reveal the same value, because reveal (like `upsertEnv`) acts on the LAST
  // occurrence, the one compose actually reads. Correct, but baffling in a table without
  // this: two rows, same name, same revealed value, no indication why.
  const lastIndexForKey = new Map<string, number>();
  entries.forEach((entry, index) => {
    lastIndexForKey.set(entry.key, index);
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2" role="tablist" aria-label="View">
        <button
          type="button"
          onClick={() => setMode("table")}
          aria-pressed={mode === "table"}
          className={`rounded-lg px-3 py-1.5 text-sm ${
            mode === "table"
              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
              : "border border-slate-200 dark:border-slate-800"
          }`}
        >
          Table
        </button>
        <button
          type="button"
          onClick={() => setMode("raw")}
          aria-pressed={mode === "raw"}
          className={`rounded-lg px-3 py-1.5 text-sm ${
            mode === "raw"
              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
              : "border border-slate-200 dark:border-slate-800"
          }`}
        >
          Raw
        </button>
      </div>

      {conflict && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Someone changed this file since you loaded it.</p>
          <p className="mt-1">
            {conflict.message} Your edits have not been touched — the save that would have
            overwritten them was refused instead.
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
              onClick={() => setConfirmingUseDisk(true)}
              className="rounded-lg border border-amber-400 px-2 py-1 text-xs font-medium disabled:opacity-50 dark:border-amber-700"
            >
              Load the version on disk instead
            </button>
            <button
              type="button"
              disabled={!conflict.disk}
              onClick={() => setConfirmingOverwrite(true)}
              className="rounded-lg border border-rose-400 px-2 py-1 text-xs font-medium text-rose-700 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300"
            >
              Keep mine — overwrite the disk version
            </button>
          </div>
        </div>
      )}

      {confirmingUseDisk && conflict?.disk && (
        <ConfirmDialog
          title="Load the version on disk"
          message="This replaces this tab's raw text with .env's current contents on disk, and adopts its hash. What you've typed here will be gone unless you've copied it out first."
          confirmLabel="Load it"
          destructive
          onConfirm={handleUseDiskVersion}
          onClose={() => setConfirmingUseDisk(false)}
        />
      )}

      {confirmingOverwrite && conflict?.disk && (
        <ConfirmDialog
          title="Overwrite the version on disk"
          message="This saves your edits over what's currently on disk, discarding the change that caused this conflict — the one shown above. There is no undo once this is confirmed."
          confirmLabel="Overwrite"
          destructive
          onConfirm={handleKeepMineOverwrite}
          onClose={() => setConfirmingOverwrite(false)}
        />
      )}

      {saveError && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {saveError}
        </p>
      )}

      {mode === "table" &&
        (entries.length === 0 ? (
          <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
            {exists
              ? "This .env file has no variables set."
              : "This app has no .env file yet — switch to Raw to create one."}
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <tbody>
              {entries.map((entry, index) => {
                const shadowed = lastIndexForKey.get(entry.key) !== index;
                const value = edits[entry.key] ?? revealed[index];
                const revealPending = revealingIndices.has(index);
                return (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are keyed by position on purpose — a duplicated key is two distinct rows here.
                    key={index}
                    className="border-t border-slate-200 dark:border-slate-800"
                  >
                    <td className="py-2 pr-3 align-top font-mono text-xs text-slate-900 dark:text-slate-100">
                      {entry.key}
                      {shadowed && (
                        <p className="mt-1 max-w-[16rem] text-xs font-normal italic text-amber-600 dark:text-amber-400">
                          Set again below — that later line is the one compose reads.
                        </p>
                      )}
                    </td>
                    <td className="py-2 align-top">
                      {value !== undefined ? (
                        <input
                          type="text"
                          value={value}
                          onChange={(event) =>
                            setEdits((prev) => ({ ...prev, [entry.key]: event.target.value }))
                          }
                          aria-label={`${entry.key} value`}
                          className="w-full rounded-lg border border-slate-200 px-2 py-1 font-mono text-xs dark:border-slate-800 dark:bg-slate-950"
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            readOnly
                            value={entry.masked}
                            aria-label={`${entry.key} value`}
                            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
                          />
                          <button
                            type="button"
                            onClick={() => handleReveal(index, entry.key)}
                            disabled={revealPending}
                            className="shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-800"
                          >
                            {revealPending ? "Revealing…" : "Reveal"}
                          </button>
                        </div>
                      )}
                      {revealErrors[index] && (
                        <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                          {revealErrors[index]}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}

      {mode === "raw" &&
        (rawLoaded ? (
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            spellCheck={false}
            aria-label=".env file contents"
            className="min-h-64 w-full rounded-2xl border border-slate-200 p-3 font-mono text-xs dark:border-slate-800 dark:bg-slate-950"
          />
        ) : rawQuery.isError ? (
          <p className="p-4 text-sm text-rose-600 dark:text-rose-400">
            {loadErrorMessage(rawQuery.error)}
          </p>
        ) : (
          <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Loading the whole file…</p>
        ))}

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
  );
}
