// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IconPicker } from "@web/components/IconPicker";
import { describe, expect, it, vi } from "vitest";

function mount(value: string | null, onChange = (_: string | null) => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IconPicker value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
}

function stub(icons: Array<{ slug: string; aliases: string[] }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ icons }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

describe("IconPicker", () => {
  it("does not search until the user types", async () => {
    // The catalogue is 3,238 entries. Fetching a default page on mount, for a control
    // most edits never touch, is one request per page view for nothing.
    stub([]);
    mount(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("searches through Homestead's proxy, never a CDN", async () => {
    stub([{ slug: "jellyfin", aliases: [] }]);
    mount(null);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jelly" } });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain("/api/icons/search");
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).not.toContain("jsdelivr");
  });

  it("reports the chosen slug", async () => {
    stub([{ slug: "jellyfin", aliases: [] }]);
    const onChange = vi.fn();
    mount(null, onChange);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jelly" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /jellyfin/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /jellyfin/ }));
    expect(onChange).toHaveBeenCalledWith("jellyfin");
  });

  it("can clear back to a letter tile", async () => {
    // Spec: the generated letter tile is a legitimate final answer, not just a
    // placeholder while an icon loads.
    stub([]);
    const onChange = vi.fn();
    mount("jellyfin", onChange);
    fireEvent.click(screen.getByRole("button", { name: /Use a letter tile/ }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("says nothing matched rather than showing an empty box", async () => {
    stub([]);
    mount(null);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText(/No icons match/)).toBeTruthy());
  });
});
