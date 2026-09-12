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
 */
export function useUnsavedChanges(dirty: boolean): {
  blocked: boolean;
  proceed: () => void;
  cancel: () => void;
} {
  const blocker = useBlocker(dirty);

  // The case that bites: an in-flight save can resolve — clearing `dirty` — while this
  // tab's own confirm dialog is still open over a navigation `useBlocker` already
  // blocked. `useBlocker` never revisits a navigation once it has blocked: react-router's
  // own `updateBlocker` only transitions `blocked -> proceeding` or `blocked ->
  // unblocked` in response to an explicit `proceed()`/`reset()` call, never because
  // `shouldBlock` changed underneath it. Without this effect, the user would be stuck
  // looking at a "discard changes?" prompt for changes that no longer exist — the block
  // has to lift on its own the instant there is nothing left to lose, rather than
  // trapping them behind a dialog about a save that already succeeded.
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
  useEffect(() => {
    function handler(event: BeforeUnloadEvent) {
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
