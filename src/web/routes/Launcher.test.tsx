// @vitest-environment jsdom
import type { LauncherApp } from "@shared/launcher";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { launcherKey } from "@web/api/launcher";
import { Launcher } from "@web/routes/Launcher";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tile = (over: Partial<LauncherApp> = {}): LauncherApp => ({
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: "Media server",
  iconRef: null,
  category: "Media",
  launchUrl: "http://nas:8096",
  sortOrder: 0,
  status: "up",
  reason: "Healthy",
  since: null,
  probes: [],
  ...over,
});

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Launcher />
    </QueryClientProvider>,
  );
}

function client(seed?: LauncherApp[]) {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) c.setQueryData(launcherKey, seed);
  return c;
}

describe("Launcher", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ apps: [tile()] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  it("renders cached tiles immediately instead of a spinner", async () => {
    // Spec: "Launcher renders from cached data first; stale status beats a spinner."
    mount(client([tile({ displayName: "Cached App" })]));
    expect(screen.getByText("Cached App")).toBeTruthy();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  it("groups tiles by category with a heading per group", async () => {
    mount(
      client([
        tile({ id: "a1", displayName: "Jellyfin", category: "Media" }),
        tile({ id: "a2", displayName: "Gitea", category: "Dev" }),
      ]),
    );
    expect(screen.getByRole("heading", { name: "Media" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
  });

  it("filters on display name as the user types", async () => {
    mount(
      client([
        tile({ id: "a1", displayName: "Jellyfin" }),
        tile({ id: "a2", displayName: "Gitea", category: "Dev" }),
      ]),
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "git" } });
    expect(screen.queryByText("Jellyfin")).toBeNull();
    expect(screen.getByText("Gitea")).toBeTruthy();
  });

  it("also matches on description, since that is where a purpose is written", async () => {
    mount(client([tile({ displayName: "Jellyfin", description: "Watch films" })]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "films" } });
    expect(screen.getByText("Jellyfin")).toBeTruthy();
  });

  it("tells the user nothing matched rather than showing a blank screen", async () => {
    mount(client([tile()]));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(screen.getByText(/No apps match/)).toBeTruthy();
  });

  it("shows an empty state when there are no apps at all", async () => {
    mount(client([]));
    await waitFor(() => expect(screen.getByText(/No apps yet/)).toBeTruthy());
  });

  it("shows an error state instead of an empty grid when the fetch fails", async () => {
    // An empty grid and a broken server look identical to a user, and one of them is
    // something they can act on. This is the case with nothing cached: `isLoadingError`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    mount(client());
    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeTruthy());
  });

  it("keeps showing the cached grid, with a stale note, when a background refetch fails", async () => {
    // The reconnect path makes this common, not exotic: the event stream invalidates
    // this query on every reconnect, and the server closes streams every 15 minutes and
    // on every user edit. TanStack Query keeps `data` across a failed refetch — the
    // grid must survive that, unlike a genuine `isLoadingError` with nothing cached.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    mount(client([tile({ displayName: "Cached App" })]));

    await waitFor(() => expect(screen.getByText(/couldn.t refresh/i)).toBeTruthy());
    expect(screen.getByText("Cached App")).toBeTruthy();
    expect(screen.queryByText(/Could not load your apps/)).toBeNull();
  });

  it("does not clear what the user was typing when a background refetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    mount(client([tile({ displayName: "Cached App" })]));

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cach" } });
    await waitFor(() => expect(screen.getByText(/couldn.t refresh/i)).toBeTruthy());
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("cach");
    expect(screen.getByText("Cached App")).toBeTruthy();
  });

  it("opens the health panel for the tile whose chip was tapped, not just any app", async () => {
    // Mounting a single app cannot fail for the right reason: there is nothing else the
    // panel could have opened. Two apps, and asserting on which one, closes that gap.
    mount(
      client([
        tile({ id: "a1", displayName: "Jellyfin", category: "Media" }),
        tile({ id: "a2", displayName: "Gitea", category: "Dev" }),
      ]),
    );

    const giteaLink = screen.getByRole("link", { name: /Gitea/ });
    const giteaCard = giteaLink.parentElement as HTMLElement;
    fireEvent.click(within(giteaCard).getByRole("button", { name: /Show health details/ }));

    await waitFor(() => expect(screen.getByRole("dialog", { name: /Gitea/ })).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: /Jellyfin/ })).toBeNull();
  });
});
