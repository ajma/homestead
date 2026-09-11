// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { adminAppKey, adminAppsKey } from "@web/api/admin";
import { launcherKey } from "@web/api/launcher";
import type { EditAppContext } from "@web/routes/EditApp";
import { OverviewTab } from "@web/routes/edit/OverviewTab";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const app: AdminApp = {
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: "Media server",
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
};

function mount(seedApp: AdminApp = app) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/apps/jellyfin/overview"]}>
          <Routes>
            <Route
              path="/apps/:slug/*"
              element={<Outlet context={{ app: seedApp } satisfies EditAppContext} />}
            >
              <Route path="overview" element={<OverviewTab />} />
            </Route>
            <Route path="/apps" element={<p>APPS LIST</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

function ok(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function fails() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OverviewTab", () => {
  it("renders the app's current values", () => {
    mount();
    expect((screen.getByLabelText(/Display name/) as HTMLInputElement).value).toBe("Jellyfin");
    expect((screen.getByLabelText(/Description/) as HTMLTextAreaElement).value).toBe(
      "Media server",
    );
    expect((screen.getByLabelText(/Category/) as HTMLInputElement).value).toBe("Media");
    expect((screen.getByLabelText(/Show on launcher/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByText("jellyfin").length).toBeGreaterThan(0);
    expect(screen.getByText("compose.yaml")).toBeTruthy();
  });

  it("PATCHes only the fields that changed", async () => {
    ok(app);
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), {
      target: { value: "Jellyfin (renamed)" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/apps/a1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ displayName: "Jellyfin (renamed)" });
  });

  it("keeps the user's edits on screen when a save fails, rather than reverting them", async () => {
    fails();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), {
      target: { value: "Renamed while offline" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(screen.getByText(/Could not save/)).toBeTruthy());
    expect((screen.getByLabelText(/Display name/) as HTMLInputElement).value).toBe(
      "Renamed while offline",
    );
  });

  it("persists a showOnLauncher toggle, and invalidates admin keys but never the launcher's", async () => {
    ok(app);
    const { client } = mount();
    const spy = vi.spyOn(client, "invalidateQueries");

    fireEvent.click(screen.getByLabelText(/Show on launcher/));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ showOnLauncher: false });

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: adminAppKey("a1") }));
    expect(spy).toHaveBeenCalledWith({ queryKey: adminAppsKey });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: launcherKey });
    expect((screen.getByLabelText(/Show on launcher/) as HTMLInputElement).checked).toBe(false);
  });

  it("does not delete when the confirmation is cancelled", () => {
    ok(app);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();

    fireEvent.click(screen.getByRole("button", { name: /Delete app/ }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Jellyfin"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deletes and returns to the app list once the confirmation is accepted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();

    fireEvent.click(screen.getByRole("button", { name: /Delete app/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/apps/a1");
    expect(init.method).toBe("DELETE");
    await waitFor(() => expect(screen.getByText("APPS LIST")).toBeTruthy());
  });
});
