// @vitest-environment jsdom
import type {
  AccessConfigStatus,
  CloudflareStatus,
  CloudflareZone,
  MonitorAccessStatus,
  TunnelStatus,
} from "@shared/cloudflare.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloudflareStatusKey } from "@web/api/cloudflare";
import {
  CloudflarePanel,
  isMonitorExpiringSoon,
  MONITOR_EXPIRY_WARNING_MS,
} from "@web/routes/settings/CloudflarePanel";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. Same double as `JobOutput.test.tsx` and `ActionBar.test.tsx`
// — `CloudflarePanel` opens one of these, via the `JobOutput` it renders, the moment a
// provision job is being watched.
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const init = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, init));
    }
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

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
const NOT_PROVISIONED: TunnelStatus = { provisioned: false, runningJobId: null };
const MONITOR_NOT_CONFIGURED: MonitorAccessStatus = { configured: false };
const ACCESS_NOT_CONFIGURED: AccessConfigStatus = { configured: false };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CloudflarePanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Same as `mount`, but also hands back the `QueryClient` — needed by tests that inspect
 * the cache directly rather than the DOM. */
function mountWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CloudflarePanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

/** A fetch stub whose credentials/zones/tunnel answers can change mid-test — `configured`
 * is mutable so a PUT/DELETE in one call changes what the next GET answers, the same way
 * the real server would after a save or a removal. `tunnel` is a fixed answer for
 * `GET /api/cloudflare/tunnel` for the life of one stub: none of this file's scenarios
 * need it to change mid-test (the provision tests drive their outcome entirely through
 * the SSE stream, not through a second GET), so a static value keeps every test's fetch
 * stub reading as a flat table of routes. */
function stubFetch(opts: {
  initiallyConfigured?: boolean;
  put?: () => Response;
  zones?: CloudflareZone[];
  tunnel?: TunnelStatus;
  provisionPost?: () => Response | Promise<Response>;
  monitor?: MonitorAccessStatus;
  monitorPost?: () => Response | Promise<Response>;
  monitorRotatePost?: () => Response | Promise<Response>;
  access?: AccessConfigStatus;
}) {
  let configured = opts.initiallyConfigured ?? false;
  const tunnel = opts.tunnel ?? NOT_PROVISIONED;
  let monitor = opts.monitor ?? MONITOR_NOT_CONFIGURED;
  const access = opts.access ?? ACCESS_NOT_CONFIGURED;
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
    if (url === "/api/cloudflare/tunnel" && method === "GET") {
      return json(200, tunnel);
    }
    if (url === "/api/cloudflare/tunnel" && method === "POST") {
      if (opts.provisionPost) return opts.provisionPost();
      return json(202, { jobId: "job-1" });
    }
    if (url === "/api/cloudflare/monitor" && method === "GET") {
      return json(200, monitor);
    }
    if (url === "/api/cloudflare/monitor" && method === "POST") {
      if (opts.monitorPost) return opts.monitorPost();
      monitor = {
        configured: true,
        clientId: "monitor-client-1",
        policyId: "monitor-policy-1",
        expiresAt: null,
      };
      return json(200, monitor);
    }
    if (url === "/api/cloudflare/monitor/rotate" && method === "POST") {
      if (opts.monitorRotatePost) return opts.monitorRotatePost();
      if (monitor.configured) {
        monitor = { ...monitor, clientId: "monitor-client-2" };
      }
      return json(200, monitor);
    }
    if (url === "/api/cloudflare/access" && method === "GET") {
      return json(200, access);
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
      if (url === "/api/cloudflare/tunnel" && method === "GET") {
        return json(200, NOT_PROVISIONED);
      }
      if (url === "/api/cloudflare/monitor" && method === "GET") {
        return json(200, MONITOR_NOT_CONFIGURED);
      }
      if (url === "/api/cloudflare/access" && method === "GET") {
        return json(200, ACCESS_NOT_CONFIGURED);
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

  describe("the Tunnel section", () => {
    it("says so and does not offer Provision when there are no credentials", async () => {
      // Provisioning without a token cannot succeed — it can only fail with a confusing
      // Cloudflare auth error. Offering the button at all is the trap this proves closed.
      stubFetch({ initiallyConfigured: false, tunnel: NOT_PROVISIONED });
      mount();

      await waitFor(() =>
        expect(
          screen.getByText(/Add Cloudflare credentials above before provisioning a tunnel/),
        ).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: /Provision/ })).toBeNull();
    });

    it("offers Provision once credentials exist and no tunnel does", async () => {
      stubFetch({ initiallyConfigured: true, tunnel: NOT_PROVISIONED });
      mount();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Provision tunnel" })).toBeTruthy(),
      );
      expect(
        (screen.getByRole("button", { name: "Provision tunnel" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    it("disables the button immediately, then streams the job's output while the provision job runs (Minor 1)", async () => {
      // Restored to its original name (2F Task 1): through 2C/2D/2E it was renamed to
      // "...the initiating tab has no live view while the sequence is actually running"
      // because `POST /api/cloudflare/tunnel` did not resolve until `StepJobRunner.start`
      // had finished the WHOLE sequence — `watchedJobId` (`handleProvision` in
      // `CloudflarePanel.tsx`) is set only from the POST's resolved body, so `JobOutput`
      // could only ever mount against an ALREADY-TERMINAL job for the tab that clicked the
      // button; this test's own `resolvePost?.()` below happening before any assertion
      // about the stream was exactly why the old name did not describe what the wiring
      // could produce. Task 1 detached `start` from the sequence it kicks off, so the
      // route now answers as soon as the job row is inserted — the mocked timing this test
      // already exercised (resolve the POST, then watch `JobOutput` stream real progress
      // against a job that is still running) is now what actually happens end to end, not
      // just what the mock allowed.
      let resolvePost: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        resolvePost = resolve;
      });
      stubFetch({
        initiallyConfigured: true,
        tunnel: NOT_PROVISIONED,
        provisionPost: async () => {
          await gate;
          return json(202, { jobId: "job-1" });
        },
      });
      mount();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Provision tunnel" })).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Provision tunnel" }));

      // Disabled the instant the click handler runs, before the POST has even resolved —
      // `starting` is plain synchronous state, the same guarantee every other form in
      // this panel already gives.
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: /Provisioning/ }) as HTMLButtonElement).disabled,
        ).toBe(true),
      );

      resolvePost?.();

      // `JobOutput` — reused, not reimplemented — opens its own stream once the jobId
      // comes back.
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
      expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/job-1/stream");

      act(() => {
        FakeEventSource.instances[0]?.emit("output", {
          text: "creating tunnel…",
          stream: "stdout",
        });
      });
      await waitFor(() => expect(screen.getByText(/creating tunnel…/)).toBeTruthy());
      // Still disabled — the job is not done yet.
      expect(
        (screen.getByRole("button", { name: /Provisioning/ }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it("shows the tunnel's name and a link to the cloudflared app once provisioned", async () => {
      stubFetch({
        initiallyConfigured: true,
        tunnel: { provisioned: true, name: "homestead", appId: "app-cf-1", runningJobId: null },
      });
      mount();

      await waitFor(() => expect(screen.getByText("homestead")).toBeTruthy());
      const link = screen.getByRole("link", { name: /cloudflared app/i }) as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("/apps/app-cf-1");
      // Nothing left to provision.
      expect(screen.queryByRole("button", { name: /Provision/ })).toBeNull();
    });

    it("shows what was rolled back and, prominently, what was not, after a failed provision", async () => {
      stubFetch({
        initiallyConfigured: true,
        tunnel: NOT_PROVISIONED,
        provisionPost: () => json(202, { jobId: "job-1" }),
      });
      mount();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Provision tunnel" })).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Provision tunnel" }));
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

      // The persisted job output `StepJobRunner.buildOutput` produces for a failed
      // sequence with an undo failure — `!!! MANUAL CLEANUP REQUIRED !!!` first, per its
      // own doc comment on why that ordering matters.
      const output = [
        "!!! MANUAL CLEANUP REQUIRED !!!",
        "These steps could NOT be rolled back — check these resources by hand:",
        "  - create-tunnel: delete failed",
        "",
        'FAILED at step "compose-up": exit 1',
      ].join("\n");

      act(() => {
        FakeEventSource.instances[0]?.emit("output", { text: output, stream: "stdout" });
        FakeEventSource.instances[0]?.emit("done", { status: "failed", exitCode: null });
      });

      // The prominent banner — a distinct, styled alert, not text appended after a
      // generic failure line — names the exact risk: something may still exist in the
      // user's Cloudflare account.
      await waitFor(() => expect(screen.getByText(/Provisioning failed/)).toBeTruthy());
      const banner = screen.getByText(/Provisioning failed/).closest('[role="alert"]');
      expect(banner?.textContent).toContain("MANUAL CLEANUP REQUIRED");
      // The reused `JobOutput` still shows the full transcript underneath, including the
      // undo-failure detail the banner points at.
      const transcript = screen.getByTestId("job-output");
      expect(transcript.textContent).toContain("MANUAL CLEANUP REQUIRED");
      expect(transcript.textContent).toContain("create-tunnel: delete failed");
      // Provision is offered again — the tunnel was not left in a provisioned state.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Provision tunnel" })).toBeTruthy(),
      );
    });

    it("adopts a provision job already running when the panel mounts", async () => {
      // The reviewer's scenario: an admin clicked Provision, then reloaded the page (or a
      // second admin's tab is open) while the sequence — which does not return from its
      // own POST until it finishes — is still running server-side. `GET
      // /api/cloudflare/tunnel`'s `runningJobId` is the only way this tab can learn that.
      stubFetch({
        initiallyConfigured: true,
        tunnel: { provisioned: false, runningJobId: "job-99" },
      });
      mount();

      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
      expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/job-99/stream");
      expect(
        (screen.getByRole("button", { name: /Provisioning/ }) as HTMLButtonElement).disabled,
      ).toBe(true);
      // Not offered a second time — clicking it now would only race the one already
      // running.
      expect(screen.queryByRole("button", { name: "Provision tunnel" })).toBeNull();
    });
  });

  describe("isMonitorExpiringSoon", () => {
    // §6: a year after setup every external probe would begin failing simultaneously
    // with nothing actually broken — the whole point of a threshold is that it fires
    // BEFORE that day, not on it. Both sides of the boundary, pinned exactly, no fake
    // timers: `nowMs` is a plain parameter.
    const now = 1_800_000_000_000;

    it("does not warn when more than the threshold remains", () => {
      expect(isMonitorExpiringSoon(now + MONITOR_EXPIRY_WARNING_MS + 1, now)).toBe(false);
    });

    it("warns once exactly the threshold remains", () => {
      expect(isMonitorExpiringSoon(now + MONITOR_EXPIRY_WARNING_MS, now)).toBe(true);
    });

    it("warns once just under the threshold remains", () => {
      expect(isMonitorExpiringSoon(now + MONITOR_EXPIRY_WARNING_MS - 1, now)).toBe(true);
    });

    it("warns once already expired", () => {
      expect(isMonitorExpiringSoon(now - 1, now)).toBe(true);
    });

    it("never warns when there is no expiry at all", () => {
      expect(isMonitorExpiringSoon(null, now)).toBe(false);
    });
  });

  describe("the Monitor service token section", () => {
    it("says credentials are needed first, and offers no setup button, without them", async () => {
      stubFetch({ initiallyConfigured: false });
      mount();

      await waitFor(() =>
        expect(screen.getByText(/Add Cloudflare credentials above before setting up/)).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: /Set up monitor token/ })).toBeNull();
    });

    it("offers to set it up once credentials exist and it is not configured yet", async () => {
      stubFetch({ initiallyConfigured: true });
      mount();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Set up monitor token" })).toBeTruthy(),
      );

      fireEvent.click(screen.getByRole("button", { name: "Set up monitor token" }));

      await waitFor(() => expect(screen.getByText("monitor-client-1")).toBeTruthy());
      expect(screen.queryByRole("button", { name: "Set up monitor token" })).toBeNull();
      expect(screen.getByRole("button", { name: "Rotate secret" })).toBeTruthy();
    });

    it("shows the expiry and no warning when it is far away", async () => {
      const farFuture = Date.now() + MONITOR_EXPIRY_WARNING_MS * 10;
      stubFetch({
        initiallyConfigured: true,
        monitor: {
          configured: true,
          clientId: "monitor-client-1",
          policyId: "monitor-policy-1",
          expiresAt: farFuture,
        },
      });
      mount();

      await waitFor(() => expect(screen.getByText("monitor-client-1")).toBeTruthy());
      expect(screen.queryByText(/will start failing at once/)).toBeNull();
    });

    it("warns ahead of an expiry inside the threshold", async () => {
      const soon = Date.now() + MONITOR_EXPIRY_WARNING_MS - 60_000;
      stubFetch({
        initiallyConfigured: true,
        monitor: {
          configured: true,
          clientId: "monitor-client-1",
          policyId: "monitor-policy-1",
          expiresAt: soon,
        },
      });
      mount();

      await waitFor(() => expect(screen.getByText(/will start failing at once/)).toBeTruthy());
    });

    it("rotates through ConfirmDialog and shows the new expiry afterwards", async () => {
      const originalExpiry = Date.now() + MONITOR_EXPIRY_WARNING_MS * 2;
      const rotatedExpiry = originalExpiry + 86_400_000;
      stubFetch({
        initiallyConfigured: true,
        monitor: {
          configured: true,
          clientId: "monitor-client-1",
          policyId: "monitor-policy-1",
          expiresAt: originalExpiry,
        },
        monitorRotatePost: () =>
          json(200, {
            configured: true,
            clientId: "monitor-client-2",
            policyId: "monitor-policy-1",
            expiresAt: rotatedExpiry,
          }),
      });
      mount();

      await waitFor(() => expect(screen.getByText("monitor-client-1")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Rotate" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(screen.getByText("monitor-client-2")).toBeTruthy());
    });

    it("never renders the monitor secret, the API token, or the tunnel token anywhere in the DOM", async () => {
      stubFetch({
        initiallyConfigured: true,
        monitor: {
          configured: true,
          clientId: "monitor-client-1",
          policyId: "monitor-policy-1",
          expiresAt: Date.now() + MONITOR_EXPIRY_WARNING_MS * 10,
        },
        tunnel: { provisioned: true, name: "homestead", appId: "app-cf-1", runningJobId: null },
      });
      mount();

      await waitFor(() => expect(screen.getByText("monitor-client-1")).toBeTruthy());
      await waitFor(() => expect(screen.getByText("homestead")).toBeTruthy());
      // `MonitorAccessStatus`, `CloudflareStatus` and `TunnelStatus` structurally never
      // carry a secret field at all (see each type's own doc comment) — asserted here
      // directly against the rendered DOM, not assumed from the type alone. Only the
      // hint (`wxyz`, from `CONFIGURED` above) may appear; the full token must not.
      expect(document.body.textContent).not.toContain(TOKEN);
      expect(document.body.textContent).not.toContain("tunnel-token");
    });
  });

  describe("the Access sign-in section", () => {
    it("says sign-in is inert when nothing is configured", async () => {
      stubFetch({ initiallyConfigured: false, access: { configured: false } });
      mount();

      await waitFor(() => expect(screen.getByText(/is inert/)).toBeTruthy());
    });

    it("says the database when Access resolves from Homestead's own exposure", async () => {
      stubFetch({
        initiallyConfigured: false,
        access: { configured: true, teamDomain: "acme", aud: "aud-1", source: "database" },
      });
      mount();

      await waitFor(() => expect(screen.getByText("acme")).toBeTruthy());
      expect(screen.getByText(/database/)).toBeTruthy();
    });

    it("says the environment when Access resolves from HOMESTEAD_ACCESS_*", async () => {
      stubFetch({
        initiallyConfigured: false,
        access: { configured: true, teamDomain: "acme", aud: "aud-1", source: "environment" },
      });
      mount();

      await waitFor(() => expect(screen.getByText("acme")).toBeTruthy());
      expect(screen.getByText(/environment/)).toBeTruthy();
    });
  });
});
