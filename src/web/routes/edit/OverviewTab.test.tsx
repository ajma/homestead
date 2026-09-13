// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  systemKind: null,
  showOnLauncher: true,
  sortOrder: 0,
  graceUntil: null,
  adoptedAt: 1_800_000_000,
  archivedAt: null,
  lastDeployAt: null,
  runningJobId: null,
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

function openAdvanced() {
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
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

  it("PATCHes systemKind: self when the checkbox is checked", async () => {
    ok(app);
    mount();
    openAdvanced();

    fireEvent.click(screen.getByLabelText(/This is Homestead itself/));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ systemKind: "self" });
  });

  it("PATCHes systemKind: null when an already-self app's checkbox is unchecked", async () => {
    const selfApp: AdminApp = { ...app, systemKind: "self" };
    ok(selfApp);
    mount(selfApp);
    openAdvanced();

    expect((screen.getByLabelText(/This is Homestead itself/) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByLabelText(/This is Homestead itself/));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ systemKind: null });
  });

  it("hides the self-override checkbox for the Cloudflare system app", () => {
    mount({ ...app, systemKind: "cloudflared" });
    openAdvanced();
    expect(screen.queryByLabelText(/This is Homestead itself/)).toBeNull();
  });

  it("shows a specific message when another app is already marked self", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "self_already_assigned" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    mount();
    openAdvanced();

    fireEvent.click(screen.getByLabelText(/This is Homestead itself/));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(screen.getByText(/Another app is already marked as Homestead itself/)).toBeTruthy(),
    );
  });

  it("names the app in the delete confirmation and does not delete when cancelled", () => {
    ok(app);
    mount();
    openAdvanced();

    fireEvent.click(screen.getByRole("button", { name: /Delete app/ }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Jellyfin/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deletes and returns to the app list once the confirmation is accepted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    mount();
    openAdvanced();

    fireEvent.click(screen.getByRole("button", { name: /Delete app/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/apps/a1");
    expect(init.method).toBe("DELETE");
    await waitFor(() => expect(screen.getByText("APPS LIST")).toBeTruthy());
  });

  it("clears the description to null rather than sending an empty string", async () => {
    ok(app);
    mount();

    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ description: null });
  });

  it("sends nothing when the description is edited and then reverted", () => {
    ok(app);
    mount();

    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "Temporary text" },
    });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "Media server" } });

    expect(screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled")).toBe(true);
  });

  it("clears the category to null rather than sending an empty string", async () => {
    ok(app);
    mount();

    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ category: null });
  });

  it("sends nothing when the category is edited and then reverted", () => {
    ok(app);
    mount();

    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: "Temporary" } });
    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: "Media" } });

    expect(screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled")).toBe(true);
  });

  it("clears the icon to null rather than leaving the field unset", async () => {
    ok(app);
    mount({ ...app, iconRef: "jellyfin" });

    fireEvent.click(screen.getByRole("button", { name: /Use a letter tile/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ iconRef: null });
  });

  it("sends nothing when the icon is cleared and then set back to the original", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/icons/search")) {
          return new Response(JSON.stringify({ icons: [{ slug: "jellyfin", aliases: [] }] }), {
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
    mount({ ...app, iconRef: "jellyfin" });

    fireEvent.click(screen.getByRole("button", { name: /Use a letter tile/ }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jelly" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^jellyfin$/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^jellyfin$/ }));

    expect(screen.getByRole("button", { name: /^Save$/ }).hasAttribute("disabled")).toBe(true);
  });

  it("caps the Display name input's width instead of letting it stretch full-width", () => {
    // The most visually broken item in the density survey: this input had no max-width
    // at all, so on a wide screen a single-line field ran nearly the full window.
    mount();
    expect(screen.getByLabelText(/Display name/).className).toContain("max-w-lg");
  });

  it("caps the Description textarea and Category input the same way", () => {
    mount();
    expect(screen.getByLabelText(/Description/).className).toContain("max-w-lg");
    expect(screen.getByLabelText(/Category/).className).toContain("max-w-lg");
  });

  it("tucks the self-marking checkbox and Danger zone behind a collapsed Advanced section", () => {
    mount();

    // Collapsed by default — neither control is reachable until expanded. This is a real
    // conditional render (not just CSS), so these queries correctly find nothing: jsdom
    // does not hide a closed <details>'s content from queries the way a real browser's UA
    // stylesheet would, which is why this section is a state-driven button instead.
    expect(screen.queryByLabelText(/This is Homestead itself/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete app/ })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Advanced" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    openAdvanced();

    // Expanding reveals both, self-marking first and Danger zone last.
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    screen.getByLabelText(/This is Homestead itself/);
    screen.getByRole("button", { name: /Delete app/ });
    const panel = toggle.parentElement as HTMLElement;
    const html = panel.innerHTML;
    expect(html.indexOf("This is Homestead itself")).toBeLessThan(html.indexOf("Danger zone"));
  });

  it("rotates the Advanced chevron via a Tailwind class when collapsed vs. expanded", () => {
    // jsdom has no layout engine, so a rendered angle can't be asserted — pinned as the
    // class string that encodes the state instead, the same way `ConfigTab.test.tsx`
    // asserts its own breakpoint switch rather than measured geometry.
    mount();
    const toggle = screen.getByRole("button", { name: "Advanced" });
    const chevron = toggle.querySelector("svg");
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
    expect(chevron?.getAttribute("class")).not.toContain("rotate-180");

    openAdvanced();

    expect(chevron?.getAttribute("class")).toContain("rotate-180");
  });

  it("puts the label beside the control at lg: and up, stacked below it", () => {
    // jsdom has no layout engine — pinned as the class strings that encode the decision,
    // the same way `ConfigTab.test.tsx` asserts its own breakpoint switch.
    mount();
    const row = screen.getByLabelText(/Display name/).closest("label");
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("lg:flex-row");
  });
});
