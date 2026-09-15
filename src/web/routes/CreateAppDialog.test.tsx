// @vitest-environment jsdom
import type { CatalogEntry } from "@shared/catalog/schema.js";
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

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    slug: "uptime-kuma",
    name: "Uptime Kuma",
    description: "Self-hosted monitoring for websites and services.",
    iconRef: "uptime-kuma",
    homepage: "https://example.com/uptime-kuma",
    categories: ["monitoring"],
    compose: "services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:1\n",
    ...overrides,
  };
}

/**
 * Discriminates by URL and method, unlike `ok()` above — this suite's browse-and-create
 * tests hit `GET /api/catalog` and `POST /api/apps` in the same test, and the two must
 * answer differently.
 */
function stubCatalogAndCreate(
  entries: CatalogEntry[],
  createResponse: { body?: unknown; status?: number } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog") {
        return new Response(JSON.stringify(entries), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/apps" && init?.method === "POST") {
        return new Response(
          JSON.stringify(createResponse.body ?? { id: "a1", slug: entries[0]?.slug ?? "x" }),
          {
            status: createResponse.status ?? 201,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    }),
  );
}

function lastCreateBody(): Record<string, unknown> {
  const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, RequestInit | undefined]
  >;
  const call = calls.findLast(([url, init]) => url === "/api/apps" && init?.method === "POST");
  if (!call) throw new Error("POST /api/apps was never called");
  return JSON.parse(String(call[1]?.body));
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

  describe("browsing the catalog", () => {
    it("lists every catalog entry once the browse panel opens", async () => {
      stubCatalogAndCreate([
        catalogEntry({ slug: "uptime-kuma", name: "Uptime Kuma" }),
        catalogEntry({ slug: "jellyfin", name: "Jellyfin" }),
      ]);
      mount();
      fireEvent.click(screen.getByRole("button", { name: /Browse the catalog/ }));
      await waitFor(() => expect(screen.getByText("Uptime Kuma")).toBeTruthy());
      expect(screen.getByText("Jellyfin")).toBeTruthy();
    });

    it("narrows the list to entries matching the search across name, description and category", async () => {
      stubCatalogAndCreate([
        catalogEntry({
          slug: "uptime-kuma",
          name: "Uptime Kuma",
          description: "Self-hosted monitoring for websites and services.",
          categories: ["monitoring"],
        }),
        catalogEntry({
          slug: "jellyfin",
          name: "Jellyfin",
          description: "A media server.",
          categories: ["media"],
        }),
      ]);
      mount();
      fireEvent.click(screen.getByRole("button", { name: /Browse the catalog/ }));
      await waitFor(() => expect(screen.getByText("Jellyfin")).toBeTruthy());

      fireEvent.change(screen.getByLabelText(/Search the catalog/), {
        target: { value: "monitoring" },
      });
      expect(screen.getByText("Uptime Kuma")).toBeTruthy();
      expect(screen.queryByText("Jellyfin")).toBeNull();
    });

    it("says a search matched nothing, rather than showing an empty list", async () => {
      stubCatalogAndCreate([catalogEntry()]);
      mount();
      fireEvent.click(screen.getByRole("button", { name: /Browse the catalog/ }));
      await waitFor(() => expect(screen.getByText("Uptime Kuma")).toBeTruthy());

      fireEvent.change(screen.getByLabelText(/Search the catalog/), {
        target: { value: "definitely-not-in-the-catalog" },
      });
      expect(screen.queryByText("Uptime Kuma")).toBeNull();
      expect(screen.getByText(/No apps match/)).toBeTruthy();
    });

    it("fills display name, description, icon and compose from a chosen entry, and each stays editable", async () => {
      const entry = catalogEntry();
      stubCatalogAndCreate([entry]);
      const { container } = mount();
      fireEvent.click(screen.getByRole("button", { name: /Browse the catalog/ }));
      await waitFor(() => expect(screen.getByText(entry.name)).toBeTruthy());
      fireEvent.click(screen.getByText(entry.name));

      // Filled.
      expect((screen.getByLabelText(/Display name/) as HTMLInputElement).value).toBe(entry.name);
      expect((screen.getByLabelText(/Directory/) as HTMLInputElement).value).toBe(entry.slug);
      expect((screen.getByLabelText(/Description/) as HTMLTextAreaElement).value).toBe(
        entry.description,
      );
      expect(container.querySelector(`img[data-icon-slug="${entry.iconRef}"]`)).not.toBeNull();
      expect((screen.getByLabelText(/Compose file/) as HTMLTextAreaElement).value).toBe(
        entry.compose,
      );

      // Editable: change every field the catalog filled, then confirm the edit stuck
      // rather than the catalog's own value re-asserting itself.
      fireEvent.change(screen.getByLabelText(/Display name/), {
        target: { value: "My Kuma" },
      });
      fireEvent.change(screen.getByLabelText(/Description/), {
        target: { value: "A rewritten description." },
      });
      const editedCompose = "services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:2\n";
      fireEvent.change(screen.getByLabelText(/Compose file/), {
        target: { value: editedCompose },
      });
      // The icon field's own "Use a letter tile" clears the chosen icon back to null —
      // proof the field is a live control, not a read-only echo of the catalog.
      fireEvent.click(screen.getByRole("button", { name: /Use a letter tile/ }));

      expect((screen.getByLabelText(/Display name/) as HTMLInputElement).value).toBe("My Kuma");
      expect((screen.getByLabelText(/Description/) as HTMLTextAreaElement).value).toBe(
        "A rewritten description.",
      );
      expect((screen.getByLabelText(/Compose file/) as HTMLTextAreaElement).value).toBe(
        editedCompose,
      );
      expect(container.querySelector("img[data-icon-slug]")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const body = lastCreateBody();
      expect(body.displayName).toBe("My Kuma");
      expect(body.description).toBe("A rewritten description.");
      expect(body.compose).toBe(editedCompose);
      expect(body.iconRef).toBeUndefined();
    });

    it("creates an app from an unedited catalog entry with that entry's compose in the request", async () => {
      // The strongest proof this routes through the SAME create path: the request body
      // `POST /api/apps` actually receives carries the catalog entry's own compose text.
      const entry = catalogEntry();
      stubCatalogAndCreate([entry]);
      mount();
      fireEvent.click(screen.getByRole("button", { name: /Browse the catalog/ }));
      await waitFor(() => expect(screen.getByText(entry.name)).toBeTruthy());
      fireEvent.click(screen.getByText(entry.name));

      fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const body = lastCreateBody();
      expect(body).toMatchObject({
        displayName: entry.name,
        directory: entry.slug,
        description: entry.description,
        iconRef: entry.iconRef,
        compose: entry.compose,
      });
    });

    it("does not fetch the catalog until the browse panel is opened", async () => {
      stubCatalogAndCreate([catalogEntry()]);
      mount();
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
