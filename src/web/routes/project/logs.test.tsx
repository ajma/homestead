import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetailData } from "../../lib/queries.js";
import { FakeEventSource } from "../../test-support/fake-event-source.js";
import { projectDetailRoute } from "../ProjectDetail.js";

const SLUG = "jellyfin";

function detail(over: Partial<ProjectDetailData> = {}): ProjectDetailData {
  return {
    slug: SLUG,
    hasCompose: true,
    hasEnv: false,
    composeFile: "compose.yaml",
    model: {
      projectName: SLUG,
      // Deliberately not alphabetical: the toolbar sorts, so a compose file
      // reordered by an edit does not reorder the menu under the reader.
      services: [
        { name: "web", ports: [], labels: {}, app: null },
        { name: "db", ports: [], labels: {}, app: null },
      ],
      volumes: [],
      meta: { schemaVersion: 1, system: false },
    },
    parseError: null,
    states: [],
    statesError: null,
    snapshots: [],
    ...over,
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      String(path).endsWith("/operations")
        ? json(200, { operations: [] })
        : json(200, detail()),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderLogs() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/projects/${SLUG}/logs`]}>
        <Routes>{projectDetailRoute}</Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return await screen.findByRole("log", { name: "Log output" });
}

function stream(): FakeEventSource {
  const last = FakeEventSource.last;
  if (!last) throw new Error("the tab never opened an EventSource");
  return last;
}

function emit(fn: (es: FakeEventSource) => void) {
  act(() => {
    fn(stream());
  });
}

/** Every url this tab has asked for, in order. */
function urls(): string[] {
  return FakeEventSource.instances.map((es) => es.url);
}

function query(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

describe("the Logs tab's stream url", () => {
  it("asks for the server's own default tail and omits the service", async () => {
    const log = await renderLogs();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "web-1  | listening\n" });
    });

    expect(log).toHaveTextContent("listening");
    expect(log.className).toContain("font-mono");
    const params = query(stream().url);
    expect(new URL(stream().url, "http://x").pathname).toBe(
      `/api/projects/${SLUG}/logs`,
    );
    expect(params.get("tail")).toBe("200");
    // An empty `service=` fails the server's `/^[a-zA-Z0-9][...]*$/` and comes
    // back 400. "All services" must omit the key, not send it empty.
    expect(params.has("service")).toBe(false);
  });

  it("offers only service names the server's regex already accepts", async () => {
    await renderLogs();
    const select = screen.getByLabelText("Service");

    expect(
      [...select.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(["All services", "db", "web"]);
    // No free-text field: a typed name the server refuses is a 400 the reader
    // cannot act on.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("sends the chosen service and drops it again for All", async () => {
    await renderLogs();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Service"), "web");
    expect(query(stream().url).get("service")).toBe("web");

    await user.selectOptions(screen.getByLabelText("Service"), "");
    expect(query(stream().url).has("service")).toBe(false);
    // And no connection this tab has ever opened carried an empty one.
    expect(urls().filter((u) => /[?&]service=(&|$)/.test(u))).toEqual([]);
  });

  it("only offers tail sizes inside the server's 0..10000 bound", async () => {
    await renderLogs();
    const user = userEvent.setup();
    const select = screen.getByLabelText("Lines");
    const values = [...select.querySelectorAll("option")].map((o) => o.value);

    expect(values.length).toBeGreaterThan(1);
    for (const value of values) {
      expect(Number.isInteger(Number(value)), value).toBe(true);
      expect(Number(value)).toBeGreaterThanOrEqual(0);
      expect(Number(value)).toBeLessThanOrEqual(10_000);
    }

    await user.selectOptions(select, "1000");
    expect(query(stream().url).get("tail")).toBe("1000");
  });
});

describe("pausing the log", () => {
  it("closes the connection and keeps what is already on screen", async () => {
    const log = await renderLogs();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "before the pause\n" });
    });
    const live = stream();

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    // Detached, not buffered: the child process on the server dies with it.
    expect(live.closeCount).toBeGreaterThan(0);
    expect(FakeEventSource.last).toBe(live);
    // …and the reason someone pressed Pause is still readable.
    expect(log).toHaveTextContent("before the pause");
    expect(screen.getByText(/not being collected/i)).toBeVisible();
  });

  it("reopens on Follow, asking for the tail again", async () => {
    await renderLogs();
    emit((es) => es.emitOpen());
    const opened = FakeEventSource.instances.length;

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(FakeEventSource.instances.length).toBe(opened);

    await userEvent.click(screen.getByRole("button", { name: "Follow" }));

    expect(FakeEventSource.instances.length).toBeGreaterThan(opened);
    expect(query(stream().url).get("tail")).toBe("200");
    expect(screen.queryByText(/not being collected/i)).not.toBeInTheDocument();
  });
});

describe("the Logs tab's stream states", () => {
  it("explains a refusal instead of spinning, and does not reopen", async () => {
    // A viewer holds only `app:read`, so this endpoint answers them 403 and
    // EventSource closes for good rather than hammering it.
    await renderLogs();
    const opened = FakeEventSource.instances.length;
    emit((es) => es.emitFatal());

    expect(screen.getByRole("alert")).toHaveTextContent(
      /administrator account/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/will not reconnect/i);
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    // One request, no retry storm.
    expect(FakeEventSource.instances.length).toBe(opened);
  });

  it("says so quietly while the browser retries a drop", async () => {
    await renderLogs();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "listening\n" });
      es.emitDrop();
    });

    expect(screen.getByText("Connecting…")).toBeVisible();
    // A retry the browser is already making is not an alarm.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("listening");
  });

  it("marks a reconnect in the log, because only the tail comes back", async () => {
    // `replace` is the right policy — the reconnected request re-issues
    // `--tail=N` — and it is still lossy: the server keeps no scrollback, so
    // everything older than those N lines is gone. Redrawing in silence would
    // destroy a reader's history as invisibly as a Pause that dropped output.
    const log = await renderLogs();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "OLD-LINE-1\n" });
      es.emitMessage({ chunk: "OLD-LINE-2\n" });
    });
    expect(log).toHaveTextContent("OLD-LINE-1");
    expect(screen.queryByText(/reconnected/i)).not.toBeInTheDocument();

    emit((es) => {
      es.emitDrop();
      es.emitOpen();
      es.emitMessage({ chunk: "TAIL-ONLY\n" });
    });

    // Replaced, not doubled…
    expect(log).toHaveTextContent("TAIL-ONLY");
    expect(log).not.toHaveTextContent("OLD-LINE-1");
    // …and the reader is told that is what happened, inside the log, where the
    // missing lines used to be.
    const marker = screen.getByText(/the stream reconnected/i);
    expect(marker).toBeVisible();
    expect(log).toContainElement(marker);
    expect(marker).toHaveTextContent(/last 200 lines/);
  });

  it("reports the stream ending rather than pretending to follow", async () => {
    // `docker compose logs -f` exits when the stack has no running containers,
    // and the terminal frame here carries no operation to report.
    const log = await renderLogs();
    emit((es) => {
      es.emitOpen();
      es.emitMessage({ chunk: "exited with code 0\n" });
      es.emitMessage({ end: true });
    });

    expect(screen.getByText(/log stream ended/i)).toBeVisible();
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    expect(log).toHaveTextContent("exited with code 0");
  });
});

/**
 * jsdom has no layout, so the log's scroll geometry has to be supplied. What
 * is under test is the wiring — that the tab consults where the reader is
 * before it moves them — not the browser's arithmetic.
 */
function fakeScrollGeometry(el: HTMLElement, scrollHeight: number) {
  let scrollTop = 0;
  let height = scrollHeight;
  let client = 200;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => client,
  });
  return {
    /** What the browser does when an ancestor hides the region. */
    hide() {
      height = 0;
      client = 0;
      scrollTop = 0;
      fireEvent.scroll(el);
    },
    show() {
      height = scrollHeight;
      client = 200;
    },
  };
}

describe("following the log", () => {
  it("scrolls to the newest line while the reader is at the bottom", async () => {
    const log = await renderLogs();
    emit((es) => es.emitOpen());
    fakeScrollGeometry(log, 1_000);
    log.scrollTop = 800;
    fireEvent.scroll(log);

    emit((es) => es.emitMessage({ chunk: "the newest line\n" }));

    expect(log.scrollTop).toBe(1_000);
  });

  it("leaves the view alone once the reader has scrolled up", async () => {
    // Yanking the view down while someone reads the line that explains the
    // crash is worse than not following at all.
    const log = await renderLogs();
    emit((es) => es.emitOpen());
    fakeScrollGeometry(log, 1_000);
    log.scrollTop = 0;
    fireEvent.scroll(log);

    emit((es) => es.emitMessage({ chunk: "the newest line\n" }));

    expect(log.scrollTop).toBe(0);
  });

  it("does not re-arm the follow when a hidden region is revealed", async () => {
    // A hidden element measures 0/0/0, which reads as "at the bottom", and the
    // scroll event the browser fires as it drops the box would silently put
    // the reader back on the leash they deliberately got off.
    const log = await renderLogs();
    emit((es) => es.emitOpen());
    const geometry = fakeScrollGeometry(log, 1_000);
    log.scrollTop = 0;
    fireEvent.scroll(log);

    geometry.hide();
    geometry.show();

    emit((es) => es.emitMessage({ chunk: "the newest line\n" }));

    expect(log.scrollTop).toBe(0);
  });

  it("turns off scroll anchoring, which fights the follow", async () => {
    // Anchoring adjusts `scrollTop` to keep existing content still as lines
    // are appended — the opposite of following the newest one.
    const log = await renderLogs();
    expect(log.style.overflowAnchor).toBe("none");
  });
});
