// @vitest-environment jsdom
import type {
  AppComposeServicesStatus,
  AppExposureStatus,
  CloudflareZone,
  TunnelStatus,
} from "@shared/cloudflare.js";
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

const APP = {
  id: "app-1",
  displayName: "Jellyfin",
  systemKind: null as "self" | null,
  directory: "jellyfin",
};
const ZONES: CloudflareZone[] = [{ id: "z1", name: "example.com" }];
const NOT_PROVISIONED: TunnelStatus = { provisioned: false, runningJobId: null };
const PROVISIONED: TunnelStatus = {
  provisioned: true,
  name: "homestead",
  appId: "cfd-app",
  runningJobId: null,
};
const NOT_EXPOSED: AppExposureStatus = { exposed: false, runningJobId: null };
/** The common case: exactly one service publishing exactly one port, so both should be
 * preselected the instant this resolves — see `ExposureTab.tsx`'s own doc comment on the
 * preselect effect. */
const ONE_SERVICE_ONE_PORT: AppComposeServicesStatus = {
  valid: true,
  services: [{ name: "app", publishedPorts: [8096] }],
};

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
  composeServices?: AppComposeServicesStatus;
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
    if (url === `/api/apps/${APP.id}/expose/services` && method === "GET") {
      return json(200, opts.composeServices ?? ONE_SERVICE_ONE_PORT);
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

/** Fills the hostname and zone, then waits for the port picker to preselect — the default
 * stub (`ONE_SERVICE_ONE_PORT`) is exactly the "one click" case `ExposureTab.tsx`'s own
 * doc comment describes, so nothing here has to drive that field by hand. */
async function fillExposeForm() {
  fireEvent.change(screen.getByLabelText(/Hostname/), {
    target: { value: "jellyfin" },
  });
  // The zone `<select>` only renders once `zones.data` resolves — the same "always await
  // before interacting" rule the other tests in this file already follow for it. Without
  // this, firing straight to the next line races the mocked fetch's own microtasks.
  await waitFor(() => expect(screen.getByLabelText(/Zone/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText(/Zone/), { target: { value: "z1" } });
  await waitFor(() =>
    expect((screen.getByLabelText(/Port/) as HTMLSelectElement).value).toBe("8096"),
  );
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

  it("states the shared-policy scope where the admin is making the decision, not only in a doc", async () => {
    // §6's own property, restated in the form itself: exposing an app admits every
    // Homestead user, including a viewer scoped to entirely different apps.
    stubFetch({ tunnel: PROVISIONED });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
    expect(screen.getByText(/every enabled Homestead user/)).toBeTruthy();
    expect(screen.getByText(/scoped to entirely different apps/)).toBeTruthy();
  });

  it("no longer offers an Access policy id field — both policies exist from setup", async () => {
    stubFetch({ tunnel: PROVISIONED });
    mount();

    await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
    expect(screen.queryByLabelText(/Access policy/i)).toBeNull();
  });

  describe("port picker", () => {
    it("preselects the port when exactly one is published across every service", async () => {
      stubFetch({ tunnel: PROVISIONED, composeServices: ONE_SERVICE_ONE_PORT });
      mount();

      await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
      await waitFor(() =>
        expect((screen.getByLabelText(/Port/) as HTMLSelectElement).value).toBe("8096"),
      );
    });

    it("lists every published port across every service, each labelled with its service, leaving the choice to the admin", async () => {
      stubFetch({
        tunnel: PROVISIONED,
        composeServices: {
          valid: true,
          services: [
            { name: "web", publishedPorts: [8080] },
            { name: "sonarr", publishedPorts: [8989] },
          ],
        },
      });
      mount();

      await waitFor(() => expect(screen.getByLabelText(/Port/)).toBeTruthy());
      const select = screen.getByLabelText(/Port/) as HTMLSelectElement;
      expect(select.value).toBe("");
      const options = Array.from(select.options).map((o) => ({
        value: o.value,
        text: o.textContent,
      }));
      expect(options).toContainEqual({ value: "8080", text: "8080 — web" });
      expect(options).toContainEqual({ value: "8989", text: "8989 — sonarr" });
    });

    it("flattens every published port from every service into the one list, including a service that publishes more than one", async () => {
      stubFetch({
        tunnel: PROVISIONED,
        composeServices: {
          valid: true,
          services: [{ name: "web", publishedPorts: [8080, 8443] }],
        },
      });
      mount();

      await waitFor(() => expect(screen.getByLabelText(/Port/)).toBeTruthy());
      const select = screen.getByLabelText(/Port/) as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toEqual(expect.arrayContaining(["8080", "8443"]));
    });

    it("goes straight to manual entry, with no dropdown at all, when the app publishes no ports (host networking)", async () => {
      // The case this whole feature exists for: `network_mode: host` (Homestead's own
      // shape, `systemKind: "self"`) declares no `ports:` at all, so every service comes
      // back with `publishedPorts: []` and there is nothing to list.
      stubFetch({
        tunnel: PROVISIONED,
        composeServices: { valid: true, services: [{ name: "homestead", publishedPorts: [] }] },
      });
      mount();

      await waitFor(() => expect(screen.getByLabelText(/Port/)).toBeTruthy());
      const port = screen.getByLabelText(/Port/);
      expect(port.tagName).toBe("INPUT");
      // Nothing to switch back to — the "choose from the list" escape hatch only makes
      // sense once a list actually exists.
      expect(screen.queryByRole("button", { name: /Choose from the list/ })).toBeNull();
    });

    it("switches to manual entry from the dropdown's own 'Type a port…' option, and back again", async () => {
      stubFetch({
        tunnel: PROVISIONED,
        composeServices: {
          valid: true,
          services: [{ name: "web", publishedPorts: [8080] }],
        },
      });
      mount();

      await waitFor(() =>
        expect((screen.getByLabelText(/Port/) as HTMLSelectElement).value).toBe("8080"),
      );
      fireEvent.change(screen.getByLabelText(/Port/), { target: { value: "__type_a_port__" } });

      await waitFor(() => expect(screen.getByLabelText(/Port/).tagName).toBe("INPUT"));
      // Switching to manual entry clears the preselected value — no stale port left behind
      // for the two controls to disagree about.
      expect((screen.getByLabelText(/Port/) as HTMLInputElement).value).toBe("");

      fireEvent.click(screen.getByRole("button", { name: /Choose from the list/ }));
      await waitFor(() => expect(screen.getByLabelText(/Port/).tagName).toBe("SELECT"));
      expect((screen.getByLabelText(/Port/) as HTMLSelectElement).value).toBe("");
    });

    it("accepts a typed port that is not published, and shows a non-blocking note rather than a refusal", async () => {
      stubFetch({
        tunnel: PROVISIONED,
        composeServices: { valid: true, services: [{ name: "homestead", publishedPorts: [] }] },
      });
      mount();

      await waitFor(() => expect(screen.getByLabelText(/Port/)).toBeTruthy());
      fireEvent.change(screen.getByLabelText(/Port/), { target: { value: "9090" } });

      await waitFor(() => expect(screen.getByText(/No service publishes port 9090/)).toBeTruthy());
      // A note, not an error: nothing here uses `role="alert"`.
      expect(screen.getByText(/No service publishes port 9090/).getAttribute("role")).toBeNull();
    });

    it("shows the invalid-compose message, but still offers manual entry rather than blocking the form entirely", async () => {
      stubFetch({
        tunnel: PROVISIONED,
        composeServices: { valid: false, message: "compose file is invalid" },
      });
      mount();

      await waitFor(() => expect(screen.getByText(/compose file is invalid/)).toBeTruthy());
      expect(screen.getByLabelText(/Port/).tagName).toBe("INPUT");
    });
  });

  describe("submission carries whichever port is actually shown as selected", () => {
    it("submits the port chosen from the dropdown, and no serviceName field at all", async () => {
      const fetchMock = stubFetch({
        tunnel: PROVISIONED,
        composeServices: {
          valid: true,
          services: [
            { name: "web", publishedPorts: [8080] },
            { name: "sonarr", publishedPorts: [8989] },
          ],
        },
      });
      mount();

      await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
      fireEvent.change(screen.getByLabelText(/Hostname/), {
        target: { value: "jellyfin" },
      });
      await waitFor(() => expect(screen.getByLabelText(/Zone/)).toBeTruthy());
      fireEvent.change(screen.getByLabelText(/Zone/), { target: { value: "z1" } });
      await waitFor(() => expect(screen.getByLabelText(/Port/)).toBeTruthy());
      fireEvent.change(screen.getByLabelText(/Port/), { target: { value: "8989" } });

      fireEvent.click(screen.getByRole("button", { name: "Expose" }));
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

      const call = fetchMock.mock.calls.find(
        (c) => c[0] === `/api/apps/${APP.id}/expose` && (c[1] as RequestInit)?.method === "POST",
      );
      const body = JSON.parse(String((call?.[1] as RequestInit)?.body));
      expect(body).toEqual({ hostname: "jellyfin.example.com", zoneId: "z1", port: 8989 });
      expect(body.serviceName).toBeUndefined();
    });

    it("submits the manually typed port for a host-networked app, still with no serviceName field", async () => {
      const fetchMock = stubFetch({
        tunnel: PROVISIONED,
        composeServices: { valid: true, services: [{ name: "homestead", publishedPorts: [] }] },
      });
      mount();

      await waitFor(() => expect(screen.getByLabelText(/Hostname/)).toBeTruthy());
      fireEvent.change(screen.getByLabelText(/Hostname/), {
        target: { value: "homestead" },
      });
      await waitFor(() => expect(screen.getByLabelText(/Zone/)).toBeTruthy());
      fireEvent.change(screen.getByLabelText(/Zone/), { target: { value: "z1" } });
      await waitFor(() => expect(screen.getByLabelText(/Port/)).toBeTruthy());
      fireEvent.change(screen.getByLabelText(/Port/), { target: { value: "3000" } });

      fireEvent.click(screen.getByRole("button", { name: "Expose" }));
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

      const call = fetchMock.mock.calls.find(
        (c) => c[0] === `/api/apps/${APP.id}/expose` && (c[1] as RequestInit)?.method === "POST",
      );
      const body = JSON.parse(String((call?.[1] as RequestInit)?.body));
      expect(body).toEqual({ hostname: "homestead.example.com", zoneId: "z1", port: 3000 });
    });
  });

  describe("the hostname field composes with the selected zone (measured defect)", () => {
    // The actual bug this locks in: a bare subdomain typed with no dot used to be sent to
    // Cloudflare completely unqualified, because the "Hostname" field and the "Zone"
    // dropdown had no connection to each other at all. `create-dns-record` tolerated it
    // silently (Cloudflare's DNS API accepts a relative name within a zone); the very
    // next step, `create-access-app`, does not, and rejected it as not belonging to any
    // zone — several steps into a job that had already created (and had to roll back) a
    // real DNS record. See `composeHostname`'s own doc comment in ExposureTab.tsx.
    it("composes a bare subdomain with the selected zone's domain, not the raw input", async () => {
      const fetchMock = stubFetch({ tunnel: PROVISIONED });
      mount();
      fireEvent.change(await screen.findByLabelText(/Hostname/), {
        target: { value: "homestead" },
      });
      fireEvent.change(await screen.findByLabelText(/Zone/), { target: { value: "z1" } });
      await waitFor(() =>
        expect((screen.getByLabelText(/Port/) as HTMLSelectElement).value).toBe("8096"),
      );

      fireEvent.click(screen.getByRole("button", { name: "Expose" }));
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

      const call = fetchMock.mock.calls.find(
        (c) => c[0] === `/api/apps/${APP.id}/expose` && (c[1] as RequestInit)?.method === "POST",
      );
      const body = JSON.parse(String((call?.[1] as RequestInit)?.body));
      expect(body).toEqual({ hostname: "homestead.example.com", zoneId: "z1", port: 8096 });
    });

    it("exposes at the zone's own root domain when the subdomain is left blank", async () => {
      const fetchMock = stubFetch({ tunnel: PROVISIONED });
      mount();
      // Cleared explicitly — the field prefills from the app's directory (below), so
      // "left blank" means the admin emptied it, not that it started that way.
      fireEvent.change(await screen.findByLabelText(/Hostname/), { target: { value: "" } });
      fireEvent.change(await screen.findByLabelText(/Zone/), { target: { value: "z1" } });
      await waitFor(() =>
        expect((screen.getByLabelText(/Port/) as HTMLSelectElement).value).toBe("8096"),
      );

      fireEvent.click(screen.getByRole("button", { name: "Expose" }));
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

      const call = fetchMock.mock.calls.find(
        (c) => c[0] === `/api/apps/${APP.id}/expose` && (c[1] as RequestInit)?.method === "POST",
      );
      const body = JSON.parse(String((call?.[1] as RequestInit)?.body));
      expect(body).toEqual({ hostname: "example.com", zoneId: "z1", port: 8096 });
    });
  });

  describe("the hostname box only ever holds one DNS label", () => {
    it("prefills the hostname from the app's own directory name", async () => {
      stubFetch({ tunnel: PROVISIONED });
      mount();

      const input = (await screen.findByLabelText(/Hostname/)) as HTMLInputElement;
      expect(input.value).toBe(APP.directory);
    });

    it("strips characters a DNS label cannot contain as the admin types, rather than at submit time", async () => {
      stubFetch({ tunnel: PROVISIONED });
      mount();

      const input = (await screen.findByLabelText(/Hostname/)) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "My App! 01.example.com" } });
      expect(input.value).toBe("myapp01examplecom");
    });
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
    await fillExposeForm();
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
    await fillExposeForm();
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

  it("renders the in-progress view, not the steady exposed view, for a reload mid-expose", async () => {
    // Phase 2F whole-branch review, F2: `splice-ingress` inserts the `exposures` row as
    // `provisioning` at step 1 of 5, so a tab that (re)mounts mid-sequence sees
    // `exposed: true, state: "provisioning"` for nearly the whole run. Before the fix
    // this rendered the steady-state view — no `JobOutput`, a Remove button offered, and
    // no way to see a failing sequence's "MANUAL CLEANUP REQUIRED" list.
    stubFetch({
      tunnel: PROVISIONED,
      exposure: {
        exposed: true,
        hostname: "jellyfin.example.com",
        state: "provisioning",
        accessAppId: null,
        accessAppAud: null,
        runningJobId: "job-mid-expose",
        driftFindings: [],
      },
    });
    mount();

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/job-mid-expose/stream");
    expect((screen.getByRole("button", { name: /Exposing/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Remove exposure" })).toBeNull();
    expect(screen.queryByText("jellyfin.example.com")).toBeNull();
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

    it("gives a replaced Access application its own, more urgent banner too", async () => {
      // Phase 2F whole-branch review, F3: a replaced Access application (new id, new
      // aud) is at least as urgent as a deleted one — the stale recorded aud breaks
      // this app's own Access sign-in checks.
      stubFetch({
        tunnel: PROVISIONED,
        exposure: {
          ...READY_EXPOSURE,
          state: "drifted",
          driftFindings: [
            {
              kind: "access_app_replaced",
              message:
                "The Access application protecting jellyfin.example.com has been replaced in Cloudflare (a new id and audience tag) — the recorded audience is stale and sign-in checks against it will fail.",
            },
          ],
        },
      });
      mount();

      await waitFor(() => expect(screen.getByText(/was replaced/)).toBeTruthy());
      const urgent = screen.getByText(/was replaced/).closest('[role="alert"]');
      expect(urgent?.textContent).toContain("sign-in checks against it will fail");
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
