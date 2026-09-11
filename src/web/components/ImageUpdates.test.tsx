// @vitest-environment jsdom
import type { ImageStatusRow } from "@shared/admin.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { imagesKey } from "@web/api/admin";
import { ImageUpdates } from "@web/components/ImageUpdates";
import { afterEach, describe, expect, it, vi } from "vitest";

const APP_ID = "a1";

function imageRow(over: Partial<ImageStatusRow> = {}): ImageStatusRow {
  return {
    appId: APP_ID,
    serviceName: "web",
    currentDigest: "sha256:aaaa",
    latestDigest: "sha256:aaaa",
    updateAvailable: false,
    checkedAt: 1_800_000_000,
    ...over,
  };
}

function mount(images: ImageStatusRow[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(imagesKey(APP_ID), images);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ImageUpdates appId={APP_ID} />
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ImageUpdates", () => {
  it("lists one row per image with its current digest and any available update", () => {
    mount([
      imageRow({ serviceName: "web", updateAvailable: false }),
      imageRow({
        serviceName: "db",
        currentDigest: "sha256:old",
        latestDigest: "sha256:new",
        updateAvailable: true,
      }),
    ]);

    expect(screen.getByText("web")).toBeTruthy();
    const dbRow = screen.getByText("db").closest("li");
    expect(dbRow?.textContent).toContain("sha256:old");
    expect(dbRow?.textContent).toContain("sha256:new");
    expect(dbRow?.textContent).toContain("Update");
  });

  it("shows the count of images with an update available", () => {
    mount([
      imageRow({ serviceName: "web", updateAvailable: false }),
      imageRow({ serviceName: "db", updateAvailable: true }),
      imageRow({ serviceName: "cache", updateAvailable: true }),
    ]);

    expect(screen.getByText("2 updates")).toBeTruthy();
  });

  /**
   * The whole value of this panel. `currentDigest` is `null` here — Docker inspect
   * failed, or no check has ever completed for this service — and `latestDigest` is a
   * known value. A component that recomputed "has an update" from the digests directly,
   * the way `currentDigest !== latestDigest` reads, would call `null !== "sha256:new"`
   * true and show an update forever, since a badge like that never clears once created.
   * `updateAvailable` is already `false` on the row (1B-ii sets it that way on the
   * server for exactly this case); this test fails if the component second-guesses it.
   */
  it("does not report an image with an unknown digest as having an update", () => {
    mount([
      imageRow({
        serviceName: "web",
        currentDigest: null,
        latestDigest: "sha256:new",
        updateAvailable: false,
      }),
    ]);

    expect(screen.queryByText("Update")).toBeNull();
    expect(screen.queryByText(/\d+ updates?/)).toBeNull();
    expect(screen.getByText("web").closest("li")?.textContent).not.toContain("Update");
  });

  it("posts a check and shows progress while it runs", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    mount([imageRow({ serviceName: "web", updateAvailable: false })]);

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    const checkingButton = await screen.findByRole("button", { name: "Checking…" });
    expect(checkingButton).toHaveProperty("disabled", true);

    resolveFetch(
      new Response(
        JSON.stringify([
          imageRow({ serviceName: "web", updateAvailable: true, latestDigest: "sha256:new" }),
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy());
    expect(screen.getByText("1 update")).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/apps/${APP_ID}/images/check` &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
    ).toBe(true);
  });

  it("reports a check failure without clearing the last known state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "check_failed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    mount([imageRow({ serviceName: "web", updateAvailable: true, latestDigest: "sha256:new" })]);

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    expect(await screen.findByText("Could not check for updates.")).toBeTruthy();
    // The update this app already knew about before the failed check is still shown.
    expect(screen.getByText("1 update")).toBeTruthy();
    expect(screen.getByText("web").closest("li")?.textContent).toContain("Update");
  });
});
