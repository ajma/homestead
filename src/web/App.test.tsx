// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { SETUP_STEPS, type SetupState } from "@shared/setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import { App, queryClient } from "@web/App";
import type { Me } from "@web/auth/useSession";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource, and `AppLayout` opens one (`useEventStream`) on every route
// it wraps — every route in this file, since the guard under test lives inside it. Same
// double as `ActionBar.test.tsx` and `useEventStream.test.tsx`; this file never needs to
// emit through it, only to keep mounting from throwing.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const jellyfin: AdminApp = {
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

/**
 * Routes every `fetch` this test's tree can make while exercising the guard: the
 * session (`/api/me`, what the guard branches on), the admin apps list (what `AdminApps`
 * and `EditApp`'s slug lookup both read), and the per-app subviews `EditApp`'s tabs and
 * right rail (`ActionBar`, `ImageUpdates`) fire off once mounted. None of those subviews'
 * exact shapes matter to what this file asserts — only that a legitimate admin render
 * doesn't crash reaching them — so everything not named explicitly falls back to `[]`.
 */
function stubMe(overrides: Partial<Me> = {}, extra: { apps?: AdminApp[] } = {}) {
  const me: Me = {
    id: "u1",
    email: "person@example.com",
    name: "Person",
    role: "viewer",
    scopeAllApps: true,
    appIds: [],
    ...overrides,
  };
  const apps = extra.apps ?? [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/me")) return json(200, me);
      // Every test in this file that reaches here predates the setup wizard and assumes
      // a fully onboarded instance — the setup route guard's own behaviour is exercised
      // separately, below, with its own fetch stub.
      if (url.includes("/api/setup/state")) {
        return json(200, { completedSteps: [...SETUP_STEPS], completedAt: 1_800_000_000 });
      }
      if (url.includes("/api/launcher")) return json(200, { apps: [] });
      if (url.includes("/containers")) return json(200, { containers: [], dockerReachable: true });
      // `ComposeTab`/`EnvTab` are loaded behind `React.lazy` now (Important 5 of the 1F
      // final review) — the "tab data-loading boundary" tests below actually let the
      // real components mount rather than the fetch merely being fired and abandoned, so
      // both need a response shaped the way the real endpoint answers, not the catch-all
      // `[]` below (which `ComposeTab` would otherwise happily destructure into
      // `content: undefined` and crash `lintYaml` on, well after the test that triggered
      // it has already finished and torn the tree down).
      if (url.endsWith("/compose/validate")) return json(200, { valid: true });
      if (url.endsWith("/compose")) return json(200, { content: "services: {}\n", hash: "h1" });
      if (url.endsWith("/env")) return json(200, { entries: [], exists: false });
      if (url.endsWith("/api/apps")) return json(200, apps);
      // `EditApp` resolves `:slug` through `GET /api/apps/:id`, which accepts a slug too
      // (Important 3 of the 1E final-fix brief) — a single-app object, not the list.
      const singleAppMatch = /\/api\/apps\/([^/]+)$/.exec(url);
      if (singleAppMatch) {
        const key = singleAppMatch[1];
        const found = apps.find((candidate) => candidate.id === key || candidate.slug === key);
        return found ? json(200, found) : json(404, { error: "not_found" });
      }
      // jobs, images, probes, the launcher list, and anything else this file doesn't
      // name explicitly — an empty array is the shape every one of those endpoints
      // returns when there is nothing to report.
      return json(200, []);
    }),
  );
}

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  // The real singleton persists for the lifetime of this module, across every render in
  // this file — without clearing it, the second test's `/api/me` would still see the
  // first test's cached role and never actually re-fetch (30s `staleTime`), which would
  // make the guard's own behaviour untestable rather than proven.
  queryClient.clear();
  return render(<App />);
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("the admin route guard", () => {
  it("sends a viewer away from the inventory", async () => {
    // The whole viewer premise is a URL you can hand a housemate. Every admin route must
    // be unreachable by navigation, not merely absent from the nav bar.
    stubMe({ role: "viewer" });
    renderAt("/apps");

    // Proves where the viewer actually landed — the launcher — not merely that the
    // admin page's own text is missing, which a broken page or a stuck spinner would
    // also satisfy.
    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Create app/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Adopt from disk/ })).toBeNull();
  });

  it("sends a viewer away from an edit page", async () => {
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/overview");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Containers" })).toBeNull();
  });

  it("sends a viewer away from a deep edit url, not just the top of /apps", async () => {
    // A stale bookmark to a specific tab is exactly the shape of URL a housemate could
    // have sitting around — the guard has to cover it, not just the bare `/apps/:slug`.
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/containers");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Containers" })).toBeNull();
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("sends a viewer away from the compose deep url", async () => {
    // The compose tab is the heaviest thing this phase ships — a whole CodeMirror
    // instance, an 86 KB vendored schema, and a `docker compose config` spawn on load.
    // A viewer must never reach it by URL, bookmark or otherwise, even though the guard
    // that stops them lives one level up in `App.tsx`'s route tree, not in the tab itself.
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/compose");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Compose" })).toBeNull();
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("sends a viewer away from the env deep url", async () => {
    // `.env` holds secrets on top of everything the compose tab already needs guarding
    // against — this is the URL the viewer premise ("hand a housemate a link without
    // thinking about it") most depends on staying closed.
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/env");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: ".env" })).toBeNull();
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("lets an admin reach both", async () => {
    stubMe({ role: "admin" });
    renderAt("/apps");

    await waitFor(() => expect(screen.getByRole("button", { name: /Create app/ })).toBeTruthy());
  });

  it("lets an admin reach a deep edit url", async () => {
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/containers");

    await waitFor(() => expect(screen.getByRole("link", { name: "Containers" })).toBeTruthy());
  });
});

describe("the tab data-loading boundary", () => {
  /**
   * Spec §8: "the compose file, container inspect data, and log stream load on demand
   * and close on navigate, rather than being produced because someone glanced at
   * status." This exercises the real routes with the real `ComposeTab`/`EnvTab` (unlike
   * `EditApp.test.tsx`, which uses stand-ins to test the routing shell in isolation) —
   * the concern named in this task is specifically that the real compose tab mounts a
   * whole CodeMirror instance, imports the vendored schema, and can spawn `docker
   * compose config`, so the thing worth proving here is that none of that happens
   * merely because the edit page is open on a different tab.
   */
  it("never fetches compose or env data while only the overview tab is open", async () => {
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/overview");

    await waitFor(() => expect(screen.getByRole("link", { name: "Containers" })).toBeTruthy());
    // TanStack's `notifyManager` can defer a query's actual fetch through a `setTimeout(0)`
    // that `act()` doesn't wait out on its own — flushing one real macrotask here closes
    // that gap, so an eagerly-mounted compose/env query gets a genuine chance to fire
    // before the assertion below treats its absence as proof rather than a false negative.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const urls = calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/compose"))).toBe(false);
    expect(urls.some((url) => url.includes("/env"))).toBe(false);
  });

  it("fetches compose data once the compose tab is the one open", async () => {
    // The mirror image of the test above: proves the assertion is actually discriminating
    // between tabs, not just observing that nothing in this harness ever calls `/compose`.
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    const { container } = renderAt("/apps/jellyfin/compose");

    await waitFor(() => {
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const urls = calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes("/compose"))).toBe(true);
    });
    // `ComposeTab` is loaded behind `React.lazy` now (Important 5 of the 1F final
    // review), so this test's own render awaits the fallback and then the real chunk —
    // without waiting for the actual editor to mount, this test's own cleanup can
    // unmount the tree while the lazy import or the compose query is still settling,
    // producing an update on an unmounted component instead of proving anything about
    // the next test.
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
  });
});

/**
 * `stubMe` above assumes a fully onboarded instance, which is right for every test
 * above it but wrong for these — the setup route guard is precisely the behaviour that
 * assumption would hide. `me: null` renders as a 401 from `/api/me`, matching how the
 * real endpoint answers when nobody is signed in yet, which is the state a fresh
 * install boots into.
 */
function stubSetupGuard(me: Me | null, setup: SetupState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/me")) {
        return me ? json(200, me) : json(401, { error: "unauthenticated" });
      }
      if (url.includes("/api/setup/state")) return json(200, setup);
      if (url.includes("/api/launcher")) return json(200, { apps: [] });
      return json(200, []);
    }),
  );
}

describe("the setup route guard", () => {
  it("pulls an anonymous visitor into the wizard while setup is incomplete", async () => {
    // The reverse guard: nobody has to be signed in yet for step 1, since a machine
    // with no users has no admin to authorise anything.
    stubSetupGuard(null, { completedSteps: [], completedAt: null });
    renderAt("/");

    await waitFor(() => expect(screen.getByRole("heading", { name: /Create admin/ })).toBeTruthy());
  });

  it("pulls a signed-in admin into the wizard too, not just an anonymous visitor", async () => {
    stubSetupGuard(
      {
        id: "u1",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        scopeAllApps: true,
        appIds: [],
      },
      { completedSteps: ["admin"], completedAt: null },
    );
    renderAt("/apps");

    // Landed on the wizard's own resume point, not the inventory it asked for.
    await waitFor(() => expect(screen.getByRole("heading", { name: /Verify host/ })).toBeTruthy());
  });

  it("pushes a completed setup off /setup and onto the launcher", async () => {
    // Completion is one-way: re-entering would offer "create the first admin" to a
    // second admin.
    stubSetupGuard(
      {
        id: "u1",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        scopeAllApps: true,
        appIds: [],
      },
      { completedSteps: [...SETUP_STEPS], completedAt: 1_800_000_000 },
    );
    renderAt("/setup");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
  });

  it("never sends a viewer into the wizard, even mid-setup", async () => {
    stubSetupGuard(
      {
        id: "u2",
        email: "viewer@example.com",
        name: "Viewer",
        role: "viewer",
        scopeAllApps: true,
        appIds: [],
      },
      { completedSteps: [], completedAt: null },
    );
    renderAt("/setup");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    // Not merely "landed elsewhere" — a viewer must never even ask. GET /api/setup/state
    // is admin-only once an admin exists, so calling it here would risk a viewer seeing
    // a spurious error screen instead of simply not needing the answer.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((call) => String(call[0]).includes("/api/setup/state"))).toBe(false);
  });
});
