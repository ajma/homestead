import { parseEnv, serialiseEnv, upsertEnv } from "@shared/env-file";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { envKey, useEnv } from "@web/api/admin";
import { ApiError, apiFetch } from "@web/api/client";
import type { EditAppContext } from "@web/routes/EditApp";
import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

/** `POST /api/apps/:id/env/reveal` with a `key`: one row, and nothing else. */
type RevealOne = { key: string; value: string };

/** `POST /api/apps/:id/env/reveal` with no `key`: the whole file, for raw mode and for save. */
type RevealAll = { content: string; hash: string | null; exists: boolean };

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

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      let baseContent: string;
      let baseHash: string | null;
      // Raw, once loaded, is the base — it holds whatever the user typed there, or just
      // the file as fetched if they never touched it. Table edits apply on top of it
      // exactly as they would on top of a fresh fetch, so a raw-mode edit is never
      // silently dropped by a save triggered after switching back to the table view.
      if (rawLoaded) {
        baseContent = rawText;
        baseHash = rawHash;
      } else {
        const whole = await apiFetch<RevealAll>(`/api/apps/${appId}/env/reveal`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        baseContent = whole.content;
        baseHash = whole.hash;
      }

      let entries = parseEnv(baseContent);
      for (const [key, value] of Object.entries(edits)) {
        entries = upsertEnv(entries, key, value);
      }
      const content = serialiseEnv(entries);

      const result = await apiFetch<{ hash: string }>(`/api/apps/${appId}/env`, {
        method: "PUT",
        body: JSON.stringify({ content, expectedHash: baseHash }),
      });

      setEdits({});
      setRevealed({});
      setRevealErrors({});
      rawLoadedRef.current = true;
      setRawText(content);
      setRawBaseline(content);
      setRawHash(result.hash);
      setRawLoaded(true);
      void queryClient.invalidateQueries({ queryKey: envKey(appId) });
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

  const { entries, exists } = envQuery.data;

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
