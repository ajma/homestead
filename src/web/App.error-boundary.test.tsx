// @vitest-environment jsdom

import type { AdminApp } from "@shared/dto";
import { SETUP_STEPS } from "@shared/setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "@web/App";
import type { Me } from "@web/auth/useSession";
import { afterEach, describe, expect, it, vi } from "vitest";

// A separate file from `App.test.tsx` on purpose: `vi.mock` is hoisted to the top of
// whatever file calls it and applies to every test in that file, so making this one
// module throw here would otherwise poison `App.test.tsx`'s own "fetches compose data
// once the compose tab is the one open" test, which needs the REAL `ComposeTab` to mount
// far enough to render `.cm-editor`. Isolating the throwing mock to its own file is what
// lets both exist.
vi.mock("@web/routes/edit/ComposeTab", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

// jsdom has no EventSource, and `AppLayout` opens one (`useEventStream`) on every route
// it wraps — same double `App.test.tsx` uses, needed here for the same reason.
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
  runningJobId: null,
};

function stubMe() {
  const me: Me = {
    id: "u1",
    email: "person@example.com",
    name: "Person",
    role: "admin",
    scopeAllApps: true,
    appIds: [],
  };
  const apps = [jellyfin];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/me")) return json(200, me);
      // This suite assumes a fully onboarded instance — the setup route guard has its
      // own tests in App.test.tsx.
      if (url.includes("/api/setup/state")) {
        return json(200, { completedSteps: [...SETUP_STEPS], completedAt: 1_800_000_000 });
      }
      if (url.includes("/api/launcher")) return json(200, { apps: [] });
      if (url.includes("/containers")) return json(200, { containers: [], dockerReachable: true });
      if (url.endsWith("/api/apps")) return json(200, apps);
      const singleAppMatch = /\/api\/apps\/([^/]+)$/.exec(url);
      if (singleAppMatch) {
        const key = singleAppMatch[1];
        const found = apps.find((candidate) => candidate.id === key || candidate.slug === key);
        return found ? json(200, found) : json(404, { error: "not_found" });
      }
      return json(200, []);
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("the lazy editor's error boundary", () => {
  it("keeps the rest of the admin UI mounted when a lazy editor chunk fails to load, and offers a retry", async () => {
    // Important from the final review: `React.lazy` had no error boundary ANYWHERE above
    // it (confirmed by grep) when this bundle split shipped. A chunk that fails to
    // load — a deploy landing mid-session, the NAS dropping off the network — threw
    // uncaught inside `Suspense` and unmounted the entire root: not the route, the whole
    // admin UI, with no way back but a full reload.
    stubMe();
    window.history.pushState({}, "", "/apps/jellyfin/compose");
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    render(<App />);

    // The boundary caught it — the failure is scoped to the tab content, reported as an
    // alert rather than a blank page.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/failed to load/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    // Everything OUTSIDE that one tab's content survived: the app shell rendered far
    // enough to show the edit page's own tab nav, and it is still fully interactive —
    // proof the whole root did not unmount out from under it.
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Containers" })).toBeTruthy();
    expect(screen.getByText("Jellyfin")).toBeTruthy();
  });
});
