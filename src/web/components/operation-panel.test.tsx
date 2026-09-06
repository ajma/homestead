import type { Operation } from "@shared/projects.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queries.js";
import { FakeEventSource } from "../test-support/fake-event-source.js";
import { isAtBottom, OperationPanel } from "./OperationPanel.js";

const OP_ID = "op-42";

function operation(over: Partial<Operation> = {}): Operation {
  return {
    id: OP_ID,
    slug: "jellyfin",
    kind: "restart",
    status: "succeeded",
    exitCode: 0,
    startedAt: 1_000,
    finishedAt: 4_000,
    ...over,
  };
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPanel(onDismiss = vi.fn()) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <OperationPanel
        operationId={OP_ID}
        slug="jellyfin"
        kind="restart"
        onDismiss={onDismiss}
      />
    </QueryClientProvider>,
  );
  return { invalidate, onDismiss };
}

function stream(): FakeEventSource {
  const last = FakeEventSource.last;
  if (!last) throw new Error("the panel never opened an EventSource");
  return last;
}

function emit(fn: (es: FakeEventSource) => void) {
  act(() => {
    fn(stream());
  });
}

function log(): HTMLElement {
  return screen.getByLabelText("Operation output");
}

describe("OperationPanel", () => {
  it("streams the operation's output into a mono log", () => {
    renderPanel();

    expect(stream().url).toBe(`/api/operations/${OP_ID}/stream`);
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "Container jellyfin-web-1  Restarting\n" });
      es.emitMessage({ chunk: "Container jellyfin-web-1  Started\n" });
    });

    expect(log()).toHaveTextContent(/Restarting[\s\S]*Started/);
    expect(log().className).toContain("font-mono");
    // The verb, so the panel is not an anonymous box while it runs.
    expect(screen.getByText("restart")).toBeInTheDocument();
  });

  it("collapses to a status line once the stack is up", async () => {
    // A success is a one-line answer. Leaving 200 lines of `docker compose up`
    // on screen buries the next thing the person came to do.
    renderPanel();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "Started\n" });
    });
    expect(log()).toBeVisible();

    emit((es) => es.emitMessage({ end: true, operation: operation() }));

    expect(screen.getByText(/Succeeded \(exit 0\)/)).toBeInTheDocument();
    expect(log()).not.toBeVisible();
    // Collapsed, not discarded: the output is one tap away.
    await userEvent.click(screen.getByRole("button", { name: "Show output" }));
    expect(log()).toBeVisible();
    expect(log()).toHaveTextContent("Started");
  });

  it("stays expanded on a failure", () => {
    renderPanel();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "Error: port is already allocated\n" });
      es.emitMessage({
        end: true,
        operation: operation({ status: "failed", exitCode: 1 }),
      });
    });

    expect(screen.getByText(/Failed \(exit 1\)/)).toBeInTheDocument();
    expect(log()).toBeVisible();
    expect(log()).toHaveTextContent("port is already allocated");
  });

  it("keeps the failure on screen when a reconnect replays nothing", () => {
    // The registry only replays while the operation is still in `live`. Once
    // it has finished and been evicted — or the server restarted — subscribe
    // finds no entry and ends the stream immediately with zero chunks. A panel
    // that resets eagerly on open shows the person who reconnected to read the
    // failure an empty log and a terminal status.
    renderPanel();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "Error: port is already allocated\n" });
    });

    emit((es) => {
      es.emitError();
      es.emitOpen();
      es.emitMessage({
        end: true,
        operation: operation({ status: "failed", exitCode: 1 }),
      });
    });

    expect(log()).toHaveTextContent("port is already allocated");
    expect(screen.getByText(/Failed \(exit 1\)/)).toBeInTheDocument();
  });

  it("replaces, rather than doubles, a replayed log", () => {
    renderPanel();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "Pulling web\n" });
    });

    emit((es) => {
      es.emitError();
      es.emitOpen();
      // What the registry sends a fresh subscriber: the whole buffer again.
      es.emitMessage({ chunk: "Pulling web\n" });
      es.emitMessage({ chunk: "Pulled\n" });
    });

    const text = log().textContent ?? "";
    expect(text.match(/Pulling web/g) ?? []).toHaveLength(1);
    expect(text).toContain("Pulled");
  });

  it("says the connection dropped rather than looking finished", () => {
    renderPanel();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "Pulling web\n" });
      es.emitError();
    });

    expect(screen.getByText(/lost the connection/i)).toBeInTheDocument();
    // Not a terminal state: nothing here says the operation itself ended.
    expect(screen.queryByText(/Succeeded|Failed/)).not.toBeInTheDocument();
  });

  it("refreshes the project and the list when the operation ends", () => {
    // Container states and the project list both changed under the page.
    const { invalidate } = renderPanel();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ end: true, operation: operation() });
    });

    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(queryKeys.project("jellyfin"));
    expect(keys).toContainEqual(queryKeys.projects);
  });

  it("does not claim a status the server never gave", () => {
    // `find` returns nothing when the row was never written — a full disk on a
    // NAS does that. "Succeeded" would be an invention.
    renderPanel();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ end: true, operation: null });
    });

    expect(screen.getByText(/did not say how it ended/i)).toBeInTheDocument();
    expect(log()).toBeVisible();
  });

  it("closes the stream when it is dismissed", async () => {
    const onDismiss = vi.fn();
    renderPanel(onDismiss);
    emit((es) => es.emitOpen());

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

/**
 * jsdom has no layout, so the log's scroll geometry has to be supplied. What
 * is under test is the wiring — that the panel consults where the reader is
 * before it moves them — not the browser's arithmetic.
 */
function fakeScrollGeometry(el: HTMLElement, scrollHeight: number) {
  let scrollTop = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
}

describe("following the output", () => {
  it("scrolls to the newest line while the reader is at the bottom", () => {
    renderPanel();
    emit((es) => es.emitOpen());
    const el = log();
    fakeScrollGeometry(el, 1_000);
    el.scrollTop = 800;
    fireEvent.scroll(el);

    emit((es) => es.emitMessage({ chunk: "the newest line\n" }));

    expect(el.scrollTop).toBe(1_000);
  });

  it("leaves the view alone once the reader has scrolled up", () => {
    // Yanking the view back down while someone is reading the line that
    // explains the failure is worse than not following at all.
    renderPanel();
    emit((es) => es.emitOpen());
    const el = log();
    fakeScrollGeometry(el, 1_000);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    emit((es) => es.emitMessage({ chunk: "the newest line\n" }));

    expect(el.scrollTop).toBe(0);
  });
});

describe("isAtBottom", () => {
  it("follows while the reader is at the bottom", () => {
    expect(
      isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(true);
    // A few pixels of slack: a wrapped last line should not stop the follow.
    expect(
      isAtBottom({ scrollTop: 790, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(true);
  });

  it("stops following once the reader has scrolled up", () => {
    // Yanking the view down while someone reads the line that explains the
    // failure is worse than not following.
    expect(
      isAtBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(false);
    expect(
      isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(false);
  });
});
