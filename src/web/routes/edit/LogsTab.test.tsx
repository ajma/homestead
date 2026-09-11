// @vitest-environment jsdom
import type { ContainerSummary } from "@shared/admin.js";
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditAppContext } from "@web/routes/EditApp";
import { LogsTab } from "@web/routes/edit/LogsTab";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. Same double as `use-sse-text.test.tsx` and
// `useEventStream.test.tsx`.
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const init = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, init));
    }
  }
}

const app: AdminApp = {
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: "Media server",
  iconRef: null,
  category: "Media",
  launchUrl: null,
  status: "up",
  statusDetail: null,
  hostId: "local",
  directory: "jellyfin",
  composeFile: "compose.yaml",
  projectName: "jellyfin",
  lastComposeHash: null,
  isSystem: false,
  showOnLauncher: true,
  sortOrder: 0,
  graceUntil: null,
  adoptedAt: 1_800_000_000,
  archivedAt: null,
  lastDeployAt: null,
};

function container(over: Partial<ContainerSummary> = {}): ContainerSummary {
  const id = over.id ?? "c1";
  return {
    id,
    names: [`jellyfin-${id}`],
    image: "nginx:alpine",
    state: "running",
    status: "Up 2 hours",
    project: "jellyfin",
    service: "web",
    labels: {},
    ...over,
  };
}

function stubContainers(containers: ContainerSummary[], dockerReachable = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ containers, dockerReachable }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/apps/jellyfin/logs"]}>
          <Routes>
            <Route
              path="/apps/:slug/*"
              element={<Outlet context={{ app } satisfies EditAppContext} />}
            >
              <Route path="logs" element={<LogsTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LogsTab", () => {
  it("opens a stream for the first container once containers load", async () => {
    stubContainers([container({ id: "c1" }), container({ id: "c2" })]);
    mount();

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0]?.url).toBe("/api/apps/a1/containers/c1/logs?follow=true");
  });

  it("switches the stream, closing the old one, when a different container is selected", async () => {
    stubContainers([container({ id: "c1" }), container({ id: "c2" })]);
    mount();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    fireEvent.change(screen.getByRole("combobox", { name: /container/i }), {
      target: { value: "c2" },
    });

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(FakeEventSource.instances[1]?.url).toBe("/api/apps/a1/containers/c2/logs?follow=true");
  });

  it("renders streamed lines as they arrive", async () => {
    stubContainers([container({ id: "c1" })]);
    mount();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    act(() => {
      FakeEventSource.instances[0]?.emit("line", { text: "hello world", stream: "stdout" });
    });

    await waitFor(() => expect(screen.getByText(/hello world/)).toBeTruthy());
  });

  it("toggling follow off reopens the stream with follow=false", async () => {
    stubContainers([container({ id: "c1" })]);
    mount();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    fireEvent.click(screen.getByRole("checkbox", { name: /follow/i }));

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(FakeEventSource.instances[1]?.url).toBe("/api/apps/a1/containers/c1/logs?follow=false");
  });

  it("auto-scrolls to the newest line while following", async () => {
    stubContainers([container({ id: "c1" })]);
    mount();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const pane = screen.getByTestId("log-pane");
    Object.defineProperty(pane, "scrollHeight", { value: 1000, configurable: true });

    act(() => {
      FakeEventSource.instances[0]?.emit("line", { text: "x".repeat(50), stream: "stdout" });
    });

    await waitFor(() => expect(pane.scrollTop).toBe(1000));
  });

  it("does not fight the user once they have scrolled up to read history", async () => {
    stubContainers([container({ id: "c1" })]);
    mount();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const pane = screen.getByTestId("log-pane");
    Object.defineProperty(pane, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(pane, "clientHeight", { value: 200, configurable: true });

    // The user scrolls away from the bottom to read history.
    pane.scrollTop = 100;
    fireEvent.scroll(pane);

    act(() => {
      FakeEventSource.instances[0]?.emit("line", { text: "new line", stream: "stdout" });
    });

    expect(pane.scrollTop).toBe(100);
  });

  it("resumes auto-scroll once the user scrolls back to the bottom", async () => {
    stubContainers([container({ id: "c1" })]);
    mount();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const pane = screen.getByTestId("log-pane");
    Object.defineProperty(pane, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(pane, "clientHeight", { value: 200, configurable: true });

    pane.scrollTop = 100;
    fireEvent.scroll(pane);
    pane.scrollTop = 800; // within NEAR_BOTTOM_PX of scrollHeight - clientHeight (800)
    fireEvent.scroll(pane);

    act(() => {
      FakeEventSource.instances[0]?.emit("line", { text: "new line", stream: "stdout" });
    });

    expect(pane.scrollTop).toBe(1000);
  });

  it("says the stack is not running rather than showing an empty pane", async () => {
    stubContainers([]);
    mount();
    await waitFor(() => expect(screen.getByText(/not running/i)).toBeTruthy());
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it("distinguishes Docker being unreachable from the stack having no containers", async () => {
    stubContainers([], false);
    mount();
    await waitFor(() => expect(screen.getByText(/not reachable/i)).toBeTruthy());
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it("closes the stream when the tab unmounts", async () => {
    stubContainers([container({ id: "c1" })]);
    const { unmount } = mount();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    unmount();

    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});
