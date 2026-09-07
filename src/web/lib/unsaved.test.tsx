import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  Link,
  Route,
  RouterProvider,
  Routes,
  useLocation,
} from "react-router-dom";
import { describe, expect, it } from "vitest";
import { useUnsavedChanges } from "./useUnsavedChanges.js";

/**
 * What these tests are guarding against.
 *
 * A guard test is the easiest thing in this plan to write vacuously: render an
 * editor, click a link, assert a prompt is on screen — and pass just as
 * happily with the blocker deleted, because the prompt is only ever asserted
 * as *present*, never as *preventing* anything.
 *
 * So every assertion here is about where the user ended up. `SAVE_ME` is the
 * text of the page being left and `ELSEWHERE` the text of the destination; a
 * blocked navigation must still show the first and must **not** show the
 * second. Delete the `dirty &&` from the hook's predicate and the "blocks"
 * tests go red on the destination assertion, not on a missing banner.
 */
const SAVE_ME = "editor with unsaved work";
const ELSEWHERE = "somewhere else entirely";

/** Every `blocked` value the hook has reported, in order. */
let seen: boolean[] = [];

function Editor({ dirty }: { dirty: boolean }) {
  const guard = useUnsavedChanges(dirty);
  seen.push(guard.blocked);
  return (
    <div>
      <p>{SAVE_ME}</p>
      <Link to="/other">Leave</Link>
      {guard.blocked && (
        <div role="alertdialog" aria-label="Discard changes?">
          <button type="button" onClick={guard.proceed}>
            Discard
          </button>
          <button type="button" onClick={guard.cancel}>
            Keep editing
          </button>
        </div>
      )}
    </div>
  );
}

/** Reads the real location, so "did we move?" is answered by the router. */
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/**
 * A data router, because `useBlocker` is a data-router hook — a `MemoryRouter`
 * throws. The inner `<Routes>` is a descendant router exactly as `App.tsx`
 * mounts it, so this proves the arrangement the app actually ships.
 */
function renderEditor(dirty: boolean) {
  seen = [];
  const user = userEvent.setup();
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <Where />
            <Routes>
              <Route path="/edit" element={<Editor dirty={dirty} />} />
              <Route path="/other" element={<p>{ELSEWHERE}</p>} />
            </Routes>
          </>
        ),
      },
    ],
    { initialEntries: ["/edit"] },
  );
  render(<RouterProvider router={router} />);
  return user;
}

const leave = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("link", { name: "Leave" }));

describe("useUnsavedChanges", () => {
  it("keeps the user on the page when there is unsaved work", async () => {
    const user = renderEditor(true);
    await leave(user);

    // The destination assertion is the one that matters: a guard that renders
    // a dialog but lets the navigation through would still show the dialog.
    expect(screen.queryByText(ELSEWHERE)).not.toBeInTheDocument();
    expect(screen.getByText(SAVE_ME)).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/edit");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("lets the navigation through once proceed() is called", async () => {
    const user = renderEditor(true);
    await leave(user);
    expect(screen.getByTestId("where")).toHaveTextContent("/edit");

    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getByText(ELSEWHERE)).toBeInTheDocument();
    expect(screen.queryByText(SAVE_ME)).not.toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/other");
  });

  it("cancel() stays put and re-arms, so the next attempt is blocked too", async () => {
    const user = renderEditor(true);
    await leave(user);
    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    // Reset, not proceed: still here, and the dialog is gone.
    expect(screen.getByTestId("where")).toHaveTextContent("/edit");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    // A blocker left in "blocked" state after a reset would never fire again,
    // which is the difference between cancelling once and disarming the guard.
    await leave(user);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText(ELSEWHERE)).not.toBeInTheDocument();
  });

  it("never blocks when there is nothing unsaved", async () => {
    const user = renderEditor(false);
    await leave(user);

    expect(screen.getByText(ELSEWHERE)).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/other");
    // Not "no dialog was rendered" — the hook must never have reported a
    // block at any point, including a frame that was thrown away.
    expect(seen).not.toContain(true);
  });
});
