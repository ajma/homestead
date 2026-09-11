// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { adminAppsKey } from "@web/api/admin";
import { EditApp } from "@web/routes/EditApp";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const app: AdminApp = {
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: null,
  iconRef: null,
  category: null,
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

function mount(path = "/apps/jellyfin/overview", seed: AdminApp[] = [app]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(adminAppsKey, seed);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/apps/:slug/*" element={<EditApp />}>
            <Route path="overview" element={<p>OVERVIEW</p>} />
            <Route path="containers" element={<p>CONTAINERS</p>} />
            <Route path="logs" element={<p>LOGS</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EditApp", () => {
  it("shows the app's name and status in a header", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(app), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    mount();
    expect(screen.getByRole("heading", { name: /Jellyfin/ })).toBeTruthy();
  });

  it("renders only the active tab's content", () => {
    // Tabs are the data-loading boundary. If a hidden tab renders, its queries fire and
    // a log stream opens because someone glanced at the status header.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    mount("/apps/jellyfin/containers");
    expect(screen.getByText("CONTAINERS")).toBeTruthy();
    expect(screen.queryByText("LOGS")).toBeNull();
    expect(screen.queryByText("OVERVIEW")).toBeNull();
  });

  it("offers a tab link per route", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    mount();
    for (const name of ["Overview", "Containers", "Logs"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
  });

  it("has no exposure tab, since Cloudflare is Phase 2", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    mount();
    expect(screen.queryByRole("link", { name: /Exposure/ })).toBeNull();
  });

  it("says so plainly when the slug matches no app", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    mount("/apps/nope/overview", []);
    await waitFor(() => expect(screen.getByText(/No app called/)).toBeTruthy());
  });
});
