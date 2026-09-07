import type { AppSummary, DashboardData } from "@shared/dashboard.js";
import type { TargetStatus } from "@shared/monitoring.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { Dashboard } from "./Dashboard.js";

afterEach(() => vi.unstubAllGlobals());

function status(state: "up" | "down" | "unknown"): TargetStatus {
  return { state, reason: null };
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
      apps: [app({ status: status("down"), tier: "degraded" })],
      devices: [],
      projectCount: 1,
    });
    renderDashboard();

    const tile = await screen.findByRole("article");
    expect(tile.querySelector(".bg-danger")).toBeInTheDocument();
    expect(within(tile).getByText("degraded")).toBeInTheDocument();
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
