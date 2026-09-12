// @vitest-environment jsdom
import type { CloudflareStatus, CloudflareZone } from "@shared/cloudflare.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CloudflarePanel } from "@web/routes/settings/CloudflarePanel";
import { describe, expect, it, vi } from "vitest";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const NOT_CONFIGURED: CloudflareStatus = { configured: false };
const CONFIGURED: CloudflareStatus = {
  configured: true,
  accountId: "acct-123",
  tokenHint: "wxyz",
  verifiedAt: 1_800_000_000,
};
const ZONES: CloudflareZone[] = [{ id: "z1", name: "example.com" }];
const TOKEN = "cfat_totally-a-real-token-value";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CloudflarePanel />
    </QueryClientProvider>,
  );
}

/** A fetch stub whose credentials/zones answers can change mid-test — `configured` and
 * `deleted` are mutable so a PUT/DELETE in one call changes what the next GET answers,
 * the same way the real server would after a save or a removal. */
function stubFetch(opts: {
  initiallyConfigured?: boolean;
  put?: () => Response;
  zones?: CloudflareZone[];
}) {
  let configured = opts.initiallyConfigured ?? false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/cloudflare/credentials" && method === "GET") {
      return json(200, configured ? CONFIGURED : NOT_CONFIGURED);
    }
    if (url === "/api/cloudflare/credentials" && method === "PUT") {
      if (opts.put) return opts.put();
      configured = true;
      return json(200, CONFIGURED);
    }
    if (url === "/api/cloudflare/credentials" && method === "DELETE") {
      configured = false;
      return new Response(null, { status: 204 });
    }
    if (url === "/api/cloudflare/zones" && method === "GET") {
      return json(200, opts.zones ?? ZONES);
    }
    throw new Error(`unhandled request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fillForm() {
  fireEvent.change(screen.getByLabelText(/Account ID/), { target: { value: "acct-1" } });
  fireEvent.change(screen.getByLabelText(/API token/), { target: { value: TOKEN } });
}

describe("CloudflarePanel", () => {
  it("offers a token field and an account id field when not configured", async () => {
    stubFetch({ initiallyConfigured: false });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    expect(screen.getByLabelText(/API token/)).toBeTruthy();
  });

  it("shows the account id and hint, and no full token field, when configured", async () => {
    stubFetch({ initiallyConfigured: true });
    mount();

    await waitFor(() => expect(screen.getByText("acct-123")).toBeTruthy());
    expect(screen.getByText(/wxyz/)).toBeTruthy();
    expect(screen.queryByLabelText(/API token/)).toBeNull();
    expect(screen.queryByLabelText(/Account ID/)).toBeNull();
  });

  it("has a password-typed, non-autocompleting token field", async () => {
    stubFetch({ initiallyConfigured: false });
    mount();

    const input = (await waitFor(() => screen.getByLabelText(/API token/))) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
  });

  it("keeps the entered values and surfaces the fault's message when the save fails", async () => {
    stubFetch({
      initiallyConfigured: false,
      put: () => json(422, { error: "verification_failed", fault: "auth" }),
    });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // The fault's own sentence, not a generic "something went wrong" — different faults
    // from the same route say different things, and this is the `auth` one.
    expect(screen.getByText(/rejected/i)).toBeTruthy();

    // A 40-character token is not something worth retyping over a typo in the field
    // next to it.
    expect((screen.getByLabelText(/Account ID/) as HTMLInputElement).value).toBe("acct-1");
    expect((screen.getByLabelText(/API token/) as HTMLInputElement).value).toBe(TOKEN);
  });

  it("shows the zones after a successful save", async () => {
    stubFetch({ initiallyConfigured: false });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(screen.getByText("example.com")).toBeTruthy());
    // And the form that could still be holding the token is gone entirely.
    expect(screen.queryByLabelText(/API token/)).toBeNull();
  });

  it("removes credentials through ConfirmDialog, not a second confirmation UI", async () => {
    stubFetch({ initiallyConfigured: true });
    mount();

    await waitFor(() => expect(screen.getByText("acct-123")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Remove credentials/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
  });

  it("does not fire a DELETE when the removal is cancelled", async () => {
    const fetchMock = stubFetch({ initiallyConfigured: true });
    mount();

    await waitFor(() => expect(screen.getByText("acct-123")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Remove credentials/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE"),
    ).toBe(false);
  });
});
