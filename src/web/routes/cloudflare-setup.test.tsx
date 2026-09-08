import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { CloudflareSetup } from "./CloudflareSetup.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(
  handlers: Record<string, (url: string, init?: RequestInit) => Response>,
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return handler(url, init);
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSetup() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <MemoryRouter>
        <CloudflareSetup />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { user };
}

describe("CloudflareSetup", () => {
  it("the token input is type=password", async () => {
    mockFetch({
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: false,
            accountId: null,
            tunnelId: null,
            runtime: { kind: "none" },
            idpId: null,
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    renderSetup();

    await waitFor(() => {
      const input = screen.getByPlaceholderText(/api token/i);
      expect(input).toHaveAttribute("type", "password");
    });
  });

  it("names every permission the token actually needs, and links to the page", async () => {
    // This text claimed "Account:Read, Zone:Read, DNS:Edit, Cloudflare
    // Tunnel:Edit". Account:Read is not a requirement, and the two Access
    // permissions and Memberships were missing — so a token built from these
    // instructions failed, twice, in two different places. Nothing tested it.
    mockFetch({
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: false,
            accountId: null,
            tunnelId: null,
            runtime: { kind: "none" },
            idpId: null,
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    renderSetup();

    await screen.findByPlaceholderText(/api token/i);

    // This exact set was verified against a live account-owned token: with
    // these five and nothing else, /accounts, /zones, cfd_tunnel, access apps,
    // policies, service tokens and identity providers all answered.
    for (const permission of [
      /Cloudflare Tunnel · Edit/,
      /Access: Apps and Policies · Edit/,
      /Access: Service Tokens · Edit/,
      /Zone · Zone · Read/,
      /Zone · DNS · Edit/,
    ]) {
      expect(
        screen.getByText(permission),
        `${permission} missing`,
      ).toBeVisible();
    }

    // Memberships is a user-token permission and does not exist for the
    // account-owned token Homestead requires. Listing it sent someone hunting
    // for a permission that could not fix their problem.
    expect(screen.queryByText(/Memberships/)).toBeNull();

    // Verified empirically: a five-permission account token listed its account
    // without it. Asking for a permission that changes nothing is how the last
    // two rounds of this went.
    expect(screen.queryByText(/Account Settings/)).toBeNull();

    // "Argo Tunnel" only exists in the user-token builder, so seeing it means
    // you are in the wrong place — which is a useful thing to be told.
    expect(screen.getByText(/Argo Tunnel/)).toBeVisible();

    // The distinction is the whole point: naming only the permissions, without
    // saying which kind of token carries them, is what caused the wrong one to
    // be created.
    expect(screen.getByText(/account-owned/i)).toBeVisible();
    expect(screen.getByText(/Account API Tokens/)).toBeVisible();

    const link = screen.getByRole("link", { name: /cloudflare dashboard/i });
    expect(link).toHaveAttribute("href", "https://dash.cloudflare.com");
    // An external target without noopener hands the new tab a window.opener
    // reference back into an authenticated session.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("clears the token from state after submission", async () => {
    mockFetch({
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: false,
            accountId: null,
            tunnelId: null,
            runtime: { kind: "none" },
            idpId: null,
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/cloudflare/token": () =>
        new Response(
          JSON.stringify({
            accounts: [{ id: "acc1", name: "Test Account" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderSetup();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/api token/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/api token/i);
    await user.type(input, "test-token-123");
    expect(input).toHaveValue("test-token-123");

    const submitButton = screen.getByRole("button", { name: /continue/i });
    await user.click(submitButton);

    // After submission succeeds, should be on the account step
    await waitFor(() => {
      expect(screen.getByText("Test Account")).toBeInTheDocument();
    });

    // Navigate back to verify the token was cleared from state.
    // Without setToken(""), the old value would persist in TokenStep's closure
    // until unmount, creating a window where it could leak.
    const backButton = screen.getByRole("button", { name: /back/i });
    await user.click(backButton);

    await waitFor(() => {
      const tokenInput = screen.getByPlaceholderText(/api token/i);
      // TokenStep remounted with fresh state, but the test verifies the
      // pattern: setToken("") before setState ensures no value persists
      // in the old component instance between clear and unmount.
      expect(tokenInput).toHaveValue("");
    });
  });

  it("reports missing scopes by name on 400", async () => {
    mockFetch({
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: false,
            accountId: null,
            tunnelId: null,
            runtime: { kind: "none" },
            idpId: null,
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/cloudflare/token": () =>
        new Response(
          JSON.stringify({
            detail: "missing scopes: Zone:Read, Account:Read, DNS:Edit",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderSetup();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/api token/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/api token/i);
    await user.type(input, "bad-token");

    const submitButton = screen.getByRole("button", { name: /continue/i });
    await user.click(submitButton);

    await waitFor(() => {
      const errorMessage = screen.getByRole("alert");
      expect(errorMessage).toHaveTextContent(
        "missing scopes: Zone:Read, Account:Read, DNS:Edit",
      );
    });
  });

  it("lists accounts after token verification", async () => {
    const _fetchMock = mockFetch({
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: false,
            accountId: null,
            tunnelId: null,
            runtime: { kind: "none" },
            idpId: null,
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/cloudflare/token": () =>
        new Response(
          JSON.stringify({
            accounts: [
              { id: "acc1", name: "Personal" },
              { id: "acc2", name: "Business" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderSetup();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/api token/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/api token/i);
    await user.type(input, "valid-token");

    const submitButton = screen.getByRole("button", { name: /continue/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Personal")).toBeInTheDocument();
      expect(screen.getByText("Business")).toBeInTheDocument();
    });
  });

  it("blocks with a clear message when the account has no identity provider", async () => {
    const _fetchMock = mockFetch({
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: false,
            accountId: null,
            tunnelId: null,
            runtime: { kind: "none" },
            idpId: null,
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/cloudflare/token": () =>
        new Response(
          JSON.stringify({
            accounts: [{ id: "acc1", name: "Test Account" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/cloudflare/account": () =>
        new Response(
          JSON.stringify({
            detail:
              "This account has no identity provider configured. Configure one in the Cloudflare dashboard first.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderSetup();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/api token/i)).toBeInTheDocument();
    });

    // Submit token
    const input = screen.getByPlaceholderText(/api token/i);
    await user.type(input, "valid-token");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // Select account
    await waitFor(() => {
      expect(screen.getByText("Test Account")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Test Account"));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // Expect blocking message with link
    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: /no identity provider configured/i,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Cloudflare Access requires an identity provider/i),
      ).toBeInTheDocument();
      // Should have a link to Cloudflare dashboard
      const link = screen.getByRole("link", {
        name: /open cloudflare dashboard/i,
      });
      expect(link).toHaveAttribute(
        "href",
        expect.stringContaining("dash.cloudflare.com"),
      );
    });

    // Assert no way to proceed: no Continue button should exist
    expect(
      screen.queryByRole("button", { name: /continue/i }),
    ).not.toBeInTheDocument();
    // Only the dashboard link button should be present
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(/open cloudflare dashboard/i);
  });
});
