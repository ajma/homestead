// @vitest-environment jsdom
import type { CloudflareStatus, TunnelStatus } from "@shared/cloudflare.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StepCloudflare } from "@web/routes/setup/StepCloudflare";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource — `StepCloudflare` opens one, via the `JobOutput` it renders,
// the moment a provision job is being watched. Same double as `CloudflarePanel.test.tsx`,
// which this step's provisioning UI is lifted from.
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
const NOT_PROVISIONED: TunnelStatus = { provisioned: false, runningJobId: null };

/** Same shape as `CloudflarePanel.test.tsx`'s own `stubFetch`: `configured` is mutable so
 * a PUT in one call changes what the next GET answers, the way the real server would
 * after a save. */
function stubFetch(
  opts: {
    initiallyConfigured?: boolean;
    put?: () => Response;
    tunnel?: TunnelStatus;
    provisionPost?: () => Response | Promise<Response>;
  } = {},
) {
  let configured = opts.initiallyConfigured ?? false;
  const tunnel = opts.tunnel ?? NOT_PROVISIONED;
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
    if (url === "/api/cloudflare/tunnel" && method === "GET") {
      return json(200, tunnel);
    }
    if (url === "/api/cloudflare/tunnel" && method === "POST") {
      if (opts.provisionPost) return opts.provisionPost();
      return json(202, { jobId: "job-1" });
    }
    throw new Error(`unhandled request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(
  props: Partial<{
    pending: boolean;
    onComplete: () => void;
    onFail: (message: string) => void;
    skippable: boolean;
  }> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onComplete = props.onComplete ?? vi.fn();
  const onFail = props.onFail ?? vi.fn();
  render(
    <QueryClientProvider client={client}>
      <StepCloudflare
        state={{ completedSteps: ["admin", "host", "import"], completedAt: null }}
        pending={props.pending ?? false}
        onComplete={onComplete}
        onFail={onFail}
        skippable={props.skippable ?? true}
      />
    </QueryClientProvider>,
  );
  return { onComplete, onFail };
}

function fillForm() {
  fireEvent.change(screen.getByLabelText(/Account ID/), { target: { value: "acct-1" } });
  fireEvent.change(screen.getByLabelText(/API token/), {
    target: { value: "cfat_totally-a-real-token-value" },
  });
}

describe("StepCloudflare", () => {
  it("shows the credentials form when Cloudflare is not configured", async () => {
    stubFetch();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    expect(screen.getByLabelText(/API token/)).toBeTruthy();
  });

  it("is skippable — spec §6/§10 promise Cloudflare can be finished later from Settings", async () => {
    stubFetch();
    mount({ skippable: true });
    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Skip/ })).toBeTruthy();
  });

  it("does not render Skip when the step is not skippable", async () => {
    stubFetch();
    mount({ skippable: false });
    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
  });

  it("completes the wizard on Skip without ever having entered credentials", async () => {
    // The one property this step must never lose: a household with no Cloudflare account
    // can still finish setup.
    stubFetch();
    const { onComplete } = mount({ skippable: true });
    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Continue also advances the wizard, with or without credentials", async () => {
    stubFetch();
    const { onComplete } = mount();
    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("saves credentials, clears the form, and offers to provision the tunnel next", async () => {
    stubFetch();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Save credentials/ }));

    await waitFor(() => expect(screen.getByText(/credentials are saved/)).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Provision tunnel" })).toBeTruthy(),
    );
    // The token field is gone entirely once configured — no lingering plaintext input.
    expect(screen.queryByLabelText(/API token/)).toBeNull();
  });

  it("reports a save failure through onFail as well as inline, and keeps what was typed", async () => {
    stubFetch({
      put: () => json(422, { error: "verification_failed", fault: "auth" }),
    });
    const { onFail } = mount();
    await waitFor(() => expect(screen.getByLabelText(/Account ID/)).toBeTruthy());
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Save credentials/ }));

    await waitFor(() => expect(onFail).toHaveBeenCalled());
    expect(screen.getByRole("alert").textContent).toMatch(/rejected/i);
    // Unlike a success, the account id typed a moment ago is still there to fix rather
    // than retype — the same behaviour `CloudflarePanel`'s own save failure path keeps.
    expect((screen.getByLabelText(/Account ID/) as HTMLInputElement).value).toBe("acct-1");
  });

  it("starts a provision job and streams its output once credentials are configured", async () => {
    stubFetch({ initiallyConfigured: true });
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Provision tunnel" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Provision tunnel" }));

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/job-1/stream");
  });

  it("keeps Skip and Continue disabled while a provision job is in flight", async () => {
    // A click on Skip or Continue while the only record of an in-progress provision is
    // this step's own transcript must not abandon that record with nothing on screen
    // pointing back at it.
    stubFetch({ initiallyConfigured: true });
    const { onComplete } = mount({ skippable: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Provision tunnel" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Provision tunnel" }));

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect((screen.getByRole("button", { name: /Skip/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("shows the already-provisioned tunnel rather than offering to provision again", async () => {
    stubFetch({
      initiallyConfigured: true,
      tunnel: { provisioned: true, name: "homestead", appId: null, runningJobId: null },
    });
    mount();
    await waitFor(() => expect(screen.getByText(/is provisioned/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Provision tunnel" })).toBeNull();
  });
});
