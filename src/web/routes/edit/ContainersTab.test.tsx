// @vitest-environment jsdom
import type { ContainerSummary } from "@shared/admin.js";
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditAppContext } from "@web/routes/EditApp";
import { ContainersTab } from "@web/routes/edit/ContainersTab";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const DETAIL = {
  id: "c1",
  name: "jellyfin-c1",
  image: "nginx:alpine",
  imageDigest: "sha256:abc",
  state: "running",
  exitCode: null,
  oomKilled: false,
  startedAt: "2026-09-10T00:00:00Z",
  finishedAt: null,
  restartPolicy: "unless-stopped",
  restartCount: 0,
  tty: false,
  env: [],
  mounts: [],
  ports: [],
  networks: ["jellyfin_default"],
  health: { status: "healthy", failingStreak: 0, log: [] },
};

/**
 * Responds to both the list route and any per-container detail route off one mock, the
 * same way a real Fastify server would. Callers assert on which URLs `fetch` actually
 * saw, not just on what got rendered.
 */
function stubList(containers: ContainerSummary[], dockerReachable = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/containers/")) {
        return new Response(JSON.stringify(DETAIL), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ containers, dockerReachable }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mount(seedApp: AdminApp = app) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/apps/jellyfin/containers"]}>
          <Routes>
            <Route
              path="/apps/:slug/*"
              element={<Outlet context={{ app: seedApp } satisfies EditAppContext} />}
            >
              <Route path="containers" element={<ContainersTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ContainersTab", () => {
  it("lists a container with its name, image, state and status", async () => {
    stubList([container({ id: "c1", state: "running", status: "Up 2 hours" })]);
    mount();

    await waitFor(() => expect(screen.getByText(/c1/)).toBeTruthy());
    expect(screen.getByText("nginx:alpine")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("Up 2 hours")).toBeTruthy();
  });

  it("lists a stopped container rather than hiding it", async () => {
    // "Why is this down" is the question the tab answers — hiding the stopped
    // container would hide the answer.
    stubList([container({ id: "c1", state: "exited", status: "Exited (137) 3 minutes ago" })]);
    mount();

    await waitFor(() => expect(screen.getByText(/c1/)).toBeTruthy());
    expect(screen.getByText("exited")).toBeTruthy();
    expect(screen.getByText("Exited (137) 3 minutes ago")).toBeTruthy();
  });

  it("does not fetch detail until a row is expanded", async () => {
    // Fetching every container's inspect payload on mount is one Docker round trip per
    // container for data nobody asked for.
    stubList([container({ id: "c1" }), container({ id: "c2" })]);
    mount();

    await waitFor(() => expect(screen.getByText(/c1/)).toBeTruthy());
    expect(
      vi.mocked(fetch).mock.calls.filter((call) => String(call[0]).includes("/containers/")),
    ).toHaveLength(0);
  });

  it("fetches only the expanded container's detail, not every row's", async () => {
    stubList([container({ id: "c1" }), container({ id: "c2" })]);
    mount();

    await waitFor(() => expect(screen.getByText(/c1/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /jellyfin-c1/ }));

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some((call) => String(call[0]).includes("/api/apps/a1/containers/c1")),
      ).toBe(true),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some((call) => String(call[0]).includes("/api/apps/a1/containers/c2")),
    ).toBe(false);

    // The expanded panel actually renders the fetched detail, not just requests it.
    await waitFor(() => expect(screen.getByText("unless-stopped")).toBeTruthy());
  });

  it("collapsing a row stops showing its detail", async () => {
    stubList([container({ id: "c1" })]);
    mount();

    await waitFor(() => expect(screen.getByText(/c1/)).toBeTruthy());
    const toggle = screen.getByRole("button", { name: /jellyfin-c1/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("unless-stopped")).toBeTruthy());

    fireEvent.click(toggle);
    expect(screen.queryByText("unless-stopped")).toBeNull();
  });

  it("says the stack is not running rather than showing a bare table when there are no containers", async () => {
    stubList([]);
    mount();

    await waitFor(() => expect(screen.getByText(/not running/i)).toBeTruthy());
  });

  it("distinguishes Docker being unreachable from the stack simply having no containers", async () => {
    // A Docker failure and an empty stack both leave the container list empty, but they
    // are not the same fact: only one of them means the admin should go poke at
    // anything. Telling them apart is the entire point of `dockerReachable`.
    stubList([], false);
    mount();

    await waitFor(() => expect(screen.getByText(/not reachable/i)).toBeTruthy());
    expect(screen.queryByText(/not running/i)).toBeNull();
  });
});
