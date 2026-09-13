import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

/**
 * One hook for both ways an editor's unsaved work can vanish out from under it: an
 * in-app navigation (a tab click, a `Link`, the back button) via `useBlocker` — which
 * only sees navigations the data router itself performs — and leaving the page entirely
 * (closing the tab, a reload, typing a new URL) via `beforeunload`, which no router can
 * see or block at all. A caller declares `dirty` once and gets both, rather than the
 * mismatched coverage this replaces: `ComposeTab` used to wire `beforeunload` alone, and
 * `EnvTab` — which edits credentials — wired nothing.
 *
 * `onDirtyChange`, when given, is `ConfigTab`'s doing: `ComposeTab` and `EnvTab` render
 * side by side there, each still calling this same hook (so each still works standalone,
 * the way their own test files render them), but only ONE of them may actually engage
 * react-router's blocker. Measured directly against react-router 7.18.3 before writing
 * this: two components each calling `useBlocker(true)` under the same router does not
 * queue or merge them — the second registration logs "A router only supports one blocker
 * at a time" and silently steals the block, leaving the FIRST caller's own `blocker.state`
 * stuck reporting "unblocked" even though it is still genuinely dirty. That is worse than
 * losing the dialog: it is a caller confidently telling the truth-teller the wrong thing.
 * So a parented caller (one that got an `onDirtyChange`) never calls `useBlocker` with a
 * truthy `shouldBlock` at all — passing `false` unconditionally keeps Rules of Hooks
 * intact whether or not `onDirtyChange` is present, while guaranteeing it can never be the
 * one that wins or loses that race. `ConfigTab` is the sole caller that blocks, from
 * `composeDirty || envDirty`, and is the sole one that ever shows the "leave without
 * saving?" dialog while parented.
 */
export function useUnsavedChanges(
  dirty: boolean,
  options?: { onDirtyChange?: (dirty: boolean) => void },
): {
  blocked: boolean;
  proceed: () => void;
  cancel: () => void;
} {
  const parented = options?.onDirtyChange !== undefined;
  const blocker = useBlocker(parented ? false : dirty);

  // Reports every `dirty` change upward, independent of `blocked`/`beforeunload` below —
  // a parent needs to know the instant a child becomes dirty, not only once that child
  // would itself have blocked. Read through a ref so this doesn't have to sit in the
  // dependency array below and fire on every render where the caller passed a fresh
  // closure (which `ConfigTab` does not do, but nothing here should rely on that).
  const onDirtyChangeRef = useRef(options?.onDirtyChange);
  onDirtyChangeRef.current = options?.onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // The case that bites: an in-flight save can resolve — clearing `dirty` — while this
  // tab's own confirm dialog is still open over a navigation `useBlocker` already
  // blocked. `useBlocker` never revisits a navigation once it has blocked: react-router's
  // own `updateBlocker` only transitions `blocked -> proceeding` or `blocked ->
  // unblocked` in response to an explicit `proceed()`/`reset()` call, never because
  // `shouldBlock` changed underneath it. Without this effect, the user would be stuck
  // looking at a "discard changes?" prompt for changes that no longer exist — the block
  // has to lift on its own the instant there is nothing left to lose, rather than
  // trapping them behind a dialog about a save that already succeeded. Moot while
  // parented (`blocker.state` can never become `"blocked"` there), but harmless to leave
  // running unconditionally rather than adding a branch that only matters in one mode.
  useEffect(() => {
    if (!dirty && blocker.state === "blocked") {
      blocker.reset();
    }
  }, [dirty, blocker]);

  // A ref, read from a `beforeunload` listener installed once on mount. Rebuilding the
  // listener on every keystroke (the naive `[dirty]` dependency) would work too, but this
  // way there is exactly one add/remove pair for the component's whole lifetime — the
  // same tradeoff `ComposeTab` originally made this hook now makes on every caller's
  // behalf.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // A parented caller's own `beforeunload` warning would be redundant, not wrong — the
  // parent's own `useUnsavedChanges(composeDirty || envDirty)` call already covers
  // closing the tab entirely — but redundant listeners are still a second thing to reason
  // about for no benefit, so this is gated the same way the blocker itself is.
  const parentedRef = useRef(parented);
  parentedRef.current = parented;
  useEffect(() => {
    function handler(event: BeforeUnloadEvent) {
      if (parentedRef.current) return;
      if (!dirtyRef.current) return;
      // Both lines are set because browser engines have historically disagreed on which
      // one actually triggers the "leave site?" prompt: some only honoured
      // `preventDefault()`, others only honoured `returnValue`, and which was which
      // shifted across versions. Setting both costs one redundant assignment and removes
      // the need to track that history browser-by-browser.
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  return {
    blocked: blocker.state === "blocked",
    proceed: () => {
      if (blocker.state === "blocked") blocker.proceed();
    },
    cancel: () => {
      if (blocker.state === "blocked") blocker.reset();
    },
  };
}
