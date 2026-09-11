// @vitest-environment jsdom
import type { ProbeRow } from "@shared/admin.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { probesKey } from "@web/api/admin";
import { ProbesPanel } from "@web/routes/edit/ProbesPanel";
import { afterEach, describe, expect, it, vi } from "vitest";

const APP_ID = "a1";

function probe(over: Partial<ProbeRow> = {}): ProbeRow {
  return {
    id: "p1",
    appId: APP_ID,
    kind: "docker",
    label: null,
    target: null,
    expectedStatusPattern: "2xx",
    timeoutMs: 5000,
    intervalSeconds: 30,
    insecureTls: false,
    followRedirects: false,
    enabled: true,
    nextRunAt: 0,
    consecutiveFailures: 0,
    lastStatus: "up",
    lastLatencyMs: null,
    lastDetail: null,
    lastFaultClass: null,
    lastCheckedAt: 1000,
    statusSince: 1000,
    ...over,
  };
}

function mount(probes: ProbeRow[] = [probe()]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(probesKey(APP_ID), probes);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ProbesPanel appId={APP_ID} />
      </QueryClientProvider>,
    ),
  };
}

/**
 * One fetch double that routes by URL/method, so a single test can seed both the
 * suggestions GET and whichever mutation it is exercising without juggling call order.
 */
function mockFetch(opts: {
  suggestions?: Array<{ service: string; target: string }>;
  post?: { status: number; body: unknown };
  patch?: { status: number; body: unknown };
  del?: { status: number };
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.includes("/probes/suggestions")) return json(200, opts.suggestions ?? []);
      if (method === "POST") {
        const { status, body } = opts.post ?? { status: 201, body: probe() };
        return json(status, body);
      }
      if (method === "PATCH") {
        const { status, body } = opts.patch ?? { status: 200, body: probe() };
        return json(status, body);
      }
      if (method === "DELETE") return new Response(null, { status: opts.del?.status ?? 204 });
      // Falls through here for the list refetch a mutation's invalidation triggers — an
      // empty array, not `{}`, since this is the same shape `useProbes` expects.
      return json(200, []);
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProbesPanel", () => {
  it("lists each probe with kind, target and current status", () => {
    mount([
      probe({ id: "d1", kind: "docker", target: null, lastStatus: "up" }),
      probe({
        id: "h1",
        kind: "http_internal",
        target: "http://localhost:8096",
        lastStatus: "down",
        lastFaultClass: "app",
      }),
    ]);

    const [dockerItem, httpItem] = screen.getAllByRole("listitem");
    expect(dockerItem?.textContent).toContain("Docker");
    expect(dockerItem?.textContent).toContain("Healthy");
    expect(httpItem?.textContent).toContain("localhost:8096");
    expect(httpItem?.textContent).toContain("App not responding");
  });

  it("offers the suggestions endpoint's published ports when adding an HTTP probe", async () => {
    mockFetch({
      suggestions: [
        { service: "web", target: "http://localhost:8096" },
        { service: "admin", target: "http://localhost:9000" },
      ],
    });
    mount([]);

    fireEvent.click(screen.getByRole("button", { name: "Add probe" }));

    await waitFor(() => expect(screen.getByText(/web · http:\/\/localhost:8096/)).toBeTruthy());
    expect(screen.getByText(/admin · http:\/\/localhost:9000/)).toBeTruthy();

    fireEvent.click(screen.getByText(/web · http:\/\/localhost:8096/));
    expect((screen.getByPlaceholderText("http://localhost:8096") as HTMLInputElement).value).toBe(
      "http://localhost:8096",
    );
  });

  it("posts the right body when adding an HTTP probe", async () => {
    mockFetch({ suggestions: [] });
    mount([]);

    fireEvent.click(screen.getByRole("button", { name: "Add probe" }));
    fireEvent.change(screen.getByPlaceholderText("http://localhost:8096"), {
      target: { value: "http://localhost:9999" },
    });
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "Sonarr" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
    );
    const [url, init] = vi
      .mocked(fetch)
      .mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "POST") as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe(`/api/apps/${APP_ID}/probes`);
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "http_internal",
      target: "http://localhost:9999",
      label: "Sonarr",
    });
  });

  it("refuses an invalid URL client-side, without calling the server", async () => {
    mockFetch({ suggestions: [] });
    mount([]);

    fireEvent.click(screen.getByRole("button", { name: "Add probe" }));
    fireEvent.change(screen.getByPlaceholderText("http://localhost:8096"), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/Enter a valid/)).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("asks for confirmation before deleting, and does not delete when cancelled", () => {
    mockFetch({});
    mount([probe({ id: "p1" })]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("deletes the probe once the confirmation is accepted", async () => {
    mockFetch({});
    mount([probe({ id: "p1" })]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true),
    );
    const [url] = vi
      .mocked(fetch)
      .mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "DELETE") as [string];
    expect(String(url)).toBe("/api/probes/p1");
  });

  it("toggling enabled persists via PATCH", async () => {
    mockFetch({ patch: { status: 200, body: probe({ id: "p1", enabled: false }) } });
    mount([probe({ id: "p1", enabled: true })]);

    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true),
    );
    const [url, init] = vi
      .mocked(fetch)
      .mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PATCH") as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe("/api/probes/p1");
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
  });

  it("refuses a second docker probe with the server's probe_exists rendered as a sentence", async () => {
    mockFetch({
      suggestions: [],
      post: { status: 409, body: { error: "probe_exists" } },
    });
    mount([probe({ id: "d1", kind: "docker" })]);

    fireEvent.click(screen.getByRole("button", { name: "Add probe" }));
    fireEvent.change(screen.getByLabelText(/Kind/), { target: { value: "docker" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText("This app already has a docker probe — only one is allowed."),
    ).toBeTruthy();
    expect(screen.queryByText("probe_exists")).toBeNull();
  });
});
