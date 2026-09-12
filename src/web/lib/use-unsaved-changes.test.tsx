// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUnsavedChanges } from "@web/lib/use-unsaved-changes";
import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

/**
 * Tests the hook directly against a real data router rather than through `ComposeTab` and
 * `EnvTab` — this project's carry-forwards say repeatedly that a guard which cannot be
 * mutation-tested through its component should move somewhere it can be, and duplicating
 * every case below in both editors' own test files would just be the same guard tested
 * twice with extra CodeMirror/table-rendering ceremony around it.
 *
 * `useBlocker` throws outside a data router, so this needs `createMemoryRouter` +
 * `RouterProvider` — a plain `MemoryRouter`/`Routes` tree (what `ComposeTab.test.tsx` and
 * `EnvTab.test.tsx` used before Task 4) has no `DataRouterContext` for it to read.
 *
 * `Harness` keeps its own `dirty` state (seeded from a prop) rather than the test handing
 * a fixed boolean straight to the hook, because one case below — a save resolving while
 * the confirm dialog is open — needs to flip `dirty` on an already-mounted instance
 * without remounting it (a remount would trivially "release" any hook by throwing away
 * its state, proving nothing). `onApi` hands the test a live setter to do that flip
 * through, the same shape `EnvTab`'s own `mountedRef` pattern uses to reach into a
 * component from outside without lifting state the component doesn't otherwise need.
 */
function Harness({
  initialDirty,
  onApi,
}: {
  initialDirty: boolean;
  onApi: (api: { setDirty: (next: boolean) => void }) => void;
}) {
  const [dirty, setDirty] = useState(initialDirty);
  // `onApi` is a fresh closure per test, not a stable dependency — this only ever needs to
  // register once, on mount, same rationale as `ComposeTab`'s own once-per-mount refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-once, see above.
  useEffect(() => {
    onApi({ setDirty });
  }, []);
  const { blocked, proceed, cancel } = useUnsavedChanges(dirty);
  return (
    <div>
      <p data-testid="blocked">{String(blocked)}</p>
      <button type="button" onClick={proceed}>
        proceed
      </button>
      <button type="button" onClick={cancel}>
        cancel
      </button>
    </div>
  );
}

function setup(initialDirty: boolean) {
  let api: { setDirty: (next: boolean) => void } = {
    setDirty: () => {
      throw new Error("Harness has not mounted yet");
    },
  };
  const router = createMemoryRouter(
    [
      {
        path: "/a",
        element: <Harness initialDirty={initialDirty} onApi={(next) => (api = next)} />,
      },
      { path: "/b", element: <p>elsewhere</p> },
    ],
    { initialEntries: ["/a"] },
  );
  render(<RouterProvider router={router} />);
  return {
    router,
    // Awaited: `router.navigate` resolves once the (here, loader-free) navigation has
    // actually settled, which for a blocked navigation means "the blocker state is
    // updated" rather than "the location changed" — either way, letting it settle before
    // the next assertion is what keeps this from racing the router's own internals.
    navigateAway: () => act(() => router.navigate("/b")),
    setDirty: (next: boolean) => act(() => api.setDirty(next)),
  };
}

describe("useUnsavedChanges", () => {
  it("does not block navigation when clean", async () => {
    const { navigateAway, router } = setup(false);

    await navigateAway();

    expect(router.state.location.pathname).toBe("/b");
    expect(screen.getByText("elsewhere")).toBeTruthy();
  });

  it("blocks navigation when dirty", async () => {
    const { navigateAway, router } = setup(true);

    await navigateAway();

    expect(router.state.location.pathname).toBe("/a");
    expect(screen.getByTestId("blocked").textContent).toBe("true");
  });

  it("proceed lets the blocked navigation through", async () => {
    const { navigateAway, router } = setup(true);
    await navigateAway();
    expect(screen.getByTestId("blocked").textContent).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByText("proceed"));
    });

    expect(router.state.location.pathname).toBe("/b");
    expect(screen.getByText("elsewhere")).toBeTruthy();
  });

  it("cancel leaves the navigation blocked and the user where they were", async () => {
    const { navigateAway, router } = setup(true);
    await navigateAway();
    expect(screen.getByTestId("blocked").textContent).toBe("true");

    act(() => fireEvent.click(screen.getByText("cancel")));

    expect(router.state.location.pathname).toBe("/a");
    expect(screen.getByTestId("blocked").textContent).toBe("false");
  });

  it("releases the block on its own once the dirty state clears mid-dialog", async () => {
    // The case that bites: a save resolves while the confirm dialog is open. The user
    // must not be left stuck looking at a prompt for changes that no longer exist.
    const { navigateAway, setDirty, router } = setup(true);
    await navigateAway();
    expect(screen.getByTestId("blocked").textContent).toBe("true");

    setDirty(false);

    expect(screen.getByTestId("blocked").textContent).toBe("false");
    // Lifting the block is not the same as completing the navigation it was blocking —
    // the user is freed to navigate again, not swept away without having clicked anything.
    expect(router.state.location.pathname).toBe("/a");
  });

  it("does not warn on beforeunload while clean", () => {
    setup(false);

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("warns on beforeunload while dirty, via the ref the listener reads on every dispatch", () => {
    setup(true);

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
