// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { adminAppKey } from "@web/api/admin";
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
  runningJobId: null,
};

/**
 * `EditApp` now resolves through `useAdminApp(slug)` (`GET /api/apps/:id`, which accepts
 * a slug too — Important 3 of the 1E final-fix brief), not `useAdminApps()`'s whole-list
 * cache. Seeding `adminAppKey(slug)` directly, the way these tests used to seed
 * `adminAppsKey`, keeps the tests that don't care about the fetch itself synchronous;
 * `fetch` is still stubbed underneath so a test can also drive the not-found path for
 * real.
 */
function mount(path = "/apps/jellyfin/overview", seedApp: AdminApp | null = app) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const slug = path.split("/")[2] ?? "";
  if (seedApp) client.setQueryData(adminAppKey(slug), seedApp);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/apps/:slug/*" element={<EditApp />}>
            <Route path="overview" element={<p>OVERVIEW</p>} />
            <Route path="containers" element={<p>CONTAINERS</p>} />
            <Route path="logs" element={<p>LOGS</p>} />
            <Route path="probes" element={<p>PROBES</p>} />
            {/*
             * Stand-ins, not the real `ComposeTab`/`EnvTab` — this file is about `EditApp`'s
             * own routing and the only-active-tab boundary it must preserve, not about what
             * those tabs render. The real components are covered by their own test files;
             * mounting them for real here would pull in CodeMirror and the vendored schema
             * for a question this file isn't asking.
             */}
            <Route path="compose" element={<p>COMPOSE</p>} />
            <Route path="env" element={<p>ENV</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubFetch(response: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(response), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

describe("EditApp", () => {
  it("shows the app's name and status in a header", () => {
    stubFetch(app);
    mount();
    expect(screen.getByRole("heading", { name: /Jellyfin/ })).toBeTruthy();
  });

  it("keeps the status header sticky, per spec's 'sticky status header' requirement", () => {
    stubFetch(app);
    mount();
    const header = screen.getByRole("banner");
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
  });

  it("renders only the active tab's content", () => {
    // Tabs are the data-loading boundary. If a hidden tab renders, its queries fire and
    // a log stream opens because someone glanced at the status header.
    stubFetch(app);
    mount("/apps/jellyfin/containers");
    expect(screen.getByText("CONTAINERS")).toBeTruthy();
    expect(screen.queryByText("LOGS")).toBeNull();
    expect(screen.queryByText("OVERVIEW")).toBeNull();
  });

  it("renders only the Compose tab's content, not every other tab alongside it", () => {
    // This is the case that matters most: the real Compose tab mounts a whole CodeMirror
    // instance, imports the vendored (86 KB) schema, and can fire a `docker compose
    // config` spawn on load. If the shell ever rendered every tab and hid the inactive
    // ones with CSS instead of routing through `<Outlet />`, opening the app's Overview
    // tab would silently do all of that. This test only proves the routing boundary
    // (stand-in tabs, not the real editor) — Task 4's own gate covers what the real tab
    // does once mounted.
    stubFetch(app);
    mount("/apps/jellyfin/compose");
    expect(screen.getByText("COMPOSE")).toBeTruthy();
    expect(screen.queryByText("OVERVIEW")).toBeNull();
    expect(screen.queryByText("CONTAINERS")).toBeNull();
    expect(screen.queryByText("LOGS")).toBeNull();
    expect(screen.queryByText("PROBES")).toBeNull();
    expect(screen.queryByText("ENV")).toBeNull();
  });

  it("renders only the .env tab's content, not every other tab alongside it", () => {
    stubFetch(app);
    mount("/apps/jellyfin/env");
    expect(screen.getByText("ENV")).toBeTruthy();
    expect(screen.queryByText("OVERVIEW")).toBeNull();
    expect(screen.queryByText("CONTAINERS")).toBeNull();
    expect(screen.queryByText("LOGS")).toBeNull();
    expect(screen.queryByText("PROBES")).toBeNull();
    expect(screen.queryByText("COMPOSE")).toBeNull();
  });

  it("offers a tab link per route", () => {
    stubFetch(app);
    mount();
    for (const name of ["Overview", "Containers", "Logs", "Probes", "Compose", ".env"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
  });

  it("orders the tabs Overview, Containers, Logs, Probes, Compose, then .env", () => {
    // Not just presence — the brief calls for "a sensible order" and this is the one a
    // reader would expect: status/inspection tabs first, the two editors (the heaviest,
    // least-often-needed tabs) last.
    stubFetch(app);
    mount();
    const nav = screen.getByRole("navigation", { name: "App sections" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labels).toEqual(["Overview", "Containers", "Logs", "Probes", "Compose", ".env"]);
  });

  it("has no exposure tab, since Cloudflare is Phase 2", () => {
    stubFetch(app);
    mount();
    expect(screen.queryByRole("link", { name: /Exposure/ })).toBeNull();
  });

  it("says so plainly when the slug matches no app", async () => {
    stubFetch({ error: "not_found" }, 404);
    mount("/apps/nope/overview", null);
    await waitFor(() => expect(screen.getByText(/No app called/)).toBeTruthy());
  });

  describe("right-rail metadata", () => {
    // Spec §8's right rail: "actions, exposure, image updates, and metadata" — the
    // metadata part, wrongly claimed as delivered by 1E's Self-Review (Task 11).

    it("shows the directory, compose file, project name, adoption date and last deploy", () => {
      stubFetch(app);
      mount();
      const rail = within(screen.getByTestId("app-metadata"));
      // "jellyfin" appears twice here: directory and project name are the same string
      // in this fixture.
      expect(rail.getAllByText("jellyfin")).toHaveLength(2);
      expect(rail.getByText("compose.yaml")).toBeTruthy();
      expect(rail.getByText(/ago$/)).toBeTruthy(); // adopted, some age string
      expect(rail.getByText("Never")).toBeTruthy(); // never deployed
    });

    it("says 'Never' for last deploy when the app has never been deployed", () => {
      const seedApp = { ...app, lastDeployAt: null };
      stubFetch(seedApp);
      mount("/apps/jellyfin/overview", seedApp);
      expect(within(screen.getByTestId("app-metadata")).getByText("Never")).toBeTruthy();
    });

    it("shows the age of the most recent deploy when there is one", () => {
      const now = Math.floor(Date.now() / 1000);
      const seedApp = { ...app, lastDeployAt: now - 60 };
      stubFetch(seedApp);
      mount("/apps/jellyfin/overview", seedApp);
      expect(within(screen.getByTestId("app-metadata")).getByText(/1m ago/)).toBeTruthy();
    });

    it("is absent on mobile widths, where the action bar takes that space", () => {
      // jsdom has no real viewport, so this checks the responsive classes directly:
      // `hidden` at the base breakpoint, revealed only from `lg` up, same pattern used
      // for the desktop-only table header elsewhere in this codebase.
      stubFetch(app);
      mount();
      const rail = screen.getByTestId("app-metadata");
      expect(rail.className).toContain("hidden");
      expect(rail.className).toContain("lg:flex");
    });
  });
});
