import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell.js";

const signOut = vi.fn();

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
