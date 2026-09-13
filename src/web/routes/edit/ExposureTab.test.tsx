// @vitest-environment jsdom
import type { AppExposureStatus, CloudflareZone, TunnelStatus } from "@shared/cloudflare.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExposurePanel } from "@web/routes/edit/ExposureTab";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource — same double `CloudflarePanel.test.tsx` and `JobOutput.test.tsx`
// use, needed the moment this tab renders `JobOutput` for a running expose job.
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

const APP = { id: "app-1", displayName: "Jellyfin", systemKind: null as "self" | null };
const ZONES: CloudflareZone[] = [{ id: "z1", name: "example.com" }];
const NOT_PROVISIONED: TunnelStatus = { provisioned: false, runningJobId: null };
const PROVISIONED: TunnelStatus = {
  provisioned: true,
  name: "homestead",
  appId: "cfd-app",
  runningJobId: null,
};
const NOT_EXPOSED: AppExposureStatus = { exposed: false, runningJobId: null };

function mount(app: typeof APP = APP) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ExposurePanel app={app} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubFetch(opts: {
  tunnel?: TunnelStatus;
  exposure?: AppExposureStatus;
  zones?: CloudflareZone[];
  exposePost?: () => Response | Promise<Response>;
  deprovisionDelete?: () => Response | Promise<Response>;
  reconcilePost?: () => Response | Promise<Response>;
  /** What `GET /api/apps/:id/expose` answers AFTER a successful reconcile POST — the
   * refetch `handleCheckDrift` triggers. Defaults to the same `exposure` fixture the rest
   * of this stub answers with, since most tests don't care about this refetch at all. */
  exposureAfterReconcile?: AppExposureStatus;
}) {
  let exposure = opts.exposure ?? NOT_EXPOSED;
  const tunnel = opts.tunnel ?? NOT_PROVISIONED;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/cloudflare/tunnel" && method === "GET") {
      return json(200, tunnel);
    }
    if (url === "/api/cloudflare/zones" && method === "GET") {
      return json(200, opts.zones ?? ZONES);
    }
    if (url === `/api/apps/${APP.id}/expose` && method === "GET") {
      return json(200, exposure);
    }
    if (url === `/api/apps/${APP.id}/expose` && method === "POST") {
      if (opts.exposePost) return opts.exposePost();
      return json(202, { jobId: "job-1" });
    }
    if (url === `/api/apps/${APP.id}/expose` && method === "DELETE") {
      if (opts.deprovisionDelete) return opts.deprovisionDelete();
      exposure = NOT_EXPOSED;
      return json(200, { ok: true });
    }
    if (url === "/api/cloudflare/reconcile" && method === "POST") {
      if (opts.reconcilePost) return opts.reconcilePost();
      if (opts.exposureAfterReconcile) exposure = opts.exposureAfterReconcile;
      return json(200, { checked: 1, drifted: opts.exposureAfterReconcile ? 1 : 0 });
    }
    throw new Error(`unhandled request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fillExposeForm() {
  fireEvent.change(screen.getByLabelText(/Hostname/), {
    target: { value: "jellyfin.example.com" },
  });
  fireEvent.change(screen.getByLabelText(/Zone/), { target: { value: "z1" } });
  fireEvent.change(screen.getByLabelText(/Internal service URL/), {
    target: { value: "http://localhost:8096" },
  });
  fireEvent.change(screen.getByLabelText(/Access policy id/), {
    target: { value: "human-policy-1" },
  });
}

describe("ExposurePanel", () => {
  it("explains there is no tunnel and links to Settings, offering no Expose button", async () => {
    // Binding check: offering Expose here can only ever fail with a confusing
    // Cloudflare error — the same call 2C made for Provision.
    stubFetch({ tunnel: NOT_PROVISIONED });
    mount();

    await waitFor(() => expect(screen.getByText(/No tunnel is provisioned/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Expose/ })).toBeNull();
    const link = screen.getByRole("link", { name: /Settings/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/settings");
  });

  it("offers a hostname field, a zone picker and an Expose button once a tunnel exists", async () => {
    stubFetch({ tunnel: PROVISIONED });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText("example.com")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Expose" })).toBeTruthy();
  });

  it("shows the team domain field only for the app marked self", async () => {
    stubFetch({ tunnel: PROVISIONED });
    mount({ ...APP, systemKind: "self" });

    await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
    expect(screen.getByLabelText(/team domain/i)).toBeTruthy();
  });

  it("does not show the team domain field for an ordinary app", async () => {
    stubFetch({ tunnel: PROVISIONED });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
    expect(screen.queryByLabelText(/team domain/i)).toBeNull();
  });

  it("disables Expose immediately, then streams the job's output while it runs", async () => {
    let resolvePost: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolvePost = resolve;
    });
    stubFetch({
      tunnel: PROVISIONED,
      exposePost: async () => {
        await gate;
        return json(202, { jobId: "job-1" });
      },
    });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
    fillExposeForm();
    fireEvent.click(screen.getByRole("button", { name: "Expose" }));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Exposing/ }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );

    resolvePost?.();

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/job-1/stream");

    act(() => {
      FakeEventSource.instances[0]?.emit("output", {
        text: "creating dns record…",
        stream: "stdout",
      });
    });
    await waitFor(() => expect(screen.getByText(/creating dns record…/)).toBeTruthy());
    expect((screen.getByRole("button", { name: /Exposing/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows what was rolled back and, prominently, what was not, after a failed expose", async () => {
    stubFetch({ tunnel: PROVISIONED });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
    fillExposeForm();
    fireEvent.click(screen.getByRole("button", { name: "Expose" }));
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    const output = [
      "!!! MANUAL CLEANUP REQUIRED !!!",
      "These steps could NOT be rolled back — check these resources by hand:",
      "  - create-access-app: delete failed",
      "",
      'FAILED at step "create-probe": boom',
    ].join("\n");

    act(() => {
      FakeEventSource.instances[0]?.emit("output", { text: output, stream: "stdout" });
      FakeEventSource.instances[0]?.emit("done", { status: "failed", exitCode: null });
    });

    await waitFor(() => expect(screen.getByText(/Exposing this app failed/)).toBeTruthy());
    const banner = screen.getByText(/Exposing this app failed/).closest('[role="alert"]');
    expect(banner?.textContent).toContain("MANUAL CLEANUP REQUIRED");
    const transcript = screen.getByTestId("job-output");
    expect(transcript.textContent).toContain("MANUAL CLEANUP REQUIRED");
    expect(transcript.textContent).toContain("create-access-app: delete failed");
    // Expose is offered again — nothing was left exposed.
    await waitFor(() => expect(screen.getByRole("button", { name: "Expose" })).toBeTruthy());
  });

  it("adopts an expose job already running when the tab mounts", async () => {
    stubFetch({
      tunnel: PROVISIONED,
      exposure: { exposed: false, runningJobId: "job-99" },
    });
    mount();

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/job-99/stream");
    expect((screen.getByRole("button", { name: /Exposing/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Expose" })).toBeNull();
  });

  it("shows the hostname, a link to it, the Access application and a Remove button once exposed", async () => {
    stubFetch({
      tunnel: PROVISIONED,
      exposure: {
        exposed: true,
        hostname: "jellyfin.example.com",
        state: "ready",
        accessAppId: "access-1",
        accessAppAud: "aud-value",
        runningJobId: null,
        driftFindings: [],
      },
    });
    mount();

    await waitFor(() => expect(screen.getByText("jellyfin.example.com")).toBeTruthy());
    const link = screen.getByRole("link", { name: "jellyfin.example.com" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://jellyfin.example.com");
    expect(screen.getByText("aud-value")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove exposure" })).toBeTruthy();
    // Nothing left to expose.
    expect(screen.queryByRole("button", { name: "Expose" })).toBeNull();
  });

  it("removes the exposure through ConfirmDialog, not a second confirmation UI", async () => {
    stubFetch({
      tunnel: PROVISIONED,
      exposure: {
        exposed: true,
        hostname: "jellyfin.example.com",
        state: "ready",
        accessAppId: "access-1",
        accessAppAud: "aud-value",
        runningJobId: null,
        driftFindings: [],
      },
    });
    mount();

    await waitFor(() => expect(screen.getByText("jellyfin.example.com")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove exposure" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The exposure is gone and the tunnel is still provisioned — the form to expose
    // again is offered, not the "no tunnel" message.
    await waitFor(() => expect(screen.getByRole("button", { name: "Expose" })).toBeTruthy());
  });

  it("shows the actual refusal reason and what to do about it when removal fails, and keeps the dialog open", async () => {
    stubFetch({
      tunnel: PROVISIONED,
      exposure: {
        exposed: true,
        hostname: "jellyfin.example.com",
        state: "ready",
        accessAppId: "access-1",
        accessAppAud: "aud-value",
        runningJobId: null,
        driftFindings: [],
      },
      deprovisionDelete: () =>
        json(500, {
          error: "deprovision_incomplete",
          failures: [
            {
              resource: "access-app",
              message:
                "refusing to remove the Access application: the hostname is still fully " +
                "routed (its DNS record predates this exposure and is still present in " +
                "Cloudflare) — remove it in Cloudflare by hand, then retry this call",
            },
          ],
        }),
    });
    mount();

    await waitFor(() => expect(screen.getByText("jellyfin.example.com")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove exposure" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // Stays open — `ConfirmDialog`'s own contract for a rejecting `onConfirm` — and shows
    // the real reason plus the concrete next step, not a generic failure line.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText(/access-app/)).toBeTruthy();
    expect(screen.getByText(/remove it in Cloudflare by hand, then retry this call/)).toBeTruthy();
  });

  describe("drift (2F Task 6)", () => {
    const READY_EXPOSURE: AppExposureStatus = {
      exposed: true,
      hostname: "jellyfin.example.com",
      state: "ready",
      accessAppId: "access-1",
      accessAppAud: "aud-value",
      runningJobId: null,
      driftFindings: [],
    };

    it("shows no drift banner at all when the exposure is clean", async () => {
      stubFetch({ tunnel: PROVISIONED, exposure: READY_EXPOSURE });
      mount();

      await waitFor(() => expect(screen.getByText("jellyfin.example.com")).toBeTruthy());
      expect(screen.queryByText(/drifted/i)).toBeNull();
      // The trigger is still offered even when nothing is currently wrong — this is the
      // on-demand version of a periodic check, not a repair button that only appears
      // once something breaks.
      expect(screen.getByRole("button", { name: "Check for drift" })).toBeTruthy();
    });

    it("shows the drift banner listing every finding when the exposure has drifted", async () => {
      stubFetch({
        tunnel: PROVISIONED,
        exposure: {
          ...READY_EXPOSURE,
          state: "drifted",
          driftFindings: [
            {
              kind: "ingress_rule_missing",
              message: "The tunnel's ingress config no longer has a rule for jellyfin.example.com.",
            },
            {
              kind: "dns_record_missing",
              message: "The DNS record for jellyfin.example.com is missing.",
            },
          ],
        },
      });
      mount();

      await waitFor(() => expect(screen.getByText(/has drifted/)).toBeTruthy());
      expect(screen.getByText(/no longer has a rule/)).toBeTruthy();
      expect(screen.getByText(/DNS record for jellyfin.example.com is missing/)).toBeTruthy();
    });

    it("gives a deleted Access application its own, more urgent banner — separate from the rest", async () => {
      // §6's own emphasis: this is the one finding that means the hostname is routed and
      // UNPROTECTED right now, not just recorded slightly wrong — it must read as more
      // than one row in a plain list.
      stubFetch({
        tunnel: PROVISIONED,
        exposure: {
          ...READY_EXPOSURE,
          state: "drifted",
          driftFindings: [
            {
              kind: "access_app_deleted",
              message:
                "The Access application protecting jellyfin.example.com has been deleted in Cloudflare — this hostname is still routed and no longer requires sign-in.",
            },
            {
              kind: "ingress_service_mismatch",
              message: "jellyfin.example.com is routed to something else.",
            },
          ],
        },
      });
      mount();

      await waitFor(() => expect(screen.getByText(/Not protected/)).toBeTruthy());
      const urgent = screen.getByText(/Not protected/).closest('[role="alert"]');
      expect(urgent?.textContent).toContain("no longer requires sign-in");
      // The other finding still shows, in its own, separate, less alarming banner.
      expect(screen.getByText(/routed to something else/)).toBeTruthy();
      expect(screen.getByText(/has drifted from what Cloudflare reports/)).toBeTruthy();
    });

    it("Check for drift calls the reconcile route, never a Cloudflare write, and refreshes this app's own status", async () => {
      const fetchMock = stubFetch({
        tunnel: PROVISIONED,
        exposure: READY_EXPOSURE,
        exposureAfterReconcile: {
          ...READY_EXPOSURE,
          state: "drifted",
          driftFindings: [{ kind: "dns_record_missing", message: "The DNS record is missing." }],
        },
      });
      mount();

      await waitFor(() => expect(screen.getByText("jellyfin.example.com")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Check for drift" }));

      await waitFor(() => expect(screen.getByText(/has drifted/)).toBeTruthy());
      const reconcileCall = fetchMock.mock.calls.find(
        (call) => call[0] === "/api/cloudflare/reconcile",
      );
      expect(reconcileCall).toBeTruthy();
      expect((reconcileCall?.[1] as RequestInit)?.method).toBe("POST");
    });

    it("shows an inline error, and stays clickable, when the drift check itself fails", async () => {
      stubFetch({
        tunnel: PROVISIONED,
        exposure: READY_EXPOSURE,
        reconcilePost: () => json(500, { error: "internal" }),
      });
      mount();

      await waitFor(() => expect(screen.getByText("jellyfin.example.com")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Check for drift" }));

      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not check/));
      expect(
        (screen.getByRole("button", { name: "Check for drift" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });
});
