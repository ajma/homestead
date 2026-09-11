// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { adminAppsKey } from "@web/api/admin";
import { AdminApps } from "@web/routes/AdminApps";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const app = (over: Partial<AdminApp> = {}): AdminApp => ({
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: null,
  iconRef: null,
  category: "Media",
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
  ...over,
});

function mount(seed?: AdminApp[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) client.setQueryData(adminAppsKey, seed);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminApps />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AdminApps", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([app()]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  it("lists each app with its status and directory", async () => {
    mount([app()]);
    expect(screen.getByText("Jellyfin")).toBeTruthy();
    expect(screen.getByText(/jellyfin/)).toBeTruthy();
  });

  it("links each row to that app's edit page by slug", async () => {
    mount([app({ slug: "jellyfin" })]);
    expect(screen.getByRole("link", { name: /Jellyfin/ }).getAttribute("href")).toBe(
      "/apps/jellyfin",
    );
  });

  it("renders cached rows immediately rather than a spinner", () => {
    mount([app({ displayName: "Cached" })]);
    // Deliberately synchronous and unawaited: the property under test is that the row
    // is there in the very first render, straight from the cache, before any fetch
    // could possibly have resolved. `queryByText(/Loading/)` would pass here whether or
    // not cache-first rendering worked — nothing in this component ever renders that
    // word — so it asserted nothing. See the binding-check report for a demonstration.
    expect(screen.getByText("Cached")).toBeTruthy();
  });

  it("keeps showing cached rows when a background refetch fails", async () => {
    // The same defect the launcher shipped and had to fix: `isError` alone throws away
    // rows that are still in hand.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(adminAppsKey, [app({ displayName: "Still here" })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AdminApps />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await client.invalidateQueries({ queryKey: adminAppsKey }).catch(() => {});
    // TanStack Query's notifyManager schedules the re-render via `setTimeout(fn, 0)`
    // (a macrotask), while the `invalidateQueries` await above only unblocks on
    // microtasks. Without this tick, `waitFor`'s first (synchronous) check would see
    // the pre-refetch DOM and pass immediately — true regardless of whether the error
    // branch is written correctly, which is not a binding test of the fix.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.getByText("Still here")).toBeTruthy());
  });

  it("shows an error only when there is nothing cached to show", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    mount();
    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeTruthy());
  });

  it("shows an empty state with both entry points when there are no apps", async () => {
    mount([]);
    await waitFor(() => expect(screen.getByText(/No apps yet/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Adopt from disk/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create app/ })).toBeTruthy();
  });

  it("marks a system app so it cannot be mistaken for one of yours", async () => {
    mount([app({ isSystem: true, displayName: "cloudflared" })]);
    expect(screen.getByText(/System/)).toBeTruthy();
  });

  it("shows when an app is hidden from the launcher", async () => {
    mount([app({ showOnLauncher: false })]);
    expect(screen.getByText(/Hidden/)).toBeTruthy();
  });

  it("says 'Never' under Last deploy for an app that has never been deployed", async () => {
    mount([app({ lastDeployAt: null })]);
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("shows the age of the most recent deploy when there is one", async () => {
    const now = Math.floor(Date.now() / 1000);
    mount([app({ lastDeployAt: now - 60 })]);
    expect(screen.getByText(/1m ago/)).toBeTruthy();
  });

  it("does not claim a zero-services app is healthy", async () => {
    // `statusDetail` is null exactly when `statusFor` reports `unknown` — a probe that
    // never ran is not evidence of health, and the fallback must not say otherwise.
    mount([app({ status: "unknown", statusDetail: null })]);
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.getByText("Not checked yet")).toBeTruthy();
  });

  it("gives every row's status chip no button role, since there is no health panel here", async () => {
    mount([app()]);
    expect(screen.queryByRole("button", { name: /Show health details/ })).toBeNull();
  });
});
