// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { adminAppKey } from "@web/api/admin";
import { PAGE_MAX_WIDTH } from "@web/lib/density";
import { EditApp, useWideEditLayout } from "@web/routes/EditApp";
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

/**
 * Stand-in for the real `ConfigTab` at the `config` route — same reasoning as the plain
 * `<p>CONFIG</p>` stands in for the rest of it (this file is about `EditApp`'s own
 * routing and layout, not what a real tab renders), but this one also calls the real
 * `useWideEditLayout` so the row-width tests below exercise the actual opt-out wiring
 * `ConfigTab` uses, without pulling in CodeMirror or the vendored schema for a question
 * this file isn't asking.
 */
function WideConfigStandIn() {
  useWideEditLayout();
  return <p>CONFIG</p>;
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
            <Route path="config" element={<WideConfigStandIn />} />
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

  describe("content row width", () => {
    // The regression: on a wide viewport `main` (flex-1, unbounded) stretched to match
    // the page's own width cap while its actual content stayed capped far narrower,
    // stranding the rail hundreds of pixels away with dead space in between. The fix
    // caps and centres `main` + the rail together as one group — every tab gets that
    // by default; `ConfigTab` (via `useWideEditLayout`, exercised here through
    // `WideConfigStandIn` rather than the real, CodeMirror-heavy tab) is the one that
    // opts out. jsdom has no layout engine, so this reads the class list that encodes
    // the decision, not a measured width.
    it("caps and centres the row for the default tab", () => {
      stubFetch(app);
      mount();
      const row = screen.getByTestId("edit-content-row");
      for (const cls of `lg:mx-auto lg:${PAGE_MAX_WIDTH}`.split(" ")) {
        expect(row.className).toContain(cls);
      }
    });

    it("lets the Config tab opt out and keep the full row width", () => {
      stubFetch(app);
      mount("/apps/jellyfin/config");
      const row = screen.getByTestId("edit-content-row");
      for (const cls of `lg:mx-auto lg:${PAGE_MAX_WIDTH}`.split(" ")) {
        expect(row.className).not.toContain(cls);
      }
    });

    // The regression the user actually reported: switching between Manage (`PAGE_SHELL`,
    // built from `PAGE_MAX_WIDTH`) and an app's edit page used to visibly jump because the
    // two pages capped at different widths (1680px vs 1328px). Asserting both resolve to
    // the literal same token — not just "some max-width" — is what would catch a future
    // edit that widens one without the other back out of sync.
    it("resolves to the same width token Manage's PAGE_SHELL uses", () => {
      stubFetch(app);
      mount();
      const row = screen.getByTestId("edit-content-row");
      expect(row.className).toContain(PAGE_MAX_WIDTH);
    });

    it("gives the sticky app header an inner container capped at the same width as the content row", () => {
      stubFetch(app);
      mount();
      const header = screen.getByRole("banner");
      // The bar itself stays full-bleed (no max-width class directly on it) — only its
      // first child, the content container, is constrained.
      expect(header.className).not.toContain("max-w-");
      const inner = header.firstElementChild as HTMLElement;
      expect(inner.className).toContain("mx-auto");
      expect(inner.className).toContain(PAGE_MAX_WIDTH);
    });
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

  describe("right-rail exposure summary", () => {
    // Spec §8 names four things the rail should carry — actions, exposure, image
    // updates, metadata — and the survey found exposure was the one missing: it existed
    // only inside the Exposure tab itself, one click away.

    // `ActionBar` (also in the rail) reads `GET .../jobs` for real whenever it isn't
    // given `knownRunningJobId` — `EditApp` doesn't pass it — so every stub in this
    // block must answer that endpoint with an array, not fall through to a shape
    // `jobs?.find` cannot call.
    function stubExposure(body: unknown) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/expose")) {
            return new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/jobs") || url.endsWith("/images")) {
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify(app), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      );
    }

    it("shows a compact exposure card linking to the Exposure tab", async () => {
      stubExposure({
        exposed: true,
        hostname: "jellyfin.example.com",
        state: "ready",
        accessAppId: null,
        accessAppAud: null,
        runningJobId: null,
        driftFindings: [],
      });
      mount();

      const card = await screen.findByTestId("exposure-summary");
      expect(await within(card).findByText("jellyfin.example.com")).toBeTruthy();
      expect(within(card).getByText("ready")).toBeTruthy();
      expect(card.getAttribute("href")).toBe("/apps/jellyfin/exposure");
    });

    it("says 'Not exposed' rather than leaving the card blank when the app has no exposure", async () => {
      stubExposure({ exposed: false, runningJobId: null });
      mount();

      const card = await screen.findByTestId("exposure-summary");
      expect(await within(card).findByText("Not exposed")).toBeTruthy();
    });

    it("carries a distinct accessible name from the nav's own Exposure tab link", async () => {
      // Both the nav's tab link and this rail card could otherwise read as plain
      // "Exposure" to assistive tech (and to `getByRole`), which would make the two
      // links on this page indistinguishable by name.
      stubFetch(app);
      mount();
      const navExposureLink = within(
        screen.getByRole("navigation", { name: "App sections" }),
      ).getByRole("link", { name: "Exposure" });
      expect(navExposureLink).toBeTruthy();
      expect(screen.getByRole("link", { name: "Exposure summary" })).toBeTruthy();
    });

    it("is absent on mobile widths, matching the metadata card's own treatment", async () => {
      stubFetch(app);
      mount();
      const card = await screen.findByTestId("exposure-summary");
      expect(card.className).toContain("hidden");
      expect(card.className).toContain("lg:flex");
    });
  });
});
