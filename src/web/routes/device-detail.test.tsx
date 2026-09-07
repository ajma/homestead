import type {
  DeviceSummary,
  HistoryBucket,
  MonitorSummary,
  UptimeWindow,
} from "@shared/monitoring.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/queries.js";
import { DeviceDetail } from "./DeviceDetail.js";

afterEach(() => vi.unstubAllGlobals());

function device(over: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: "dev-1",
    name: "iPhone",
    kind: "phone",
    hidden: false,
    tailscaleNodeId: "n123",
    connectedToControl: false,
    lastSeen: Date.now() - 3600000,
    os: "iOS",
    status: { state: "up", reason: null },
    ...over,
  };
}

function monitor(over: Partial<MonitorSummary> = {}): MonitorSummary {
  return {
    id: "mon-1",
    type: "tailscale",
    required: true,
    enabled: true,
    state: "up",
    lastCheckedAt: Date.now() - 60000,
    error: null,
    ...over,
  };
}

type DetailResponse = {
  device: DeviceSummary;
  monitors: MonitorSummary[];
  uptime: UptimeWindow[];
  history: HistoryBucket[];
};

function stubDetail(detail: DetailResponse) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/devices/dev-1") {
      return new Response(JSON.stringify(detail), {
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

function renderDeviceDetail() {
  const client = createQueryClient({ retryDelay: 0 });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/devices/dev-1"]}>
          <Routes>
            <Route path="/devices/:id" element={<DeviceDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("DeviceDetail", () => {
  it("renders the device name and monitors with their states", async () => {
    stubDetail({
      device: device({ name: "iPhone" }),
      monitors: [
        monitor({ id: "mon-1", type: "tailscale", state: "up" }),
        monitor({ id: "mon-2", type: "tcp", state: "down" }),
      ],
      uptime: [
        { windowMs: 86_400_000, ratio: 0.99 },
        { windowMs: 604_800_000, ratio: 0.95 },
        { windowMs: 2_592_000_000, ratio: 0.9 },
      ],
      history: [{ startedAt: Date.now(), ratio: 1 }],
    });
    renderDeviceDetail();

    expect(await screen.findByText("iPhone")).toBeInTheDocument();
    expect(screen.getByText(/tailscale/i)).toBeInTheDocument();
    expect(screen.getByText(/tcp/i)).toBeInTheDocument();
  });

  it("renders uptime figures for 24h, 7d, and 30d windows", async () => {
    stubDetail({
      device: device(),
      monitors: [],
      uptime: [
        { windowMs: 86_400_000, ratio: 0.99 },
        { windowMs: 604_800_000, ratio: 0.95 },
        { windowMs: 2_592_000_000, ratio: 0.9 },
      ],
      history: [],
    });
    renderDeviceDetail();

    await screen.findByText("iPhone");
    expect(screen.getByText(/99%/)).toBeInTheDocument();
    expect(screen.getByText(/95%/)).toBeInTheDocument();
    expect(screen.getByText(/90%/)).toBeInTheDocument();
  });

  it("renders null uptime as 'no data', never '0%'", async () => {
    stubDetail({
      device: device(),
      monitors: [],
      uptime: [
        { windowMs: 86_400_000, ratio: null },
        { windowMs: 604_800_000, ratio: null },
        { windowMs: 2_592_000_000, ratio: null },
      ],
      history: [],
    });
    renderDeviceDetail();

    await screen.findByText("iPhone");
    // Must not render "0%" for null — that asserts an outage nobody observed
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
    // Must render "no data" or similar for null uptime
    expect(screen.getAllByText(/no data/i)).toHaveLength(3);
  });

  it("posts to add a monitor", async () => {
    let monitors: MonitorSummary[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === "/api/devices/dev-1" && opts?.method === "POST") {
        const body = JSON.parse(opts.body as string);
        monitors = [monitor({ type: body.type })];
        return new Response(JSON.stringify({}), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/devices/dev-1") {
        return new Response(
          JSON.stringify({
            device: device(),
            monitors,
            uptime: [],
            history: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDeviceDetail();

    await screen.findByText("iPhone");

    // Click to open the add monitor dialog or form (use the first button, which is in the header)
    const addButtons = screen.getAllByRole("button", { name: /add monitor/i });
    const addButton = addButtons[0];
    if (!addButton) throw new Error("Add button not found");
    fireEvent.click(addButton);

    // Select monitor type and submit (implementation will determine exact fields)
    const typeSelect = await screen.findByLabelText(/type/i);
    fireEvent.change(typeSelect, { target: { value: "tcp" } });

    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);

    // Should have called POST
    await vi.waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (call) => call[1]?.method === "POST",
      );
      expect(postCalls).toHaveLength(1);
    });
  });

  it("deletes a monitor", async () => {
    let monitors: MonitorSummary[] = [monitor({ id: "mon-1", type: "tcp" })];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === "/api/monitors/mon-1" && opts?.method === "DELETE") {
        monitors = [];
        return new Response(null, { status: 204 });
      }
      if (url === "/api/devices/dev-1") {
        return new Response(
          JSON.stringify({
            device: device(),
            monitors,
            uptime: [],
            history: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDeviceDetail();

    await screen.findByText(/tcp/i);

    // Find and click the delete button for the monitor
    const deleteButton = screen.getByRole("button", { name: /delete/i });
    fireEvent.click(deleteButton);

    // Should have called DELETE
    await vi.waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter(
        (call) => call[1]?.method === "DELETE",
      );
      expect(deleteCalls).toHaveLength(1);
    });
  });

  it("marks an advisory monitor with required: false", async () => {
    let monitors: MonitorSummary[] = [
      monitor({ id: "mon-1", type: "tcp", required: true }),
    ];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === "/api/monitors/mon-1" && opts?.method === "PATCH") {
        const body = JSON.parse(opts.body as string);
        monitors = [
          monitor({ id: "mon-1", type: "tcp", required: body.required }),
        ];
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/devices/dev-1") {
        return new Response(
          JSON.stringify({
            device: device(),
            monitors,
            uptime: [],
            history: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDeviceDetail();

    await screen.findByText(/tcp/i);

    // Find and toggle the required checkbox
    const requiredCheckbox = screen.getByRole("checkbox", {
      name: /required/i,
    });
    expect(requiredCheckbox).toBeChecked();
    fireEvent.click(requiredCheckbox);

    // Should have called PATCH with required: false
    await vi.waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        (call) => call[1]?.method === "PATCH",
      );
      expect(patchCalls).toHaveLength(1);
    });
  });

  it("renders the refusal state for a 403", async () => {
    const fetchMock = stubFailure(403, "forbidden");
    renderDeviceDetail();

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
