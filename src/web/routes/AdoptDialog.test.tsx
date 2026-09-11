// @vitest-environment jsdom
import type { ScanResult } from "@shared/admin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdoptDialog } from "@web/routes/AdoptDialog";
import { describe, expect, it, vi } from "vitest";

const SCAN: ScanResult = {
  discovered: [
    {
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
      containerCount: 2,
      running: true,
      adopted: false,
    },
    {
      directory: "gitea",
      composeFile: "compose.yaml",
      projectName: "gitea",
      containerCount: 1,
      running: false,
      adopted: false,
    },
    {
      directory: "taken",
      composeFile: "compose.yaml",
      projectName: "taken",
      containerCount: 1,
      running: true,
      adopted: true,
    },
  ],
  orphans: [{ projectName: "stray", containerCount: 3 }],
};

function mount(onClose = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AdoptDialog onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

function stubScan(adoptResponse: unknown = { adopted: [], failed: [] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(JSON.stringify(init?.method === "POST" ? adoptResponse : SCAN), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

describe("AdoptDialog", () => {
  it("lists unadopted directories as selectable", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    expect(screen.getByLabelText(/gitea/)).toBeTruthy();
  });

  it("shows an already-adopted directory without a checkbox", async () => {
    // Offering to adopt something already adopted produces a confusing 409 the user
    // cannot act on.
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByText(/taken/)).toBeTruthy());
    expect(screen.queryByLabelText(/^taken/)).toBeNull();
  });

  it("surfaces orphan stacks, since they are why a directory is missing", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByText(/stray/)).toBeTruthy());
  });

  it("adopts only the checked directories", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 1/ }));
    await waitFor(() => {
      const post = vi
        .mocked(fetch)
        .mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST");
      // biome-ignore lint/correctness/noUnsafeOptionalChaining: a thrown TypeError here (no POST call found) fails the test just as loudly as a false assertion would.
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        directories: ["jellyfin"],
      });
    });
  });

  it("disables the adopt button until something is selected", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Adopt/ }).hasAttribute("disabled")).toBe(true);
  });

  it("reports per-directory failures instead of claiming success", async () => {
    // The adopt endpoint returns partial results. Closing on a partial failure hides a
    // directory the user asked for and did not get.
    stubScan({
      adopted: [{ id: "a1", directory: "jellyfin" }],
      failed: [{ directory: "gitea", error: "compose_invalid" }],
    });
    const onClose = vi.fn();
    mount(onClose);
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByLabelText(/gitea/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 2/ }));
    await waitFor(() => expect(screen.getByText(/gitea/)).toBeTruthy());
    expect(screen.getByText(/compose_invalid/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("invalidates the app list after a successful adopt", async () => {
    stubScan({ adopted: [{ id: "a1", directory: "jellyfin" }], failed: [] });
    const { client } = mount();
    const spy = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 1/ }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });
});
