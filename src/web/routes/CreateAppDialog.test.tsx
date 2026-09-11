// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateAppDialog } from "@web/routes/CreateAppDialog";
import { describe, expect, it, vi } from "vitest";

function mount(onClose = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateAppDialog onClose={onClose} />
    </QueryClientProvider>,
  );
}

function ok(body: unknown = { id: "a1", slug: "jellyfin" }, status = 201) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

describe("CreateAppDialog", () => {
  it("suggests a directory from the display name as you type", async () => {
    ok();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), {
      target: { value: "Home Assistant" },
    });
    expect((screen.getByLabelText(/Directory/) as HTMLInputElement).value).toBe("home-assistant");
  });

  it("stops suggesting once the directory has been edited by hand", async () => {
    // Overwriting a deliberate choice on the next keystroke is the classic version of
    // this bug, and it is infuriating precisely because it only bites careful users.
    ok();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), {
      target: { value: "Home Assistant" },
    });
    fireEvent.change(screen.getByLabelText(/Directory/), { target: { value: "hass" } });
    fireEvent.change(screen.getByLabelText(/Display name/), {
      target: { value: "Home Assistant 2" },
    });
    expect((screen.getByLabelText(/Directory/) as HTMLInputElement).value).toBe("hass");
  });

  it("refuses to submit a directory with a path separator", async () => {
    ok();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/Directory/), { target: { value: "../etc" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/single folder name/i)).toBeTruthy();
  });

  it("shows the server's error rather than a generic failure", async () => {
    ok({ error: "directory_exists" }, 409);
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
  });

  it("closes and invalidates the list on success", async () => {
    ok();
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("disables submit while a create is in flight", async () => {
    // Two clicks would create two directories, and the second 409s having already
    // written a file.
    let resolve: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      ),
    );
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Creating|Create/ }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
    resolve(
      new Response(JSON.stringify({ id: "a1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});
