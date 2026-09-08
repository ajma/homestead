import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell.js";

const signOut = vi.fn();

/** Records the order of the two teardown steps sign-out performs. */
const teardown: string[] = [];

/**
 * Every URL apiFetch has been asked for. AppShell owns a preflight query, so
 * rendering it reaches for the network; without this stub these tests would
 * make a real request.
 */
const fetched: string[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({ checks: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const preflightCalls = (): number =>
  fetched.filter((u) => u.includes("/api/preflight")).length;

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => {
      const navigate = actual.useNavigate();
      return (...args: unknown[]) => {
        teardown.push("navigate");
        return (navigate as (...a: unknown[]) => unknown)(...args);
      };
    },
  };
});

/** A client whose clear() announces itself, delegating to the real one. */
function recordingClient(): QueryClient {
  const client = new QueryClient();
  const clear = client.clear.bind(client);
  vi.spyOn(client, "clear").mockImplementation(() => {
    teardown.push("clear");
    clear();
  });
  return client;
}

vi.mock("../lib/auth-client.js", () => ({
  signOut: () => signOut(),
  useSession: () => ({ data: { user: { email: "admin@example.com" } } }),
}));

function renderShell(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<p>Dashboard page</p>} />
          </Route>
          <Route path="/login" element={<h1>Sign in</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openAccountMenu() {
  await userEvent.click(screen.getByRole("button", { name: "Account" }));
}

describe("AppShell sign-out", () => {
  beforeEach(() => {
    signOut.mockReset();
    localStorage.clear();
    teardown.length = 0;
    fetched.length = 0;
    stubFetch();
  });

  it("asks for nothing more once sign-out begins", async () => {
    // The failure this prevents is an aborted navigation, not a wrong render.
    // clear() makes every mounted observer refetch, and AppShell is still
    // mounted then — navigate() is a state update React has not flushed. That
    // refetch carries the revoked cookie, 401s, and apiFetch turns a 401 into
    // window.location.assign("/login"), killing whatever navigation is in
    // flight. It surfaced as a ~1-in-3 e2e failure two tests later.
    signOut.mockResolvedValue({ data: {}, error: null });
    const client = new QueryClient();
    renderShell(client);

    await screen.findByText("Dashboard page");
    const asked = preflightCalls();
    expect(asked, "should have asked while signed in").toBeGreaterThan(0);

    await openAccountMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(preflightCalls()).toBe(asked);
  });

  it("navigates away before clearing the cache", async () => {
    signOut.mockResolvedValue({ data: {}, error: null });
    const client = recordingClient();
    client.setQueryData(["projects"], ["media-server"]);
    renderShell(client);

    await openAccountMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    // Order matters: clearing first leaves any still-mounted data page to
    // re-fetch immediately with the cookie the server has just revoked, and
    // apiFetch answers that 401 with window.location.assign — a full page
    // reload in place of the SPA transition this is supposed to be.
    expect(teardown).toEqual(["navigate", "clear"]);
    expect(client.getQueryData(["projects"])).toBeUndefined();
  });

  it("clears the query cache so the next account cannot read this one's data", async () => {
    signOut.mockResolvedValue({ data: {}, error: null });
    const client = new QueryClient();
    client.setQueryData(["projects"], ["media-server"]);
    renderShell(client);

    await openAccountMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(client.getQueryData(["projects"])).toBeUndefined();
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
  });

  it("stays put and reports the failure when sign-out fails", async () => {
    signOut.mockResolvedValue({
      data: null,
      error: { message: "Network down" },
    });
    const client = new QueryClient();
    client.setQueryData(["projects"], ["media-server"]);
    renderShell(client);

    await openAccountMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
    // Still signed in: no navigation, and the cache is untouched.
    expect(screen.getByText("Dashboard page")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    expect(client.getQueryData(["projects"])).toEqual(["media-server"]);
  });

  it("does not carry a stale error into the next attempt", async () => {
    signOut.mockResolvedValue({
      data: null,
      error: { message: "Network down" },
    });
    renderShell(new QueryClient());

    await openAccountMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");

    await userEvent.keyboard("{Escape}");
    await openAccountMenu();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AppShell account menu", () => {
  beforeEach(() => {
    signOut.mockReset();
    localStorage.clear();
  });

  it("moves focus into the menu when it opens and back on Escape", async () => {
    renderShell(new QueryClient());

    await openAccountMenu();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("menuitem", { name: "Sign out" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account" })).toHaveFocus();
  });

  it("keeps the trigger's accessible name when the label is hidden on phones", () => {
    renderShell(new QueryClient());
    const trigger = screen.getByRole("button", { name: "Account" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
