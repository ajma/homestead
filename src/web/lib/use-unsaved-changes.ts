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
      // `preventDefault()` alone is sufficient in every currently supported browser
      // (Chrome has honoured it unaided since 119; Firefox and Safari always did) to
      // show the browser's own "leave site?" prompt — no page can customise its text.
      // This used to also set `event.returnValue` for older Chrome, which required it;
      // that line was dropped rather than kept as unverifiable belt-and-braces, since
      // under the DOM spec `returnValue`'s setter and `preventDefault()` both just set
      // the same canceled flag, so a browser new enough to need the assignment at all
      // would have to disagree with the spec to make it do anything `preventDefault()`
      // didn't already do.
      event.preventDefault();
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
