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

  it("moves focus into the dialog when it opens", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  // jsdom does not implement sequential focus navigation, so a synthetic Tab keydown never
  // actually moves `document.activeElement` — with or without a trap. `event.defaultPrevented`
  // is the one observable the handler produces that jsdom does not fake on its own, so these
  // assert that instead. A second focusable element is added so "first" and "last" are
  // distinguishable; with only the Close button, every case degenerates to the same node.
  it("prevents Tab from leaving the dialog when focus is on the last focusable element", async () => {
    mount();
    const dialog = await screen.findByRole("dialog");
    const closeButton = screen.getByRole("button", { name: "Close" });
    const extra = document.createElement("button");
    extra.textContent = "Extra";
    dialog.insertBefore(extra, dialog.firstChild);

    closeButton.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents Shift+Tab from leaving the dialog when focus is on the first focusable element", async () => {
    mount();
    const dialog = await screen.findByRole("dialog");
    const extra = document.createElement("button");
    extra.textContent = "Extra";
    dialog.insertBefore(extra, dialog.firstChild);

    extra.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not prevent a Tab that stays inside the dialog's multi-element list", async () => {
    mount();
    const dialog = await screen.findByRole("dialog");
    const extra = document.createElement("button");
    extra.textContent = "Extra";
    dialog.insertBefore(extra, dialog.firstChild);

    // `extra` is now first, `closeButton` is last. Tab from `extra` moves toward the
    // middle of the list, not off either end, so the handler must let it through.
    extra.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("restores focus to whatever opened it once the panel closes", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open health";
    document.body.appendChild(opener);
    opener.focus();

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <HealthPanel appId="a1" appName="Jellyfin" onClose={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("closes when the close button is clicked", async () => {
    const onClose = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <HealthPanel appId="a1" appName="Jellyfin" onClose={onClose} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
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
