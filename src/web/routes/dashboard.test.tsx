import type { AppSummary, DashboardData } from "@shared/dashboard.js";
import type { MonitorSummary, TargetStatus } from "@shared/monitoring.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { Dashboard } from "./Dashboard.js";

afterEach(() => vi.unstubAllGlobals());

function status(state: "up" | "down" | "unknown"): TargetStatus {
  return { state, reason: null };
}

function monitor(over: Partial<MonitorSummary> = {}): MonitorSummary {
  return {
    id: "m1",
    type: "http",
    required: true,
    enabled: true,
    state: "up",
    lastCheckedAt: 1_700_000_000_000,
    error: null,
    ...over,
  };
}

function app(over: Partial<AppSummary> = {}): AppSummary {
  return {
    key: "jellyfin:web",
    source: "project",
    name: "Jellyfin",
    projectSlug: "jellyfin",
    service: "web",
    hostPort: 8096,
    hostname: "jellyfin.example.com",
    description: null,
    monitors: [],
    iconSlug: null,
    iconUrl: null,
    status: status("up"),
    tier: "verified",
    ...over,
  };
}

function stubDashboard(data: DashboardData) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFailure(status: number, error: string) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ error }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDashboard() {
  const client = createQueryClient({ retryDelay: 0 });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("Dashboard", () => {
  it("renders a tile with icon, name and dot", async () => {
    stubDashboard({
      apps: [app({ name: "Jellyfin" })],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    expect(within(tile).getByText("Jellyfin")).toBeInTheDocument();
    expect(tile.querySelector(".bg-success")).toBeInTheDocument();
  });

  it("shows tier as detail text for non-green dots", async () => {
    stubDashboard({
      apps: [app({ status: status("down"), tier: "blocked" })],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    expect(tile.querySelector(".bg-danger")).toBeInTheDocument();
    expect(within(tile).getByText("blocked")).toBeInTheDocument();
  });

  it("links a tile with a hostname to that hostname", async () => {
    stubDashboard({
      apps: [app({ hostname: "jellyfin.example.com" })],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const link = await screen.findByRole("link", { name: /jellyfin/i });
    expect(link).toHaveAttribute("href", "https://jellyfin.example.com");
  });

  it("renders a non-link tile without a hostname", async () => {
    stubDashboard({
      apps: [app({ hostname: null })],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    expect(tile).toBeInTheDocument();
    expect(within(tile).getByText("Jellyfin")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the project's icon and description", async () => {
    stubDashboard({
      apps: [
        app({
          iconSlug: "jellyfin",
          description: "Films and TV for the house",
        }),
      ],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    expect(
      within(tile).getByText("Films and TV for the house"),
    ).toBeInTheDocument();
    // Decorative: the name beside it already identifies the app, so the icon
    // is not announced a second time.
    const icon = tile.querySelector("img");
    expect(icon).toHaveAttribute("src", "/api/icons/jellyfin");
    expect(icon).toHaveAttribute("alt", "");
  });

  it("prefers the icon slug, and falls back to a bare URL", async () => {
    stubDashboard({
      apps: [app({ iconSlug: null, iconUrl: "https://example.com/i.png" })],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    expect(tile.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/i.png",
    );
  });

  it("renders neither when the project has no identity set", async () => {
    // Most projects never get one. An empty <img> would show a broken-image
    // glyph, which reads as a failure rather than an absence.
    stubDashboard({
      apps: [app({ iconSlug: null, iconUrl: null, description: null })],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    expect(tile.querySelector("img")).toBeNull();
  });

  it("keeps the checks hidden until the dot is tapped, then names each one", async () => {
    // The dot answers "is it up". Which part is not up is the next question,
    // and it used to have no answer anywhere in the UI.
    stubDashboard({
      apps: [
        app({
          status: status("down"),
          tier: "down",
          monitors: [
            monitor({ id: "1", type: "docker", state: "up" }),
            monitor({ id: "2", type: "http", state: "up" }),
            monitor({
              id: "3",
              type: "reachability",
              state: "down",
              error: "HTTP 502",
            }),
          ],
        }),
      ],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    expect(within(tile).queryByText("Container")).toBeNull();

    const toggle = within(tile).getByRole("button", { name: /show checks/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(tile).getByText("Container")).toBeInTheDocument();
    // The two HTTP checks have to be tellable apart: same verb, different
    // vantage point, and here one passes while the other does not.
    expect(within(tile).getByText("HTTP (internal)")).toBeInTheDocument();
    expect(within(tile).getByText("HTTP (public)")).toBeInTheDocument();
    expect(within(tile).getByText("HTTP 502")).toBeInTheDocument();
  });

  it("expands without following the tile's link", async () => {
    // The dot is a button and the name is the link. Were the whole tile still
    // an anchor, there would be nowhere valid to put the control.
    stubDashboard({
      apps: [
        app({ monitors: [monitor({ id: "1", type: "docker", state: "up" })] }),
      ],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    const toggle = within(tile).getByRole("button", { name: /show checks/i });
    expect(toggle.closest("a")).toBeNull();
    await userEvent.click(toggle);
    expect(within(tile).getByText("Container")).toBeInTheDocument();
  });

  it("shows no device section for a viewer", async () => {
    stubDashboard({ apps: [app()], devices: [], projectCount: 1 });
    renderDashboard();

    await screen.findByRole("article");
    // Should not say "Devices" or "No devices"
    expect(screen.queryByText(/devices/i)).toBeNull();
  });

  it("shows 'no projects yet' when there are no apps and no projects", async () => {
    stubDashboard({ apps: [], devices: [], projectCount: 0 });
    renderDashboard();

    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("shows 'none publishes a port' when projects exist but no apps", async () => {
    stubDashboard({ apps: [], devices: [], projectCount: 3 });
    renderDashboard();

    expect(
      await screen.findByText(/none of your projects publishes a port/i),
    ).toBeInTheDocument();
  });

  it("shows directory unreadable when projectCount is null", async () => {
    stubDashboard({ apps: [], devices: [], projectCount: null });
    renderDashboard();

    expect(
      await screen.findByText(/could not read projects directory/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/likely a permissions problem/i),
    ).toBeInTheDocument();
  });

  it("renders the refusal state on 403", async () => {
    stubFailure(403, "forbidden");
    renderDashboard();

    expect(
      await screen.findByText(/you do not have access/i),
    ).toBeInTheDocument();
  });
});
