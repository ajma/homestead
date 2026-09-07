import type { DeviceSummary } from "@shared/monitoring.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { Devices } from "./Devices.js";

afterEach(() => vi.unstubAllGlobals());

function device(over: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: "dev-1",
    name: "iPhone",
    kind: "phone",
    hidden: false,
    tailscaleNodeId: "n123",
    connectedToControl: false,
    lastSeen: Date.now() - 3600000, // 1 hour ago
    os: "iOS",
    status: { state: "up", reason: null },
    ...over,
  };
}

function stubDevices(devices: DeviceSummary[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/devices") {
      return new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
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

function renderDevices() {
  const client = createQueryClient({ retryDelay: 0 });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/devices"]}>
          <Routes>
            <Route path="/devices" element={<Devices />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("Devices", () => {
  it("renders a device with its status dot and Tailscale state", async () => {
    stubDevices([
      device({
        name: "iPhone",
        lastSeen: Date.now() - 3600000,
        status: { state: "up", reason: null },
      }),
    ]);
    renderDevices();

    const row = await screen.findByText("iPhone");
    expect(row).toBeInTheDocument();
    expect(screen.getByText("up")).toBeInTheDocument();
    // Should show relative time like "1 hour ago"
    expect(screen.getByText(/hour ago/i)).toBeInTheDocument();
  });

  it("shows 'connected' for an online device rather than a last-seen time", async () => {
    // Tailscale omits lastSeen entirely while a device is online
    stubDevices([
      device({
        name: "MacBook",
        connectedToControl: true,
        lastSeen: null,
      }),
    ]);
    renderDevices();

    await screen.findByText("MacBook");
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/ago/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/never/i)).not.toBeInTheDocument();
  });

  it("hides hidden devices behind a toggle", async () => {
    stubDevices([
      device({ id: "dev-1", name: "iPhone", hidden: false }),
      device({ id: "dev-2", name: "Old Laptop", hidden: true }),
    ]);
    renderDevices();

    await screen.findByText("iPhone");
    expect(screen.queryByText("Old Laptop")).not.toBeInTheDocument();

    // Click the toggle to show hidden devices
    const toggle = screen.getByRole("radiogroup");
    const showAllButton = within(toggle).getByRole("radio", { name: /all/i });
    fireEvent.click(showAllButton);

    expect(await screen.findByText("Old Laptop")).toBeInTheDocument();
  });

  it("renders the refusal state for a 403", async () => {
    const fetchMock = stubFailure(403, "forbidden");
    renderDevices();

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("explains that no Tailscale key is configured in the empty state", async () => {
    stubDevices([]);
    renderDevices();

    expect(await screen.findByText(/no devices/i)).toBeInTheDocument();
    expect(
      screen.getByText(/configure your tailscale api token/i),
    ).toBeInTheDocument();
  });

  it("posts the settings form and reports device count", async () => {
    let devices: DeviceSummary[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === "/api/devices") {
        return new Response(JSON.stringify({ devices }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/settings/tailscale" && opts?.method === "POST") {
        devices = [device({ name: "iPhone" })];
        return new Response(JSON.stringify({ deviceCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDevices();

    // Initially empty
    await screen.findByText(/no devices/i);

    // Open settings form
    const configureButton = screen.getByRole("button", {
      name: /configure/i,
    });
    fireEvent.click(configureButton);

    // Fill form
    const tailnetInput = await screen.findByLabelText(/tailnet/i);
    const tokenInput = screen.getByLabelText(/token/i);
    fireEvent.change(tailnetInput, { target: { value: "example.ts.net" } });
    fireEvent.change(tokenInput, { target: { value: "tskey-secret" } });

    // Submit
    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);

    // Should show success message with device count
    expect(await screen.findByText(/1 device/i)).toBeInTheDocument();
  });

  it("renders a down device with the danger tint", async () => {
    stubDevices([
      device({
        name: "Offline NAS",
        status: { state: "down", reason: "tailscale check failed" },
      }),
    ]);
    renderDevices();

    await screen.findByText("Offline NAS");
    const dangerDot = document.querySelector(".bg-danger");
    expect(
      dangerDot,
      "a down device must render with bg-danger, not bg-muted",
    ).toBeInTheDocument();
  });
});
