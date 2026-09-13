// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { adminAppKey } from "@web/api/admin";
import { EditApp } from "@web/routes/EditApp";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
  systemKind: null,
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
/** Renders the current pathname into the DOM so a test can assert where a click actually
 * landed, the way `window.location` does for the real `createBrowserRouter` in
 * `App.test.tsx` — this file uses a plain `<MemoryRouter>`, which has no `window.location`
 * of its own to read. */
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function mount(path = "/apps/jellyfin/overview", seedApp: AdminApp | null = app) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const slug = path.split("/")[2] ?? "";
  if (seedApp) client.setQueryData(adminAppKey(slug), seedApp);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <LocationDisplay />
        {/*
         * `/apps/:slug`, not `/apps/:slug/*` — matches the real parent route in `App.tsx`
         * post-fix. The `/*` used to make this a splat route, which is what made a
         * *relative* `<NavLink to="exposure">` (etc.) rendered by `EditApp` resolve
         * against the parent's matched pathname *including* whatever tab was already
         * open, instead of against the app root — see the "moving between tabs" describe
         * block below, and `App.tsx`'s own fix comment, for the mechanism.
         */}
        <Routes>
          <Route path="/apps/:slug" element={<EditApp />}>
            <Route path="overview" element={<p>OVERVIEW</p>} />
            <Route path="containers" element={<p>CONTAINERS</p>} />
            <Route path="logs" element={<p>LOGS</p>} />
            <Route path="probes" element={<p>PROBES</p>} />
            {/*
             * A stand-in, not the real `ConfigTab` (which itself renders the real
             * `ComposeTab`/`EnvTab`) — this file is about `EditApp`'s own routing and the
             * only-active-tab boundary it must preserve, not about what those tabs render.
             * The real components are covered by their own test files; mounting them for
             * real here would pull in CodeMirror and the vendored schema for a question
             * this file isn't asking.
             */}
            <Route path="config" element={<p>CONFIG</p>} />
            <Route path="exposure" element={<p>EXPOSURE</p>} />
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

  it("renders only the Config tab's content, not every other tab alongside it", () => {
    // This is the case that matters most: the real Config tab mounts the real Compose and
    // `.env` editors together — a whole CodeMirror instance, the vendored (86 KB) schema,
    // and a `docker compose config` spawn on load. If the shell ever rendered every tab
    // and hid the inactive ones with CSS instead of routing through `<Outlet />`, opening
    // the app's Overview tab would silently do all of that. This test only proves the
    // routing boundary (a stand-in tab, not the real editors) — `ConfigTab.test.tsx` and
    // Task 4's own gate cover what the real tab does once mounted.
    stubFetch(app);
    mount("/apps/jellyfin/config");
    expect(screen.getByText("CONFIG")).toBeTruthy();
    expect(screen.queryByText("OVERVIEW")).toBeNull();
    expect(screen.queryByText("CONTAINERS")).toBeNull();
    expect(screen.queryByText("LOGS")).toBeNull();
    expect(screen.queryByText("PROBES")).toBeNull();
    expect(screen.queryByText("EXPOSURE")).toBeNull();
  });

  it("offers a tab link per route", () => {
    stubFetch(app);
    mount();
    for (const name of ["Overview", "Containers", "Logs", "Probes", "Config", "Exposure"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
  });

  it("orders the tabs Overview, Containers, Logs, Probes, Config, then Exposure", () => {
    // Not just presence — the brief calls for "a sensible order" and this is the one a
    // reader would expect: status/inspection tabs first, the combined Config tab (the
    // heaviest, least-often-needed one) after that, and 2F Task 3's exposure tab — the
    // newest, and the one most apps will never touch — last of all.
    stubFetch(app);
    mount();
    const nav = screen.getByRole("navigation", { name: "App sections" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labels).toEqual(["Overview", "Containers", "Logs", "Probes", "Config", "Exposure"]);
  });

  describe("moving between tabs by clicking, not just visiting a tab's URL directly", () => {
    // Every test above this one proves a tab renders once `mount(path)` has already put
    // the URL there directly — none of them click the `<NavLink>` that a real user
    // clicks to get from one tab to another. That gap is exactly why the reported bug
    // ("clicking Exposure from Overview lands on .../overview/exposure") slipped past
    // this file: `EditApp`'s tabs sit under a splat parent route in `App.tsx`
    // (`/apps/:slug/*`, before the fix this branch makes), and a *relative*
    // `<NavLink to="exposure">` rendered there resolves against the parent's matched
    // pathname *including* the splat capture, not the route pattern — so once any tab
    // is open, every relative tab link on the page is affected the same way, not only
    // Exposure's. This exercises every ordered pair of tabs to prove that breadth,
    // rather than re-testing only the one pair the report named.
    const TAB_LABEL: Record<string, string> = {
      overview: "Overview",
      containers: "Containers",
      logs: "Logs",
      probes: "Probes",
      config: "Config",
      exposure: "Exposure",
    };

    function clickTo(from: string, to: string) {
      it(`clicking ${TAB_LABEL[to]} from ${TAB_LABEL[from]} lands on /apps/jellyfin/${to}`, () => {
        stubFetch(app);
        mount(`/apps/jellyfin/${from}`);
        fireEvent.click(screen.getByRole("link", { name: TAB_LABEL[to] }));
        expect(screen.getByTestId("location").textContent).toBe(`/apps/jellyfin/${to}`);
      });
    }

    // The exact pair the bug report named.
    clickTo("overview", "exposure");
    // Every other destination from the same starting tab as the report — proving the
    // break (and the fix) is not specific to Exposure. Compose and `.env` used to be two
    // separate destinations here (`overview` -> `compose`, `overview` -> `env`); merged
    // into one Config tab, that's one link, not two.
    clickTo("overview", "containers");
    clickTo("overview", "logs");
    clickTo("overview", "probes");
    clickTo("overview", "config");
    // The reverse direction, and starting tabs other than the one the report named —
    // proving the splat capture is nonempty (and so the bug bites) from any tab, not
    // only `overview`. `probes` -> `config` and `config` -> `exposure` stand in for the
    // old `probes` -> `compose` and `compose`/`env` -> `exposure` pairs — Config is now
    // the one heaviest, lazy-loaded tab those used to represent.
    clickTo("exposure", "overview");
    clickTo("containers", "logs");
    clickTo("logs", "probes");
    clickTo("probes", "config");
    clickTo("config", "exposure");
    // Config is reachable from, and leads back to, every other tab — not just the two
    // neighbours in the chain above — since it is the one tab users are now most likely
    // to jump to directly from anywhere (it replaces two).
    clickTo("containers", "config");
    clickTo("config", "overview");
    clickTo("logs", "config");
    clickTo("exposure", "config");
    clickTo("config", "probes");
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
