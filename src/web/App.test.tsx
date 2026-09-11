// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
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
      if (url.includes("/api/launcher")) return json(200, { apps: [] });
      if (url.includes("/containers")) return json(200, { containers: [], dockerReachable: true });
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
