// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { SETUP_STEPS, type SetupState } from "@shared/setup.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App, queryClient } from "@web/App";
import type { Me } from "@web/auth/useSession";
import { PAGE_MAX_WIDTH } from "@web/lib/density";
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

  it("sends a viewer away from the config deep url", async () => {
    // The Config tab is the heaviest thing this phase ships — a whole CodeMirror
    // instance, an 86 KB vendored schema, a `docker compose config` spawn on load, and
    // the `.env` editor alongside it. A viewer must never reach it by URL, bookmark or
    // otherwise, even though the guard that stops them lives one level up in `App.tsx`'s
    // route tree, not in the tab itself.
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/config");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Config" })).toBeNull();
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("sends a viewer away from the old compose deep url too", async () => {
    // `/compose` now just redirects to `/config` (see `RedirectToConfig` in `App.tsx`,
    // kept so an old bookmark still lands somewhere real) — but the guard sits above both
    // the redirect and the real tab, on `/apps/:slug` itself, so a viewer must still never
    // reach this legacy URL either.
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/compose");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("sends a viewer away from the old env deep url too", async () => {
    // `.env` holds secrets on top of everything else Config needs guarding against —
    // this is the URL the viewer premise ("hand a housemate a link without thinking
    // about it") most depends on staying closed, old redirect or not.
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/env");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("sends a viewer away from the logs deep url", async () => {
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/logs");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Logs" })).toBeNull();
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("sends a viewer away from the probes deep url", async () => {
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/probes");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Probes" })).toBeNull();
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("sends a viewer away from the exposure deep url", async () => {
    // 2F Task 3: the exposure tab is a new admin surface, and the viewer boundary is
    // proved by navigation, not by link visibility — Phase 1G's own lesson, applied to
    // the one tab this phase adds. Breaking the `isAdmin` guard for `/apps/:slug/*`
    // would fail this the same way it fails every sibling test above.
    stubMe({ role: "viewer" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/exposure");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Exposure" })).toBeNull();
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("sends a viewer away from settings", async () => {
    // `/settings` has no per-app slug to guard, only the role check `App.tsx` applies
    // to the whole `/settings/*` subtree — the same claim as every route above, made
    // against the one admin surface that isn't nested under `/apps`.
    stubMe({ role: "viewer" });
    renderAt("/settings");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
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

  it("lets an admin reach settings", async () => {
    stubMe({ role: "admin" });
    renderAt("/settings");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy());
  });
});

describe("moving between edit tabs by clicking, not just visiting the URL directly", () => {
  // The bug as reported: from `/apps/metube/overview`, clicking the Exposure tab landed
  // on `/apps/metube/overview/exposure` instead of `/apps/metube/exposure`. Every test
  // above this one — and every test in `EditApp.test.tsx` — proves a tab renders once
  // `renderAt`/`mount` has already put the URL there directly; none of them click a
  // `<NavLink>` to get there, which is exactly the path a real user takes and the one
  // Phase 2D's own lesson says to test. `/apps/:slug/*` (before this fix) is a splat
  // route, and a *relative* `<Link>`/`<NavLink>` rendered by its element resolves
  // against the parent's matched pathname *including* the splat capture — so once any
  // tab is open, every relative tab link on the page, not only Exposure's, resolves
  // relative to the currently-open tab instead of the app root. This exercises that
  // claim against the real production route tree in `App.tsx`, through `createBrowserRouter`
  // and real `window.location`, the same way the browser itself resolves the link.
  it("lands on /apps/jellyfin/exposure when clicking Exposure from the overview tab", async () => {
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/overview");

    await waitFor(() => expect(screen.getByRole("link", { name: "Exposure" })).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: "Exposure" }));

    await waitFor(() => expect(window.location.pathname).toBe("/apps/jellyfin/exposure"));
  });

  it("lands on /apps/jellyfin/containers when clicking Containers from the overview tab", async () => {
    // Not the tab the user named — proving the fix (and, before it, the break) is not
    // specific to Exposure but applies to every sibling tab alike.
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/overview");

    await waitFor(() => expect(screen.getByRole("link", { name: "Containers" })).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: "Containers" }));

    await waitFor(() => expect(window.location.pathname).toBe("/apps/jellyfin/containers"));
  });

  it("lands on /apps/jellyfin/overview when clicking Overview from a non-overview tab", async () => {
    // The reverse direction, and a starting tab other than the one the bug report named
    // — the splat capture is nonempty from any tab, not only `overview`.
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/containers");

    await waitFor(() => expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: "Overview" }));

    await waitFor(() => expect(window.location.pathname).toBe("/apps/jellyfin/overview"));
  });

  it("lands on /apps/jellyfin/exposure when clicking Exposure from the config tab", async () => {
    // Neither endpoint of this click is the pair the bug report named, and Config is the
    // one tab behind `React.lazy` — proving the fix holds for a lazy-loaded starting tab
    // too, not only the eagerly-rendered ones above.
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    const { container } = renderAt("/apps/jellyfin/config");

    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: "Exposure" }));

    await waitFor(() => expect(window.location.pathname).toBe("/apps/jellyfin/exposure"));
  });
});

describe("an edit url with an unknown trailing segment", () => {
  // `/apps/:slug/*`'s splat used to make this segment harmless by construction: it
  // always matched the parent route, so a typo'd or stale trailing segment left the
  // app shell on screen with a blank tab body rather than losing the app entirely.
  // Dropping `/*` (the fix above) means this URL no longer matches `/apps/:slug` by
  // itself — without a child route to catch it, it would instead fall through to the
  // top-level `path="*"` catch-all a few lines below `/apps/:slug` in `App.tsx` and
  // bounce the whole app to `/`, losing the slug the user actually typed. The child
  // `<Route path="*" element={<RedirectToOverview />} />` added alongside the named
  // tabs is what keeps this landing back inside the same app instead.
  it("still lands inside the app, on its overview tab, rather than bouncing to the launcher", async () => {
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    renderAt("/apps/jellyfin/nonsense");

    await waitFor(() => expect(window.location.pathname).toBe("/apps/jellyfin/overview"));
    expect(screen.getByRole("heading", { name: /Jellyfin/ })).toBeTruthy();
  });
});

describe("the settings nav link", () => {
  it("shows an admin the settings link", async () => {
    stubMe({ role: "admin" });
    renderAt("/");

    await waitFor(() => expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy());
  });

  it("does not show a viewer the settings link", async () => {
    // The launcher premise ("a housemate sees status tiles and nothing else") starts
    // with what the nav bar offers — but this proves only the link's absence, not that
    // the route itself is closed. "sends a viewer away from settings" above, by
    // navigation, is the claim that actually matters.
    stubMe({ role: "viewer" });
    renderAt("/");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });
});

describe("the global header width", () => {
  // The other half of the report: "the global header ... needs the same width
  // restriction too". `AppLayout` (not the nonexistent `AppLayout.tsx` the report
  // guessed — this file, confirmed by reading it) renders the nav bar every route sits
  // under. Its `<header>` (the only one with implicit "banner" role here — `EditApp`'s
  // own header is nested inside `<main>`, which strips that role) must stay full-bleed
  // itself while its content lines up with `PAGE_MAX_WIDTH`, same as every page body.
  it("constrains the nav bar's content to PAGE_MAX_WIDTH while the bar itself stays full-bleed", async () => {
    stubMe({ role: "admin" });
    renderAt("/");

    const header = await screen.findByRole("banner");
    // The bar: no max-width class directly on it, so its background/border keep
    // spanning the full viewport.
    expect(header.className).not.toContain("max-w-");
    // Its content: the actual nav links and sign-out button live in one inner
    // container, capped and centred at the same token every page body uses.
    const inner = header.firstElementChild as HTMLElement;
    expect(inner.className).toContain("mx-auto");
    expect(inner.className).toContain(PAGE_MAX_WIDTH);
    expect(within(inner).getByText("Homestead")).toBeTruthy();
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

  it("fetches compose and env data once the config tab is the one open", async () => {
    // The mirror image of the test above: proves the assertion is actually discriminating
    // between tabs, not just observing that nothing in this harness ever calls
    // `/compose`/`/env`. Both fire together now, since `ConfigTab` mounts `ComposeTab` and
    // `EnvTab` side by side rather than one at a time.
    stubMe({ role: "admin" }, { apps: [jellyfin] });
    const { container } = renderAt("/apps/jellyfin/config");

    await waitFor(() => {
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const urls = calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes("/compose"))).toBe(true);
      expect(urls.some((url) => url.endsWith("/env"))).toBe(true);
    });
    // `ConfigTab` is loaded behind `React.lazy` now (Important 5 of the 1F final review,
    // carried forward when Compose and `.env` merged into one tab), so this test's own
    // render awaits the fallback and then the real chunk — without waiting for the actual
    // editor to mount, this test's own cleanup can unmount the tree while the lazy import
    // or the compose query is still settling, producing an update on an unmounted
    // component instead of proving anything about the next test.
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

  it("a completed install is not reopened by a step it never saw", async () => {
    // The migration hazard 2F Task 5 exists to close: `SETUP_STEPS` gained a fifth entry
    // ("cloudflare") between `import` and `users`, and the test VM's real `setup_state`
    // row was written before that step existed — `completedAt` is set, but
    // `completedSteps` is exactly the four-entry array from before this phase shipped,
    // with no `"cloudflare"` in it. An install that finished must not be dragged back
    // into onboarding just because a new incomplete step appeared in the allow-list.
    // `App.tsx` gates on `completedAt` alone (see `Routed`'s own comment), never on
    // whether `completedSteps` contains every currently-known step — this proves that
    // holds rather than assuming it, per Phase 1G's carry-forward.
    stubSetupGuard(
      {
        id: "u1",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        scopeAllApps: true,
        appIds: [],
      },
      { completedSteps: ["admin", "host", "import", "users"], completedAt: 1_800_000_000 },
    );
    renderAt("/setup");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: /Cloudflare/ })).toBeNull();
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

  it("sends a viewer straight to the launcher from a completed /setup, the same way as mid-setup", async () => {
    // The test above proves a viewer skips the wizard while setup is incomplete — this
    // proves the other half of the two-way guard doesn't accidentally reintroduce a
    // path in. `Routed` forces `setupComplete` to `true` for a viewer unconditionally
    // (`needsSetupCheck = !isViewer`), so `/setup` for a viewer is always resolved by
    // the completed branch's own hardcoded `<Navigate to="/" />` — the same rule that
    // sits beside the `isAdmin` checks for `/apps` and `/settings` — never by the
    // incomplete branch's catch-all. Same landing, same never-fetches assertion as the
    // mid-setup test, against the opposite `completedAt`, to prove that holds either way.
    stubSetupGuard(
      {
        id: "u2",
        email: "viewer@example.com",
        name: "Viewer",
        role: "viewer",
        scopeAllApps: true,
        appIds: [],
      },
      { completedSteps: [...SETUP_STEPS], completedAt: 1_800_000_000 },
    );
    renderAt("/setup");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((call) => String(call[0]).includes("/api/setup/state"))).toBe(false);
  });

  it("has TanStack's default retry behaviour in production, not silently disabled", () => {
    // Cheap and synchronous, and the reason the test below is allowed to turn retries
    // off for its own duration: this is what proves production never does. `App.tsx`'s
    // own `defaultOptions` sets only `refetchOnWindowFocus: false` — if a future change
    // added `retry: false` there, the test below couldn't catch it (turning retries off
    // only makes THAT test faster, not fail); this assertion is the one that would.
    expect(queryClient.getDefaultOptions().queries?.retry).not.toBe(false);
  });

  it("sends an unauthenticated visitor to Login, not the dead end, when setup-state 401s", async () => {
    // The window Critical 1 of the whole-branch review named: an admin exists (so
    // `/api/setup/state` now requires one, per `setup.ts:144`) but this particular
    // caller has no session — a second device, an expired cookie, a private window.
    // Both `/api/me` and `/api/setup/state` answer 401, which is genuinely
    // indistinguishable from "the server is broken" unless the guard treats an auth
    // failure as "needs a session" rather than "setup status unknown". Before the fix,
    // this combination rendered the same dead-end "Homestead is unavailable" screen as
    // a real 500, with no login form and no way back in.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/me")) return json(401, { error: "unauthenticated" });
        if (url.includes("/api/setup/state")) return json(401, { error: "unauthenticated" });
        if (url.includes("/api/setup/status")) return json(200, { needsSetup: false });
        return json(200, []);
      }),
    );

    // `useSession` already passes `retry: false` itself, but `useSetupState` does not —
    // without turning it off here too, a 401 that react-query treats as retryable would
    // leave this test waiting out real backoff delays before settling into `isError`.
    const defaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
    try {
      renderAt("/");

      await waitFor(() => expect(screen.getByText(/Sign in to continue/i)).toBeTruthy());
      expect(screen.queryByText(/Homestead is unavailable/i)).toBeNull();
    } finally {
      queryClient.setDefaultOptions(defaults);
    }
  });

  it("shows the retry screen, not a blank page, when the setup-state fetch fails", async () => {
    // The gap `SetupWizard.test.tsx` used to paper over: that file's own "does not
    // strand the user" test rendered `<SetupWizard>` in isolation, which passes
    // regardless of anything here, since `Routed` (below) gates on this same
    // `["setup-state"]` query before `<SetupWizard>` is ever mounted — by the time it
    // would render, the query has already succeeded. This is the actual path a failing
    // `/api/setup/state` takes in the real app: through `Routed`'s own retry screen,
    // not the wizard's.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/me")) return json(401, { error: "unauthenticated" });
        if (url.includes("/api/setup/state")) return json(500, { error: "boom" });
        return json(200, []);
      }),
    );

    // Still the real singleton `queryClient` from `App.tsx` and the real `Routed` route
    // tree — exported from `App.tsx` for exactly this reason — but with `retry` flipped
    // off for the duration of this one test, so the assertion below is about WHICH
    // screen a failure renders, not about waiting out react-query's real backoff to get
    // there. Restored in `finally` so every other test (and the "default retry
    // behaviour" test above/below it) keeps proving against the real production default.
    const defaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
    try {
      renderAt("/");
      await waitFor(() => expect(screen.getByText(/Homestead is unavailable/i)).toBeTruthy());
      expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
    } finally {
      queryClient.setDefaultOptions(defaults);
    }
  });
});
