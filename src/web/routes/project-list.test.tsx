import type { ScanEntry } from "@shared/projects.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, queryKeys } from "../lib/queries.js";
import { ProjectList } from "./ProjectList.js";

afterEach(() => vi.unstubAllGlobals());

function entry(over: Partial<ScanEntry> = {}): ScanEntry {
  return {
    slug: "jellyfin",
    hasCompose: true,
    hasEnv: false,
    composeFile: "compose.yaml",
    ...over,
  };
}

function stubProjects(projects: ScanEntry[]) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFailure(status: number, error: string) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ error }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderList() {
  // The app's own client — the refusal rules live on it. `retryDelay: 0` so a
  // failure surfaces inside the test rather than inside a backoff.
  const client = createQueryClient({ retryDelay: 0 });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/projects"]}>
          <Routes>
            <Route path="/projects" element={<ProjectList />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("ProjectList", () => {
  it("says where projects come from when there are none", async () => {
    // Covered here rather than in e2e: every e2e worker shares one projects
    // root, so an "the directory is empty" assertion races the other specs'
    // fixtures and forcing emptiness would delete them.
    stubProjects([]);
    renderList();
    expect(await screen.findByText(/HOMESTEAD_PROJECTS/)).toBeInTheDocument();
  });

  it("makes the whole row the link, not just the name", async () => {
    stubProjects([entry({ slug: "jellyfin", hasEnv: true })]);
    renderList();

    const link = await screen.findByRole("link", { name: /jellyfin/ });
    expect(link).toHaveAttribute("href", "/projects/jellyfin");
    // The status and the .env indicator sit inside the link, so the touch
    // target is the row: a 16px text link is not a touch target.
    expect(within(link).getByText(".env")).toBeInTheDocument();
    expect(within(link).getByText(/valid compose/i)).toBeInTheDocument();
  });

  it("does not spend the running tint on 'the compose file parses'", async () => {
    // This endpoint is a directory scan: it cannot know whether anything is
    // running (P3-R14). Drawing "valid compose" as the same green dot the
    // detail page uses for "running" makes thirty parseable projects read as
    // thirty running stacks.
    stubProjects([entry()]);
    renderList();

    const link = await screen.findByRole("link", { name: /jellyfin/ });
    expect(within(link).getByText(/valid compose/i)).toBeInTheDocument();
    expect(
      link.querySelector(".bg-success"),
      "the row claims a runtime state it cannot know",
    ).toBeNull();
  });

  it("shows the .env indicator only for projects that have one", async () => {
    stubProjects([
      entry({ slug: "jellyfin", hasEnv: true }),
      entry({
        slug: "paperless",
        hasEnv: false,
      }),
    ]);
    renderList();

    const withEnv = await screen.findByRole("link", { name: /jellyfin/ });
    const without = screen.getByRole("link", { name: /paperless/ });
    expect(within(withEnv).queryByText(".env")).toBeInTheDocument();
    expect(within(without).queryByText(".env")).not.toBeInTheDocument();
  });

  it("marks a directory with no compose file as not a project and does not link it", async () => {
    stubProjects([
      entry({
        slug: "downloads",
        hasCompose: false,
        composeFile: null,
      }),
    ]);
    renderList();

    expect(await screen.findByText("downloads")).toBeInTheDocument();
    expect(screen.getByText(/not a project/i)).toBeInTheDocument();
    // Linking it would lead to a detail view the server answers with 404.
    expect(
      screen.queryByRole("link", { name: /downloads/ }),
    ).not.toBeInTheDocument();
  });

  it("reports a refusal as a permission problem without hammering the server", async () => {
    // A viewer holds only app:read, so GET /api/projects is a 403 for them.
    const fetchMock = stubFailure(403, "forbidden");
    renderList();

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries a server error before reporting it", async () => {
    const fetchMock = stubFailure(500, "internal_error");
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not load/i,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("keeps the list on screen when a background refresh fails", async () => {
    // This query polls every 15 seconds. TanStack sets status "error" on a
    // failed *refetch* while keeping the last good data, so branching on the
    // error before the data empties a list the user is reading because one
    // poll lost the network — and fills it back in 15 seconds later.
    let healthy = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        healthy
          ? new Response(JSON.stringify({ projects: [entry()] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ error: "bad_gateway" }), {
              status: 502,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
    const { client } = renderList();
    expect(
      await screen.findByRole("link", { name: /jellyfin/ }),
    ).toBeInTheDocument();

    healthy = false;
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.projects });
    });
    // Said, rather than left for the user to notice their data is old.
    await screen.findByText(/could not refresh/i);

    expect(
      screen.getByRole("link", { name: /jellyfin/ }),
      "the row a failed poll must not delete",
    ).toBeInTheDocument();
    // And the blanking error is not also on screen.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
