import type { ScanEntry } from "@shared/projects.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "./ProjectList.js";

afterEach(() => vi.unstubAllGlobals());

function entry(over: Partial<ScanEntry> = {}): ScanEntry {
  return {
    slug: "jellyfin",
    path: "/srv/stacks/jellyfin",
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
  const client = new QueryClient({
    // Failures must surface inside the test rather than inside a backoff.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/projects"]}>
        <Routes>
          <Route path="/projects" element={<ProjectList />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

  it("shows the .env indicator only for projects that have one", async () => {
    stubProjects([
      entry({ slug: "jellyfin", hasEnv: true }),
      entry({
        slug: "paperless",
        path: "/srv/stacks/paperless",
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
        path: "/srv/stacks/downloads",
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
});
