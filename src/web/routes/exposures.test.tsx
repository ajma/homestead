import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { Exposures } from "./Exposures.js";

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

function renderExposures() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <MemoryRouter>
        <Exposures />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { user };
}

describe("Exposures", () => {
  it("renders a list of exposures with hostname and service name", async () => {
    mockFetch({
      "/api/exposures": () =>
        new Response(
          JSON.stringify({
            exposures: [
              {
                id: "1",
                projectSlug: "traefik",
                serviceName: "web",
                hostPort: 8080,
                hostname: "traefik.example.com",
                scheme: "https",
                noTlsVerify: false,
                label: null,
                enabled: true,
                accessEnabled: true,
              },
              {
                id: "2",
                projectSlug: "nginx",
                serviceName: "app",
                hostPort: 80,
                hostname: "nginx.example.com",
                scheme: "http",
                noTlsVerify: false,
                label: "Public API",
                enabled: false,
                accessEnabled: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: true,
            accountId: "acc123",
            tunnelId: "tun123",
            runtime: { kind: "deployed", projectSlug: "cloudflared" },
            idpId: "idp123",
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    renderExposures();

    await waitFor(() => {
      expect(screen.getByText("traefik.example.com")).toBeInTheDocument();
      expect(screen.getByText("nginx.example.com")).toBeInTheDocument();
      expect(screen.getByText("traefik / web")).toBeInTheDocument();
      expect(screen.getByText("Public API")).toBeInTheDocument();
    });
  });

  it("renders a refusal state on 403", async () => {
    mockFetch({
      "/api/exposures": () => new Response(null, { status: 403 }),
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: true,
            accountId: "acc123",
            tunnelId: "tun123",
            runtime: { kind: "deployed", projectSlug: "cloudflared" },
            idpId: "idp123",
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    renderExposures();

    await waitFor(() => {
      expect(screen.getByText("You do not have access")).toBeInTheDocument();
    });
  });

  it("distinguishes unconfigured Cloudflare from an empty list", async () => {
    mockFetch({
      "/api/exposures": () =>
        new Response(JSON.stringify({ exposures: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
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

    renderExposures();

    await waitFor(() => {
      expect(
        screen.getByText("Cloudflare Tunnel is not configured yet"),
      ).toBeInTheDocument();
    });
  });

  it("offers no Service field, which the server does not store", async () => {
    // There is no service_name column; GET /api/exposures always returns null
    // for it, derived instead from docker compose config at read time. The form
    // collected it and sent it anyway, so whatever was typed vanished without
    // a word. A field that ignores its input is worse than no field.
    mockFetch({
      "/api/exposures": () =>
        new Response(JSON.stringify({ exposures: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: true,
            accountId: "acc123",
            tunnelId: "tun123",
            runtime: { kind: "deployed", projectSlug: "cloudflared" },
            idpId: "idp123",
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderExposures();
    await user.click(await screen.findByRole("button", { name: /add/i }));

    expect(await screen.findByLabelText(/hostname/i)).toBeVisible();
    expect(screen.queryByLabelText(/^service/i)).toBeNull();
  });

  it("defaults the origin scheme to HTTP", async () => {
    // The origin is the service on this box, not the public URL — that is
    // always HTTPS via Cloudflare. Self-hosted apps on a host port almost
    // always speak plain HTTP, and the column default is "http", so defaulting
    // the form to HTTPS handed most people a 502 on their first exposure.
    mockFetch({
      "/api/exposures": () =>
        new Response(JSON.stringify({ exposures: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: true,
            accountId: "acc123",
            tunnelId: "tun123",
            runtime: { kind: "deployed", projectSlug: "cloudflared" },
            idpId: "idp123",
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderExposures();
    await user.click(await screen.findByRole("button", { name: /add/i }));
    await screen.findByLabelText(/hostname/i);

    const http = screen.getByRole("radio", { name: "HTTP" });
    expect(http).toBeChecked();
  });

  it("requires explicit confirmation to disable Access", async () => {
    mockFetch({
      "/api/exposures": () =>
        new Response(
          JSON.stringify({
            exposures: [
              {
                id: "1",
                projectSlug: "traefik",
                serviceName: "web",
                hostPort: 8080,
                hostname: "traefik.example.com",
                scheme: "https",
                noTlsVerify: false,
                label: null,
                enabled: true,
                accessEnabled: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: true,
            accountId: "acc123",
            tunnelId: "tun123",
            runtime: { kind: "deployed", projectSlug: "cloudflared" },
            idpId: "idp123",
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderExposures();

    await waitFor(() =>
      expect(screen.getByText("traefik.example.com")).toBeInTheDocument(),
    );

    // Click the edit button for the first exposure
    const editButton = screen.getAllByRole("button", { name: /edit/i })[0];
    if (!editButton) throw new Error("no edit button found");
    await user.click(editButton);

    // Find and toggle the Access checkbox
    const accessCheckbox = screen.getByLabelText(/require authentication/i);
    await user.click(accessCheckbox);

    // Save the changes
    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    // Expect a confirmation dialog naming the hostname and warning about public access
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    const confirmDialog = screen.getByRole("alertdialog");
    expect(confirmDialog).toHaveTextContent("traefik.example.com");
    expect(confirmDialog).toHaveTextContent(/public.*internet/i);
  });

  it("dismissing Access-off confirmation leaves it unchanged and issues no PATCH", async () => {
    const fetchMock = mockFetch({
      "/api/exposures": () =>
        new Response(
          JSON.stringify({
            exposures: [
              {
                id: "1",
                projectSlug: "traefik",
                serviceName: "web",
                hostPort: 8080,
                hostname: "traefik.example.com",
                scheme: "https",
                noTlsVerify: false,
                label: null,
                enabled: true,
                accessEnabled: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: true,
            accountId: "acc123",
            tunnelId: "tun123",
            runtime: { kind: "deployed", projectSlug: "cloudflared" },
            idpId: "idp123",
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderExposures();

    await waitFor(() =>
      expect(screen.getByText("traefik.example.com")).toBeInTheDocument(),
    );

    // Click edit
    const editButton = screen.getAllByRole("button", { name: /edit/i })[0];
    if (!editButton) throw new Error("no edit button found");
    await user.click(editButton);

    // Toggle Access off
    const accessCheckbox = screen.getByLabelText(/require authentication/i);
    await user.click(accessCheckbox);

    // Click Save - should show confirmation
    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    // Count PATCH calls before dismissal
    const patchCallsBefore = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url.includes("/api/exposures/1") && init?.method === "PATCH",
    ).length;

    // Click Cancel
    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelButton);

    // Dialog should close
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    // No PATCH should have been issued
    const patchCallsAfter = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url.includes("/api/exposures/1") && init?.method === "PATCH",
    ).length;
    expect(patchCallsAfter).toBe(patchCallsBefore);

    // Checkbox should still be checked (Access still enabled)
    const checkbox = screen.getByLabelText(/require authentication/i);
    expect(checkbox).toBeChecked();
  });

  it("confirming Access-off dialog issues PATCH with accessEnabled: false", async () => {
    const fetchMock = mockFetch({
      "/api/exposures": (url, init) => {
        if (url.includes("/api/exposures/1") && init?.method === "PATCH") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            exposures: [
              {
                id: "1",
                projectSlug: "traefik",
                serviceName: "web",
                hostPort: 8080,
                hostname: "traefik.example.com",
                scheme: "https",
                noTlsVerify: false,
                label: null,
                enabled: true,
                accessEnabled: true,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: true,
            accountId: "acc123",
            tunnelId: "tun123",
            runtime: { kind: "deployed", projectSlug: "cloudflared" },
            idpId: "idp123",
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderExposures();

    await waitFor(() =>
      expect(screen.getByText("traefik.example.com")).toBeInTheDocument(),
    );

    // Click edit
    const editButton = screen.getAllByRole("button", { name: /edit/i })[0];
    if (!editButton) throw new Error("no edit button found");
    await user.click(editButton);

    // Toggle Access off
    const accessCheckbox = screen.getByLabelText(/require authentication/i);
    await user.click(accessCheckbox);

    // Click Save - should show confirmation
    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });

    // Click the danger button to confirm
    const confirmButton = screen.getByRole("button", {
      name: /remove authentication/i,
    });
    await user.click(confirmButton);

    // Wait for the PATCH to be issued
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          url.includes("/api/exposures/1") && init?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
    });

    // Verify the PATCH body contains accessEnabled: false
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url.includes("/api/exposures/1") && init?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    if (patchCall) {
      const body = JSON.parse(patchCall[1]?.body as string);
      expect(body.accessEnabled).toBe(false);
    }

    // Dialog should close after successful save
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("renders adopt-or-overwrite prompt on conflict", async () => {
    mockFetch({
      "/api/exposures": (url) => {
        if (url === "/api/exposures/reconcile") {
          return new Response(
            JSON.stringify({
              detail: "tunnel has 2 ingress rules added outside Homestead",
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ exposures: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      "/api/cloudflare/status": () =>
        new Response(
          JSON.stringify({
            configured: true,
            accountId: "acc123",
            tunnelId: "tun123",
            runtime: { kind: "deployed", projectSlug: "cloudflared" },
            idpId: "idp123",
            syncState: "synced",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const { user } = renderExposures();

    await waitFor(() =>
      expect(screen.getByText(/no exposures yet/i)).toBeInTheDocument(),
    );

    // Click reconcile
    const reconcileButton = screen.getByRole("button", { name: /reconcile/i });
    await user.click(reconcileButton);

    // Expect the conflict message with adopt/overwrite choice
    await waitFor(() => {
      expect(
        screen.getByText(/2 ingress rules added outside Homestead/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /adopt/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /overwrite/i }),
      ).toBeInTheDocument();
    });
  });
});
