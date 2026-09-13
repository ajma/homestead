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

/**
 * `new BeforeUnloadEvent(...)` throws "Illegal constructor" in jsdom — the only way to get
 * a real instance, here or in a browser, is the legacy `document.createEvent` factory.
 * That distinction matters: jsdom's `BeforeUnloadEvent.returnValue` is typed as a DOMString
 * on the generated wrapper, but `BeforeUnloadEventImpl` never overrides it, so it actually
 * resolves to `Event`'s inherited legacy `returnValue` accessor — a boolean mirror of the
 * canceled flag, not an independent field. Reading `event.returnValue` back afterwards
 * therefore cannot show what value was assigned; it only ever reports
 * `!event.defaultPrevented`, regardless of whether the handler set it at all. So instead of
 * reading the property after the fact, this shadows the `returnValue` setter on the
 * instance and records every value passed to it, which observes that the assignment ran,
 * and with what value, independent of jsdom's (unrelated) canceled-flag bookkeeping.
 */
function createSpiedBeforeUnloadEvent(): {
  event: BeforeUnloadEvent;
  returnValueCalls: unknown[];
} {
  const event = document.createEvent("BeforeUnloadEvent");
  event.initEvent("beforeunload", false, true);
  const returnValueCalls: unknown[] = [];
  Object.defineProperty(event, "returnValue", {
    configurable: true,
    get: () => returnValueCalls.at(-1),
    set: (value: unknown) => {
      returnValueCalls.push(value);
    },
  });
  return { event, returnValueCalls };
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

    const { event, returnValueCalls } = createSpiedBeforeUnloadEvent();
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(returnValueCalls).toEqual([]);
  });

  it("warns on beforeunload while dirty, setting both preventDefault and returnValue", () => {
    setup(true);

    const { event, returnValueCalls } = createSpiedBeforeUnloadEvent();
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(returnValueCalls).toEqual([""]);
  });

  describe("parented (an `onDirtyChange` given, as `ConfigTab` does)", () => {
    // `ConfigTab` renders `ComposeTab` and `EnvTab` side by side, each still calling this
    // hook so each still works standalone (their own test files render them that way) —
    // but only `ConfigTab` itself may actually call `useBlocker` with a truthy
    // `shouldBlock`. Measured directly against react-router 7.18.3 before writing this:
    // two components each calling `useBlocker(true)` under the same router does not queue
    // or merge — the second registration logs "A router only supports one blocker at a
    // time" and silently takes over the block, leaving the FIRST caller's own
    // `blocker.state` stuck reporting "unblocked" even though it is still genuinely
    // dirty. So a parented caller must never be the one contending for that single slot.
    function ParentedHarness({
      initialDirty,
      onDirtyChange,
    }: {
      initialDirty: boolean;
      onDirtyChange: (dirty: boolean) => void;
    }) {
      const [dirty, setDirty] = useState(initialDirty);
      const { blocked } = useUnsavedChanges(dirty, { onDirtyChange });
      return (
        <div>
          <p data-testid="blocked">{String(blocked)}</p>
          <button type="button" onClick={() => setDirty(true)}>
            make dirty
          </button>
        </div>
      );
    }

    function setupParented(initialDirty: boolean) {
      const reported: boolean[] = [];
      const router = createMemoryRouter(
        [
          {
            path: "/a",
            element: (
              <ParentedHarness
                initialDirty={initialDirty}
                onDirtyChange={(dirty) => reported.push(dirty)}
              />
            ),
          },
          { path: "/b", element: <p>elsewhere</p> },
        ],
        { initialEntries: ["/a"] },
      );
      render(<RouterProvider router={router} />);
      return { router, reported, navigateAway: () => act(() => router.navigate("/b")) };
    }

    it("never blocks navigation itself, even while dirty", async () => {
      const { navigateAway, router } = setupParented(true);
      // Confirmed unblocked before the navigation too — the point isn't just that the
      // navigation eventually gets through, but that this hook never reports "blocked"
      // at all while parented.
      expect(screen.getByTestId("blocked").textContent).toBe("false");

      await navigateAway();

      // The navigation actually completed, unmounting the harness — proof this hook did
      // not intercept it, not merely that no dialog happened to be visible.
      expect(router.state.location.pathname).toBe("/b");
      expect(screen.queryByTestId("blocked")).toBeNull();
    });

    it("reports the initial dirty value upward on mount", () => {
      const { reported } = setupParented(true);
      expect(reported).toEqual([true]);
    });

    it("reports a later dirty change upward too", () => {
      const { reported } = setupParented(false);
      expect(reported).toEqual([false]);

      act(() => fireEvent.click(screen.getByText("make dirty")));

      expect(reported).toEqual([false, true]);
    });

    it("does not warn on beforeunload while dirty, since the parent's own hook call covers that", () => {
      setupParented(true);

      const { event, returnValueCalls } = createSpiedBeforeUnloadEvent();
      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(returnValueCalls).toEqual([]);
    });
  });
});
