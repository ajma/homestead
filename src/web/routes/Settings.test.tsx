// @vitest-environment jsdom
import type { HostCheck } from "@shared/setup.js";
import { SETUP_STEPS } from "@shared/setup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { App, queryClient } from "@web/App";
import type { Me } from "@web/auth/useSession";
import { Settings } from "@web/routes/Settings";
import { afterEach, describe, expect, it, vi } from "vitest";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const HEALTHY_HOST_CHECK: HostCheck = {
  composeRoot: "/srv/homestead/apps",
  docker: { ok: true, version: "27.3.1", apiVersion: "1.47", os: "linux", arch: "arm64" },
  preflight: { ok: true },
};

describe("Settings", () => {
  it("mounts the user manager", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/setup/host-check")) return json(200, HEALTHY_HOST_CHECK);
        return json(200, []);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Settings />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No users yet.")).toBeTruthy());
    expect(screen.getByText("Users")).toBeTruthy();
  });

  it("uses the shared page shell's width cap, not the old 1024px max-w-5xl, and the tightened section gap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/setup/host-check")) return json(200, HEALTHY_HOST_CHECK);
        return json(200, []);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <Settings />
      </QueryClientProvider>,
    );

    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain("max-w-[1680px]");
    expect(shell.className).not.toContain("max-w-5xl");
    expect(shell.className).toContain("space-y-6");
    expect(shell.className).toContain("md:space-y-4");
  });

  it("places Host check and Cloudflare side by side at lg: and up, leaving Users full width", async () => {
    // Host check and Cloudflare are short fact-and-action panels; Users is a genuine
    // table and stays out of the grid, full width, below it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/setup/host-check")) return json(200, HEALTHY_HOST_CHECK);
        return json(200, []);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Settings />
      </QueryClientProvider>,
    );

    const hostHeading = screen.getByRole("heading", { name: "Host check" });
    const cloudflareHeading = screen.getByRole("heading", { name: "Cloudflare" });
    const grid = hostHeading.closest("section")?.parentElement;
    expect(grid?.className).toContain("lg:grid-cols-2");
    expect(cloudflareHeading.closest("section")?.parentElement).toBe(grid);

    const usersHeading = await screen.findByText("Users");
    expect(usersHeading.closest("section")?.parentElement).not.toBe(grid);
  });

  it("mounts the host check panel, reused from setup, with no wizard footer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/setup/host-check")) return json(200, HEALTHY_HOST_CHECK);
        return json(200, []);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Settings />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("/srv/homestead/apps")).toBeTruthy());
    expect(screen.getByText("27.3.1")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Re-check/ })).toBeTruthy();
    // The wizard's own Continue/Skip chrome must not leak into Settings — there is no
    // step to complete here, only a check to re-run.
    expect(screen.queryByRole("button", { name: /Continue/ })).toBeNull();
  });
});

// jsdom has no EventSource, and `AppLayout` opens one (`useEventStream`) on every route
// it wraps — same double as `App.test.tsx`'s own guard tests; this file never needs to
// emit through it, only to keep the real `<App>` tree from throwing on mount.
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

function stubMe(me: Me) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/me")) return json(200, me);
      if (url.includes("/api/setup/state")) {
        return json(200, { completedSteps: [...SETUP_STEPS], completedAt: 1_800_000_000 });
      }
      if (url.includes("/api/launcher")) return json(200, { apps: [] });
      if (url.includes("/api/setup/host-check")) return json(200, HEALTHY_HOST_CHECK);
      if (url.endsWith("/api/apps")) return json(200, []);
      if (url.endsWith("/api/users")) return json(200, []);
      return json(200, []);
    }),
  );
}

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  // The real singleton persists for the lifetime of this module — without clearing it,
  // a later test's `/api/me` stub would be masked by an earlier test's cached role
  // (30s `staleTime`), making the guard itself untestable. Same reasoning as
  // `App.test.tsx`'s own `renderAt`.
  queryClient.clear();
  return render(<App />);
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

/**
 * The viewer premise is a URL you can hand a housemate without thinking about it — that
 * is only actually proved by navigating a real router to `/settings` and checking where
 * a viewer lands, not by asserting `AppLayout`'s nav link is absent (which says nothing
 * about what happens if the URL is typed in directly, or bookmarked). This exercises the
 * real `<App>` route tree, the same way `App.test.tsx`'s own "admin route guard" tests
 * do for `/apps`.
 */
describe("the settings route guard", () => {
  it("sends a viewer away from settings, by navigation to the URL", async () => {
    stubMe({
      id: "u2",
      email: "viewer@example.com",
      name: "Viewer",
      role: "viewer",
      scopeAllApps: true,
      appIds: [],
    });
    renderAt("/settings");

    // Proves where the viewer actually landed — the launcher — not merely that the
    // settings page's own text is missing, which a broken page or a stuck spinner
    // would also satisfy.
    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Users")).toBeNull();
  });

  it("sends a viewer away from a deep settings url too", async () => {
    stubMe({
      id: "u2",
      email: "viewer@example.com",
      name: "Viewer",
      role: "viewer",
      scopeAllApps: true,
      appIds: [],
    });
    renderAt("/settings/users");

    await waitFor(() => expect(screen.getByLabelText("Search apps")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });

  it("lets an admin reach settings and see the user manager", async () => {
    stubMe({
      id: "u1",
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      scopeAllApps: true,
      appIds: [],
    });
    renderAt("/settings");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("No users yet.")).toBeTruthy());
    expect(screen.getByText("Users")).toBeTruthy();
  });
});
