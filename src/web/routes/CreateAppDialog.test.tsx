// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateAppDialog } from "@web/routes/CreateAppDialog";
import { describe, expect, it, vi } from "vitest";

function mount(onClose = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <CreateAppDialog onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
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
    const { client } = mount(onClose);
    const spy = vi.spyOn(client, "invalidateQueries");
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(spy).toHaveBeenCalled();
  });

  it("disables submit while a create is in flight", async () => {
    // Two clicks would create two directories, and the second 409s having already
    // written a file. The guard must be set synchronously in the click handler, before
    // `mutate` is even called — not derived from `mutation.isPending`, which TanStack's
    // `notifyManager` defers through `setTimeout(fn, 0)`. Asserting in the same tick as
    // the click (no `waitFor`, no flush) is what would catch a guard wired the wrong way:
    // `waitFor` would happily wait out that macrotask and pass either way.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    expect(screen.getByRole("button", { name: /Creating|Create/ }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("shows a network-failure message distinct from a rejected request", async () => {
    // A `fetch` rejection (no response at all) and a rejected request need different
    // words: one means "try again", the other means "change something".
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(screen.getByText(/reach the server/i)).toBeTruthy());
  });

  it("shows an unmapped-slug message distinct from a network failure", async () => {
    ok({ error: "some_new_error" }, 500);
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Jellyfin" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(screen.getByText(/some_new_error/)).toBeTruthy());
    expect(screen.queryByText(/reach the server/i)).toBeNull();
  });

  it("suggests a 64-character directory from a 65-character display name", async () => {
    // The server's zod schema caps `directory` at 64 (`src/server/routes/apps.ts`); the
    // client mirrors that cap so a suggestion the user never typed is quietly fitted
    // rather than rejected.
    ok();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), {
      target: { value: "a".repeat(65) },
    });
    const value = (screen.getByLabelText(/Directory/) as HTMLInputElement).value;
    expect(value).toHaveLength(64);
    expect(value).toBe("a".repeat(64));
  });

  it("refuses a hand-typed directory longer than 64 characters, with no request", async () => {
    ok();
    mount();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/Directory/), {
      target: { value: "b".repeat(65) },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/64 characters or fewer/i)).toBeTruthy();
  });
});
