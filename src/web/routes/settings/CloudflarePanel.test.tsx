// @vitest-environment jsdom
import type { CloudflareStatus, CloudflareZone } from "@shared/cloudflare.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloudflareStatusKey } from "@web/api/cloudflare";
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

/** Same as `mount`, but also hands back the `QueryClient` — needed by tests that inspect
 * the cache directly rather than the DOM. */
function mountWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <CloudflarePanel />
    </QueryClientProvider>,
  );
  return { ...result, client };
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

  it("never puts the token in the mutation cache, on success or on failure", async () => {
    // The DOM looks identical whether or not this holds — that is exactly why the token
    // leak here survived review. Inspects `queryClient.getMutationCache()` directly
    // instead.
    stubFetch({ initiallyConfigured: false });
    const success = mountWithClient();
    await waitFor(() => expect(success.getByLabelText(/Account ID/)).toBeTruthy());
    fireEvent.change(success.getByLabelText(/Account ID/), { target: { value: "acct-1" } });
    fireEvent.change(success.getByLabelText(/API token/), { target: { value: TOKEN } });
    fireEvent.click(success.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(success.getByText("example.com")).toBeTruthy());

    const successCache = JSON.stringify(success.client.getMutationCache().getAll());
    expect(successCache).not.toContain(TOKEN);

    stubFetch({
      initiallyConfigured: false,
      put: () => json(422, { error: "verification_failed", fault: "auth" }),
    });
    const failure = mountWithClient();
    await waitFor(() => expect(failure.getByLabelText(/Account ID/)).toBeTruthy());
    fireEvent.change(failure.getByLabelText(/Account ID/), { target: { value: "acct-1" } });
    fireEvent.change(failure.getByLabelText(/API token/), { target: { value: TOKEN } });
    fireEvent.click(failure.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(failure.getByRole("alert")).toBeTruthy());

    const failureCache = JSON.stringify(failure.client.getMutationCache().getAll());
    expect(failureCache).not.toContain(TOKEN);
  });

  it("does not resurrect the saved token in the field if a post-save status refetch reports not configured", async () => {
    // The reviewer's scenario: another admin removes the credentials in a second tab (or
    // the write itself failed after this tab already believed it succeeded), and this
    // tab's status query refetches and comes back `configured: false`. The form
    // reappears, and it must not come back pre-filled with the token this tab just typed.
    let configuredAfterSave = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/cloudflare/credentials" && method === "GET") {
        return json(200, configuredAfterSave ? CONFIGURED : NOT_CONFIGURED);
      }
      if (url === "/api/cloudflare/credentials" && method === "PUT") {
        configuredAfterSave = true;
        return json(200, CONFIGURED);
      }
      if (url === "/api/cloudflare/zones" && method === "GET") {
        return json(200, ZONES);
      }
      throw new Error(`unhandled request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { client, ...view } = mountWithClient();
    await waitFor(() => expect(view.getByLabelText(/Account ID/)).toBeTruthy());
    fillForm();
    fireEvent.click(view.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(view.getByText("example.com")).toBeTruthy());

    configuredAfterSave = false;
    await client.invalidateQueries({ queryKey: cloudflareStatusKey });

    await waitFor(() => expect(view.getByLabelText(/API token/)).toBeTruthy());
    expect((view.getByLabelText(/API token/) as HTMLInputElement).value).toBe("");
  });
});
