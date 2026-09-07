import { useBlocker } from "react-router-dom";

/**
 * Router-level guard for an editor with unsaved work.
 *
 * `Edit.tsx` also calls this for the Compose ↔ `.env` switch, which the router
 * never sees: both editors live under one route, so navigating between them is
 * an in-page state change that would otherwise discard the buffer silently.
 *
 * `useBlocker` is a **data-router** hook: it reads the router object itself,
 * not just the location, so it throws under a plain `<BrowserRouter>`. That is
 * why `main.tsx` mounts `createBrowserRouter` + `RouterProvider` and every test
 * that renders an editor builds a `createMemoryRouter`. A descendant `<Routes>`
 * underneath is still blocked, because the block is installed on the one
 * history the whole tree navigates through.
 */
export function useUnsavedChanges(dirty: boolean) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  return {
    blocked: blocker.state === "blocked",
    proceed: () => blocker.proceed?.(),
    cancel: () => blocker.reset?.(),
  };
}
