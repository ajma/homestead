import type { EnvEntry } from "@shared/env-file";
import { maskEnv, parseEnv, removeEnv, serialiseEnv, upsertEnv } from "@shared/env-file";
import { useQueryClient } from "@tanstack/react-query";
import { envKey, useEnv } from "@web/api/admin";
import { ApiError, apiFetch } from "@web/api/client";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import type { EditAppContext } from "@web/routes/EditApp";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

/** `POST /api/apps/:id/env/reveal` with a `key`: one row, and nothing else. */
type RevealOne = { key: string; value: string };

/** `POST /api/apps/:id/env/reveal` with no `key`: the whole file, for raw mode and for save. */
type RevealAll = { content: string; hash: string | null; exists: boolean };

/**
 * Why a whole-file reveal is happening — sent to the server so the audit row it writes
 * says which of the two it was, rather than leaving both indistinguishable "scope: all"
 * lines for the reader to guess between (see the Important finding this exists to fix).
 * `"raw-edit"` is `loadRaw`'s own deliberate reveal, for bulk paste. `"save-merge"` is
 * every other caller here — `handleSave`'s own fetch, its 409 retry, and `openConflict`'s
 * best-effort disk copy — all triggered by clicking Save, never by the user asking to see
 * the file. Closed set on purpose: the server validates against it, so nothing free-text
 * ever lands in an audit row.
 */
type RevealAllReason = "raw-edit" | "save-merge";

/** The two 409 causes this tab can hit — see `conflictKindFrom` for how they're told apart. */
type ConflictKind = "stale_hash" | "env_unreadable" | "unknown";

/**
 * A save the server refused with 409: the file on disk no longer matches the hash this
 * tab last saw. `mine` is the exact content this tab tried to write — captured at the
 * moment of conflict rather than recomputed later, so "keep mine" resends precisely what
 * was refused rather than something reconstructed after the fact from state that may have
 * moved on. `disk` is `null` while that copy is still being fetched, or if the fetch
 * itself failed — same shape `ComposeTab`'s own `Conflict` uses, for the same reason.
 * `kind` is what lets the banner below say the right thing: a stale hash and an
 * unreadable file are both a 409, but only one of them means "someone else touched this
 * file" — see the Minor finding this exists to fix.
 */
type Conflict = { kind: ConflictKind; message: string; disk: RevealAll | null; mine: string };

/**
 * One table-edited key whose value on the fresh disk copy no longer matches what this
 * tab loaded it as when the user started editing it — either changed to something else,
 * or removed outright (`theirs: null`). Every OTHER key the user touched still merges
 * silently; only these need a decision, which is what makes this narrower than raw
 * mode's whole-file `Conflict`.
 */
type KeyConflictEntry = { key: string; mine: string; theirs: string | null };

/**
 * The table-edit retry's own conflict. `safeContent` already has every non-conflicting
 * edited key reapplied onto the fresh file — `handleResolveKeyConflict` only has to layer
 * the user's per-key choices for `entries` on top of it, never re-deriving what was
 * already safe to merge.
 */
type KeyConflict = { entries: KeyConflictEntry[]; safeContent: string; freshHash: string | null };

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | undefined;
    if (typeof body?.message === "string") return body.message;
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Both `PUT .../env` and the whole-file `POST .../env/reveal` answer 409 for two
 * unrelated reasons — a stale hash (someone else wrote the file) or `env_unreadable`
 * (nobody can read it right now, hash or no hash) — and the server tells them apart in
 * the body's `error` field. Conflating them used to show "Someone changed this file
 * since you loaded it" for a permissions problem no concurrent edit caused; see the
 * Minor finding this exists to fix.
 */
function conflictKindFrom(error: unknown): ConflictKind {
  if (error instanceof ApiError && error.status === 409) {
    const body = error.body as { error?: unknown } | undefined;
    if (body?.error === "env_unreadable") return "env_unreadable";
    if (body?.error === "stale_hash") return "stale_hash";
  }
  return "unknown";
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
 * Whether a successful save should also update this tab's own copy of the raw file
 * text, and what it should become if so.
 *
 * Only keep tracking the real text if this tab was already doing so (i.e. raw mode is
 * what produced this save, or a previous raw-mode load is still what's dirty). A save
 * that started from pure table edits never had the whole file resident before this —
 * succeeding must not be the thing that first puts it there.
 *
 * Pulled out as its own pure function, and exported, because the guard it embodies
 * (`rawLoaded` gating whether the newly-saved content — every secret in the file, not
 * just the one the user edited — gets parked in component state) has no way to bind a
 * test to it once it's inline in a `useState` setter: the final review measured that
 * replacing the equivalent inline `if (rawLoaded)` with `if (true)` left the entire
 * 1095-test suite green, because nothing downstream ever reads `rawText` while
 * `rawLoaded` is false (see `EnvTab`'s render below) — the leak is real but invisible
 * to the DOM. Testing this function directly, in isolation from that gate, is what
 * makes the guard's absence something a test can actually catch. See `EnvTab.test.tsx`.
 */
export function nextRawState(
  rawLoaded: boolean,
  saved: { content: string; hash: string },
): { rawText: string; rawBaseline: string; rawHash: string } | null {
  if (!rawLoaded) return null;
  return { rawText: saved.content, rawBaseline: saved.content, rawHash: saved.hash };
}

/** A `.env` key: a letter or underscore, then any run of letters, digits or underscores. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The last-occurrence value of `key`, or `undefined` if it is not present at all. */
function currentValueOf(entries: EnvEntry[], key: string): string | undefined {
  return entries.findLast(
    (e): e is Extract<EnvEntry, { kind: "pair" }> => e.kind === "pair" && e.key === key,
  )?.value;
}

/**
 * The edit page's `.env` tab: a masked key/value table with reveal-per-row, plus a raw
 * mode for bulk paste.
 *
 * The rule that shapes everything below: this table edits *entries*, not text. `.env`
 * files are hand-maintained over SSH and their comments carry real information —
 * `upsertEnv`'s own docstring records the measured reason it exists, that rebuilding a
 * file from key/value pairs "would make editing one variable destroy the note explaining
 * why it is set". So a table save here never rebuilds the file, and — since this task —
 * never even fetches it: `handleSave`'s non-raw branch sends `PUT .../env` a `changes`
 * list (`{ key, value }`, `value: null` for a delete) guarded by the hash the table's own
 * `GET` already returned, and the ROUTE applies each change through `upsertEnv`/
 * `removeEnv` against its own read of the file — see `apps.ts`. Every untouched line
 * still survives byte-identical, the same guarantee `ComposeTab`'s hash dance gives
 * compose.yaml, but now the rest of the file never has to leave the server to get there.
 *
 * Secrets are handled the way Task 2's server half was built for: a row's value is never
 * fetched until its own "Reveal" is clicked, and each reveal names its key in the
 * request — never a whole-file fetch filtered client-side, which would put every secret
 * in the browser to display one. Raw mode is one deliberate exception: bulk paste needs
 * the real text, so switching to it fetches the whole file once, through the same
 * `app:secrets`-gated endpoint — and, per the standard this phase holds to (the browser
 * must never hold a secret it is not displaying), that fetch is a plain, uncached
 * `apiFetch`: a second raw-mode open re-asks the server rather than serving a query-cache
 * hit, and leaving raw mode without an unsaved edit drops the text this tab was holding
 * rather than keeping it around for the rest of the session. See `loadRaw` and the mode
 * toggle's own comment.
 *
 * A table-mode save used to be the OTHER exception, and unlike raw mode's, not a
 * deliberate one: `handleSave`'s non-raw branch called `fetchWhole` to get a full copy to
 * run `upsertEnv` against in the browser, so every secret in the file transited the
 * browser on every save, not just the row(s) actually being changed. 1F's final fix wave
 * declined to make that contract change to the file holding credentials under time
 * pressure, and did the smaller, safe half instead — the audit log recorded
 * `detail: { scope: "all", reason: "save-merge" }` on the fetch so it read differently
 * from a deliberate Raw-mode dump, even though the transfer itself was unchanged. This
 * task is that deferred fix: the non-raw branch now sends `changes` instead, and the
 * fetch — and the audit line it produced on every routine save — is gone. `save-merge`
 * still fires, just far less often: only from `openConflict`'s own best-effort disk copy
 * on an actual 409, which genuinely needs the full text to show a comparison or to
 * compute what a structural edit's retry would produce (see `handleSave`'s 409 branches).
 * The guard in `onSaveSuccess` below (`content !== null` before calling `nextRawState`)
 * still matters for exactly that path: a 409 recovery is one of the few remaining
 * situations where this component holds real file text without raw mode being open, and
 * it must not leak into durable state either.
 *
 * `PUT .../env` carries the same hash guard `ComposeTab` uses and can answer the same
 * 409 — and `.env` is the file that holds secrets, so an SSH edit clobbered here is worse
 * than one in compose. Table edits get the gentler of two responses, but only when it is
 * actually safe: since they only ever change specific keys via `upsertEnv`, a 409 there
 * is handled by refetching the file and reapplying those same key edits onto whatever is
 * on disk now — *for every key the concurrent edit left alone*. A key the concurrent
 * edit also touched, or deleted outright, does not get silently resolved that way: doing
 * so would let this tab's older value quietly win, which for a secrets file is exactly
 * the credential-rotation-reversion the hash guard exists to prevent. Those keys stop and
 * ask instead, via `KeyConflict` — see `handleSave`'s retry branch and
 * `handleResolveKeyConflict`. A raw-mode edit cannot be merged like that at all — it is
 * arbitrary free-form text, not a set of named key changes — so it gets exactly
 * `ComposeTab`'s explicit, two-choice conflict UI instead: load the disk version, or keep
 * mine and overwrite it deliberately. See `handleUseDiskVersion` and
 * `handleKeepMineOverwrite`.
 *
 * Adding and deleting a key both live in the table too (`handleAddVariable`,
 * `handleDeleteKey`) — without them, adding `TZ=Europe/London` had no route but Raw,
 * which fetches and displays every secret in the file for what should be the most
 * routine `.env` edit there is. Deleting needs no reveal first: `removeEnv` only needs
 * the key's name. Neither gets the same fine-grained "merge everything but the keys that
 * actually conflict" treatment a plain value edit gets on a 409, though — `addedKeys`/
 * `deletedKeys` route a save carrying either straight to the same explicit whole-file
 * conflict UI raw mode uses (see `hasStructuralEdits` in `handleSave`). A rename can
 * always merge safely against whatever the concurrent edit left alone; whether an add or
 * delete can is a judgement call about intent this tab does not try to make silently.
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
  // The value each edited key was revealed as, captured the moment `handleReveal`
  // succeeds — before the user has typed anything. A row only ever becomes editable
  // after its own reveal (see the table's `value !== undefined` gate below), so every
  // key in `edits` is guaranteed to have one of these. It is what `handleSave`'s retry
  // compares the fresh file against to tell "nobody touched this key" from "someone
  // else's edit landed on it too" — see the Important findings this exists to fix.
  const [editBaselines, setEditBaselines] = useState<Record<string, string>>({});
  // Revealed values, keyed by row INDEX rather than key: two rows can share a key (see
  // the "shadowed" note below), and each reveals independently even though both would
  // return the same value.
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [revealErrors, setRevealErrors] = useState<Record<number, string>>({});

  // Keys added or marked for deletion in this table since the last save. Both route a
  // 409 straight to the whole-file conflict UI rather than the granular per-key merge a
  // plain rename gets — see the module doc comment's note on `hasStructuralEdits`. An
  // added key also gets a real entry in `edits` (its typed value); `addedKeys` only
  // exists to say "and that key is new," which `edits` alone cannot.
  const [addedKeys, setAddedKeys] = useState<ReadonlySet<string>>(new Set());
  const [deletedKeys, setDeletedKeys] = useState<ReadonlySet<string>>(new Set());
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmingUseDisk, setConfirmingUseDisk] = useState(false);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);
  const [keyConflict, setKeyConflict] = useState<KeyConflict | null>(null);
  const [keyResolutions, setKeyResolutions] = useState<Record<string, "mine" | "theirs">>({});

  // Raw mode's own copy of the file. Unlike `ComposeTab`'s `text` (which the query
  // underneath is allowed to go stale relative to, forever, once seeded), this is
  // deliberately NOT backed by `useQuery`: re-fetching this is another whole-file secret
  // reveal, audited every time on the server, and TanStack's own cache would otherwise
  // keep every secret in `content` retrievable via `queryClient.getQueryData` for its
  // `gcTime` (~5 minutes by default) after the tab stopped showing it. `loadRaw` below is
  // a plain `apiFetch` instead — there is nothing here worth caching, and every load
  // should count as someone looking again.
  const [rawText, setRawText] = useState("");
  const [rawBaseline, setRawBaseline] = useState<string | null>(null);
  const [rawHash, setRawHash] = useState<string | null>(null);
  const [rawLoaded, setRawLoaded] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<unknown>(null);

  // Guards every raw-fetch `.then`/`.catch` below: once this tab unmounts (navigating to
  // another app or another tab), a reveal that was still in flight must not land a real
  // secret into a component instance nothing will ever render again.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const fetchWhole = useCallback(
    (reason: RevealAllReason): Promise<RevealAll> => {
      return apiFetch<RevealAll>(`/api/apps/${appId}/env/reveal`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
    },
    [appId],
  );

  const loadRaw = useCallback(async () => {
    setRawLoading(true);
    setRawError(null);
    try {
      const data = await fetchWhole("raw-edit");
      if (!mountedRef.current) return;
      setRawText(data.content);
      setRawBaseline(data.content);
      setRawHash(data.hash);
      setRawLoaded(true);
    } catch (error) {
      if (!mountedRef.current) return;
      setRawError(error);
    } finally {
      if (mountedRef.current) setRawLoading(false);
    }
  }, [fetchWhole]);

  useEffect(() => {
    if (mode !== "raw" || rawLoaded || rawLoading) return;
    void loadRaw();
  }, [mode, rawLoaded, rawLoading, loadRaw]);

  const rawDirty = rawBaseline !== null && rawText !== rawBaseline;
  // A deletion needs no value edit to be worth saving — `removeEnv` only needs the key's
  // name, so `deletedKeys` can be non-empty while `edits` stays untouched.
  const dirty = Object.keys(edits).length > 0 || rawDirty || deletedKeys.size > 0;

  /**
   * The Table/Raw toggle. Leaving raw mode with nothing unsaved is the moment this tab
   * stops needing the real file text at all, so that is exactly when it drops it —
   * clearing `rawLoaded` is what makes the *next* switch back to Raw ask the server
   * again instead of silently reusing what's still sitting in state. An unsaved raw
   * edit is the one exception: it is the user's own in-progress work, not a passively
   * held secret, and dropping it here would silently discard typing the same way a
   * background refetch must never be allowed to (see `handleSave`'s own comment on
   * this) — so it survives the switch, same as before, and the table reflects it (see
   * `entries` below).
   */
  function switchMode(next: "table" | "raw") {
    if (mode === "raw" && next === "table" && !rawDirty) {
      setRawText("");
      setRawBaseline(null);
      setRawHash(null);
      setRawLoaded(false);
      setRawError(null);
    }
    setMode(next);
  }

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
      setEditBaselines((prev) => ({ ...prev, [key]: data.value }));
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
    // Deletions apply after value edits: the table never lets a key be both edited and
    // marked for deletion at once (see `handleDeleteKey`), but applying them last keeps
    // that guarantee true even if it ever stopped being enforced at the UI layer.
    for (const key of deletedKeys) {
      entries = removeEnv(entries, key);
    }
    return serialiseEnv(entries);
  }

  function putEnv(content: string, expectedHash: string | null): Promise<{ hash: string }> {
    return apiFetch<{ hash: string }>(`/api/apps/${appId}/env`, {
      method: "PUT",
      body: JSON.stringify({ content, expectedHash }),
    });
  }

  /**
   * The routine save path: sends only the keys this tab actually touched, guarded by the
   * hash the table's own `GET` already returned. No whole-file fetch precedes this — the
   * point of this task — and the server applies each change through `upsertEnv`/
   * `removeEnv` itself, against its own read of the file.
   */
  function putEnvChanges(
    changes: Array<{ key: string; value: string | null }>,
    expectedHash: string | null,
  ): Promise<{ hash: string }> {
    return apiFetch<{ hash: string }>(`/api/apps/${appId}/env`, {
      method: "PUT",
      body: JSON.stringify({ changes, expectedHash }),
    });
  }

  /** Every pending table edit and deletion, as the `changes` list `putEnvChanges` sends. */
  function buildChanges(): Array<{ key: string; value: string | null }> {
    const changes: Array<{ key: string; value: string | null }> = Object.entries(edits).map(
      ([key, value]) => ({ key, value }),
    );
    for (const key of deletedKeys) {
      changes.push({ key, value: null });
    }
    return changes;
  }

  /**
   * `content` is `null` for a `changes`-mode save: it never held the whole file to begin
   * with, so there is nothing here to fold into `rawText`. `nextRawState` itself already
   * refuses to resume tracking when raw mode did not produce the save — this guard is
   * what keeps a save that has no full text at all from even reaching that check with a
   * fabricated one.
   */
  function onSaveSuccess(content: string | null, hash: string) {
    setEdits({});
    setEditBaselines({});
    setRevealed({});
    setRevealErrors({});
    setConflict(null);
    setKeyConflict(null);
    setKeyResolutions({});
    setAddedKeys(new Set());
    setDeletedKeys(new Set());
    const nextRaw = content !== null ? nextRawState(rawLoaded, { content, hash }) : null;
    if (nextRaw) {
      setRawText(nextRaw.rawText);
      setRawBaseline(nextRaw.rawBaseline);
      setRawHash(nextRaw.rawHash);
    }
    void queryClient.invalidateQueries({ queryKey: envKey(appId) });
  }

  // Fetches the disk copy to show alongside the conflict, best-effort exactly like
  // `ComposeTab`'s own conflict handler: if this fails, the banner still explains what
  // happened, it just can't offer the disk text to compare against or load. The write
  // itself already failed safely either way.
  //
  // `mine` is either the merged content already known at the moment of conflict (raw
  // mode, and a second failure on the per-key retry, both of which already had a full
  // copy in hand) or a function of the disk copy this fetch is about to make (a plain
  // table save's own first conflict, which never fetched anything up front — see the
  // module doc comment). The banner still appears immediately either way; only the
  // deferred case waits for this fetch to fill in a real value.
  async function openConflict(error: unknown, mine: string | ((diskContent: string) => string)) {
    setConflict({
      kind: conflictKindFrom(error),
      message: messageFrom(error, "The file changed on disk since you loaded it."),
      disk: null,
      mine: typeof mine === "string" ? mine : "",
    });
    try {
      // Always in service of a save that just got refused — never a deliberate raw-mode
      // reveal, even when what triggered the conflict was raw mode's own dirty text.
      const disk = await fetchWhole("save-merge");
      setConflict((prev) => {
        if (!prev) return prev;
        return { ...prev, disk, mine: typeof mine === "function" ? mine(disk.content) : prev.mine };
      });
    } catch {
      // Best effort — see the comment above.
    }
  }

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      // Two ways to make the initial attempt. Raw mode already holds real, arbitrary
      // whole-file text — there is nothing here a named `changes` list could represent,
      // so it sends the merged text same as before, and `knownMine` captures that text
      // up front for reuse if this attempt gets refused. A pure table edit has no whole
      // file in hand at all: it sends only the keys this tab actually touched, guarded
      // by the hash its own `GET` already returned, and never fetches the rest of the
      // file to get there — the point of this task.
      let knownMine: string | null;
      let attempt: () => Promise<{ hash: string }>;
      if (rawLoaded) {
        // Table edits apply on top of the raw text exactly as they would on top of a
        // fresh fetch, so a raw-mode edit is never silently dropped by a save triggered
        // after switching back to the table view.
        knownMine = applyEdits(rawText);
        attempt = () => putEnv(knownMine as string, rawHash);
      } else {
        knownMine = null;
        const changes = buildChanges();
        const expectedHash = envQuery.data?.hash ?? null;
        attempt = () => putEnvChanges(changes, expectedHash);
      }

      try {
        const result = await attempt();
        onSaveSuccess(knownMine, result.hash);
        return;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) {
          setSaveError(messageFrom(error, "Could not save the .env file."));
          return;
        }

        // Structural changes — an added or deleted key — get the same explicit,
        // whole-file conflict raw edits get, same as `rawDirty` below: whether adding a
        // key that showed up concurrently, or deleting one a concurrent edit also
        // touched, is safe to resolve silently is a judgement call about intent, not a
        // value comparison `upsertEnv` can make the way it can for a plain rename.
        const hasStructuralEdits = addedKeys.size > 0 || deletedKeys.size > 0;
        if (rawDirty || hasStructuralEdits) {
          // `knownMine` is already the right answer whenever this attempt had a whole
          // file to build it from (raw mode). A pure table save never did — see the
          // module doc comment — so `openConflict` is given a function of the disk copy
          // it is about to fetch instead of an already-known string.
          if (knownMine !== null) {
            await openConflict(error, knownMine);
          } else {
            await openConflict(error, (diskContent) => applyEdits(diskContent));
          }
          return;
        }

        // A table edit only ever changes specific keys, so a 409 here does not
        // automatically need the user to adjudicate anything: refetch, then check each
        // key this tab actually touched against the fresh copy. A key the concurrent
        // edit left alone merges silently underneath, same as `upsertEnv` already
        // guarantees for untouched LINES within one save. A key the concurrent edit
        // also changed, or deleted, does not — see the module doc comment.
        try {
          const fresh = await fetchWhole("save-merge");
          const freshEntries = parseEnv(fresh.content);

          const conflicts: KeyConflictEntry[] = [];
          const safeEdits: Record<string, string> = {};
          for (const [key, mine] of Object.entries(edits)) {
            const theirs = currentValueOf(freshEntries, key);
            const baseline = editBaselines[key];
            if (theirs === undefined) {
              // Gone from the fresh file. `upsertEnv`'s `findLastIndex` would return -1
              // here and silently APPEND the key again, quietly undoing whatever just
              // deleted it — never safe to do without asking, regardless of value.
              conflicts.push({ key, mine, theirs: null });
            } else if (baseline !== undefined && theirs !== baseline) {
              // Someone else's edit landed on the exact key this tab also touched.
              // Applying the browser's older value here would silently revert
              // whatever they just set — for a secrets file, very often a credential
              // rotation being undone, which is the one thing the hash guard exists
              // to prevent.
              conflicts.push({ key, mine, theirs });
            } else {
              safeEdits[key] = mine;
            }
          }

          if (conflicts.length > 0) {
            let safeEntries = freshEntries;
            for (const [key, value] of Object.entries(safeEdits)) {
              safeEntries = upsertEnv(safeEntries, key, value);
            }
            setKeyConflict({
              entries: conflicts,
              safeContent: serialiseEnv(safeEntries),
              freshHash: fresh.hash,
            });
            return;
          }

          const retryContent = applyEdits(fresh.content);
          try {
            const result = await putEnv(retryContent, fresh.hash);
            onSaveSuccess(retryContent, result.hash);
          } catch (retryPutError) {
            if (retryPutError instanceof ApiError && retryPutError.status === 409) {
              // A second concurrent write landed between the retry's own fetch and its
              // own PUT. Rare enough, and `retryContent` (this tab's own retried merge)
              // is still a better "mine" than nothing — falls back to the same explicit
              // whole-file choice raw edits get.
              await openConflict(retryPutError, retryContent);
            } else {
              setSaveError(messageFrom(retryPutError, "Could not save the .env file."));
            }
          }
        } catch (fetchError) {
          // The retry's own fetch failed outright — e.g. (see the Minor finding from
          // 1F) `env_unreadable`, a permissions problem no concurrent edit caused,
          // rather than a second stale hash. There is no known "mine" yet in this case;
          // `openConflict`'s own best-effort fetch fills one in if it happens to succeed
          // where this one didn't.
          if (fetchError instanceof ApiError && fetchError.status === 409) {
            await openConflict(fetchError, (diskContent) => applyEdits(diskContent));
          } else {
            setSaveError(messageFrom(fetchError, "Could not save the .env file."));
          }
        }
      }
    } finally {
      setSaving(false);
    }
  }

  function chooseKeyResolution(key: string, resolution: "mine" | "theirs") {
    setKeyResolutions((prev) => ({ ...prev, [key]: resolution }));
  }

  function handleCancelKeyConflict() {
    setKeyConflict(null);
    setKeyResolutions({});
  }

  const keyConflictReady = Boolean(
    keyConflict?.entries.every((entry) => keyResolutions[entry.key] !== undefined),
  );

  async function handleResolveKeyConflict() {
    if (!keyConflict) return;
    let entries = parseEnv(keyConflict.safeContent);
    for (const entry of keyConflict.entries) {
      if (keyResolutions[entry.key] === "mine") {
        entries = upsertEnv(entries, entry.key, entry.mine);
      }
      // "theirs" needs no action: `safeContent` was built from the fresh file, so it
      // already carries whatever is actually there now — the changed value, or the
      // key's continued absence if it was deleted.
    }
    const finalContent = serialiseEnv(entries);
    setSaveError(null);
    setSaving(true);
    try {
      const result = await putEnv(finalContent, keyConflict.freshHash);
      onSaveSuccess(finalContent, result.hash);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Yet another concurrent write landed between this resolution and its own PUT.
        // Rare enough that looping the per-key dialog again is not worth it — falls
        // back to the same whole-file choice raw edits get.
        await openConflict(error, finalContent);
        setKeyConflict(null);
        setKeyResolutions({});
      } else {
        setSaveError(messageFrom(error, "Could not save the .env file."));
      }
    } finally {
      setSaving(false);
    }
  }

  function handleUseDiskVersion() {
    const disk = conflict?.disk;
    if (!disk) return;
    setRawText(disk.content);
    setRawBaseline(disk.content);
    setRawHash(disk.hash);
    setRawLoaded(true);
    setConflict(null);
    // The confirm dialog promises "what you've typed here will be gone" — so every piece
    // of pending table state has to go too, not just the conflict banner. Leaving any of
    // these behind would let it silently reapply on top of the disk content the user just
    // chose to adopt: a stale `edits` entry rewrites a key on the next save, a leftover
    // `deletedKeys` entry removes one that was never actually deleted here, and a pending
    // `addedKeys` entry reinserts something that no longer belongs. This was the Critical
    // finding: a pending delete on this table survived a "load the disk version" and the
    // next save carried it out anyway, deleting a credential from the file the user had
    // just told this tab to treat as authoritative.
    setEdits({});
    setEditBaselines({});
    setAddedKeys(new Set());
    setDeletedKeys(new Set());
    setRevealed({});
    setRevealErrors({});
    setKeyConflict(null);
    setKeyResolutions({});
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
  const existingKeys = new Set(entries.map((entry) => entry.key));
  // Added keys not yet reflected in `entries` — true for every one of them until a save
  // actually lands, since `entries` only ever comes from the last `GET`/raw fetch.
  const pendingNewKeys = [...addedKeys].filter((key) => !existingKeys.has(key));

  function handleAddVariable() {
    const key = newKey.trim();
    setAddError(null);
    if (!key) {
      setAddError("Enter a name for the new variable.");
      return;
    }
    if (!ENV_NAME_PATTERN.test(key)) {
      setAddError(
        "A variable name must start with a letter or underscore, and contain only letters, digits and underscores.",
      );
      return;
    }
    if (!deletedKeys.has(key) && (existingKeys.has(key) || key in edits)) {
      setAddError(`${key} already exists in this file.`);
      return;
    }
    // Re-adding a key that was marked for deletion just cancels the deletion — no
    // reason to create a second, competing edit for the same name.
    setDeletedKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setEdits((prev) => ({ ...prev, [key]: newValue }));
    setAddedKeys((prev) => new Set(prev).add(key));
    setNewKey("");
    setNewValue("");
  }

  function handleDeleteKey(key: string) {
    if (addedKeys.has(key)) {
      // Never saved anywhere yet — deleting a still-pending addition just un-adds it,
      // rather than asking `removeEnv` to remove a key that was never written.
      setAddedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setEdits((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    setDeletedKeys((prev) => new Set(prev).add(key));
    // A pending edit to a key that's about to be deleted would otherwise still apply
    // (via `upsertEnv`) before the deletion runs — clearing it keeps "delete" the one
    // thing that happens to this key on save.
    setEdits((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleUndoDelete(key: string) {
    setDeletedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2" role="tablist" aria-label="View">
        <button
          type="button"
          onClick={() => switchMode("table")}
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
          onClick={() => switchMode("raw")}
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
          <p className="font-medium">
            {conflict.kind === "env_unreadable"
              ? "This app's .env file cannot be read right now."
              : "Someone changed this file since you loaded it."}
          </p>
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

      {keyConflict && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">
            {keyConflict.entries.length === 1
              ? "Someone else changed this variable while you were editing it."
              : "Someone else changed some of these variables while you were editing them."}
          </p>
          <p className="mt-1">
            Every other change you made still merges automatically. Only the keys below need your
            decision — applying your value underneath could silently undo theirs.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {keyConflict.entries.map((entry) => (
              <li
                key={entry.key}
                className="rounded-lg border border-amber-200 p-2 dark:border-amber-900"
              >
                <p className="font-mono text-xs font-medium">{entry.key}</p>
                <p className="mt-1 text-xs">
                  {entry.theirs === null
                    ? "Removed on disk while you were editing it."
                    : "Changed on disk while you were editing it."}
                </p>
                <div className="mt-2 flex flex-col gap-1 text-xs">
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`resolve-${entry.key}`}
                      checked={keyResolutions[entry.key] === "mine"}
                      onChange={() => chooseKeyResolution(entry.key, "mine")}
                    />
                    Keep mine: {entry.mine}
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`resolve-${entry.key}`}
                      checked={keyResolutions[entry.key] === "theirs"}
                      onChange={() => chooseKeyResolution(entry.key, "theirs")}
                    />
                    {entry.theirs === null ? "Accept the removal" : `Keep theirs: ${entry.theirs}`}
                  </label>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleCancelKeyConflict}
              className="rounded-lg border border-amber-400 px-2 py-1 text-xs font-medium dark:border-amber-700"
            >
              Keep editing my version
            </button>
            <button
              type="button"
              disabled={!keyConflictReady || saving}
              onClick={handleResolveKeyConflict}
              className="rounded-lg border border-rose-400 px-2 py-1 text-xs font-medium text-rose-700 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300"
            >
              {saving ? "Saving…" : "Save with these choices"}
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

      {mode === "table" && (
        <>
          {entries.length === 0 && pendingNewKeys.length === 0 ? (
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
                  const isDeleted = deletedKeys.has(entry.key);
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
                        {shadowed && !isDeleted && (
                          <p className="mt-1 max-w-[16rem] text-xs font-normal italic text-amber-600 dark:text-amber-400">
                            Set again below — that later line is the one compose reads.
                          </p>
                        )}
                      </td>
                      <td className="py-2 align-top">
                        {isDeleted ? (
                          <p className="text-xs italic text-rose-600 dark:text-rose-400">
                            Will be removed on save.
                          </p>
                        ) : value !== undefined ? (
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
                        {!isDeleted && revealErrors[index] && (
                          <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                            {revealErrors[index]}
                          </p>
                        )}
                      </td>
                      <td className="py-2 pl-3 align-top">
                        {isDeleted ? (
                          <button
                            type="button"
                            onClick={() => handleUndoDelete(entry.key)}
                            className="rounded-lg border border-slate-200 px-2 py-1 text-xs dark:border-slate-800"
                          >
                            Undo delete
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleDeleteKey(entry.key)}
                            className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-rose-700 dark:border-slate-800 dark:text-rose-300"
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {pendingNewKeys.map((key) => (
                  <tr
                    key={`new-${key}`}
                    className="border-t border-slate-200 dark:border-slate-800"
                  >
                    <td className="py-2 pr-3 align-top font-mono text-xs text-slate-900 dark:text-slate-100">
                      {key}
                      <p className="mt-1 text-xs font-normal italic text-emerald-600 dark:text-emerald-400">
                        New — will be added on save.
                      </p>
                    </td>
                    <td className="py-2 align-top">
                      <input
                        type="text"
                        value={edits[key] ?? ""}
                        onChange={(event) =>
                          setEdits((prev) => ({ ...prev, [key]: event.target.value }))
                        }
                        aria-label={`${key} value`}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 font-mono text-xs dark:border-slate-800 dark:bg-slate-950"
                      />
                    </td>
                    <td className="py-2 pl-3 align-top">
                      <button
                        type="button"
                        onClick={() => handleDeleteKey(key)}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-rose-700 dark:border-slate-800 dark:text-rose-300"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
            <div className="flex flex-col gap-1">
              <label htmlFor="env-new-key" className="text-xs text-slate-500 dark:text-slate-400">
                New variable name
              </label>
              <input
                id="env-new-key"
                type="text"
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
                placeholder="TZ"
                className="rounded-lg border border-slate-200 px-2 py-1 font-mono text-xs dark:border-slate-800 dark:bg-slate-950"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="env-new-value" className="text-xs text-slate-500 dark:text-slate-400">
                Value
              </label>
              <input
                id="env-new-value"
                type="text"
                value={newValue}
                onChange={(event) => setNewValue(event.target.value)}
                placeholder="Europe/London"
                className="rounded-lg border border-slate-200 px-2 py-1 font-mono text-xs dark:border-slate-800 dark:bg-slate-950"
              />
            </div>
            <button
              type="button"
              onClick={handleAddVariable}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs dark:border-slate-800"
            >
              Add variable
            </button>
            {addError && (
              <p role="alert" className="w-full text-xs text-rose-600 dark:text-rose-400">
                {addError}
              </p>
            )}
          </div>
        </>
      )}

      {mode === "raw" &&
        (rawLoaded ? (
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            spellCheck={false}
            aria-label=".env file contents"
            className="min-h-64 w-full rounded-2xl border border-slate-200 p-3 font-mono text-xs dark:border-slate-800 dark:bg-slate-950"
          />
        ) : rawError ? (
          <p className="p-4 text-sm text-rose-600 dark:text-rose-400">
            {loadErrorMessage(rawError)}
          </p>
        ) : (
          <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Loading the whole file…</p>
        ))}

      <div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving || keyConflict !== null}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
