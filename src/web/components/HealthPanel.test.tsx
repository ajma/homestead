// @vitest-environment jsdom
import type { AppHealth } from "@shared/launcher";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HealthPanel } from "@web/components/HealthPanel";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HEALTH: AppHealth = {
  appId: "a1",
  signals: [
    {
      probeId: "p1",
      kind: "docker",
      label: null,
      status: "up",
      reason: "Healthy",
      since: 100,
      lastCheckedAt: 200,
      latencyMs: 3,
    },
    {
      probeId: "p2",
      kind: "http_internal",
      label: "Web UI",
      status: "down",
      reason: "App not responding",
      since: 150,
      lastCheckedAt: 200,
      latencyMs: null,
    },
  ],
  history: Array.from({ length: 30 }, (_, i) => ({
    dayStart: i * 86_400,
    upRatio: 1,
    degradedRatio: 0,
    downRatio: 0,
    probeCount: 1,
  })),
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HealthPanel appId="a1" appName="Jellyfin" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("HealthPanel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(HEALTH), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  it("lists one row per signal with its own cause", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("App not responding")).toBeTruthy());
    expect(screen.getByText("Healthy")).toBeTruthy();
  });

  it("names a probe by its label when it has one, and by kind otherwise", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Web UI")).toBeTruthy());
    expect(screen.getByText(/Docker/i)).toBeTruthy();
  });

  it("is a dialog that can be dismissed with Escape", async () => {
    const onClose = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <HealthPanel appId="a1" appName="Jellyfin" onClose={onClose} />
      </QueryClientProvider>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close when a click inside the panel bubbles to the backdrop", async () => {
    const onClose = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <HealthPanel appId="a1" appName="Jellyfin" onClose={onClose} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows an error rather than an empty panel when health cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    mount();
    await waitFor(() => expect(screen.getByText(/Could not load health/)).toBeTruthy());
  });
});
